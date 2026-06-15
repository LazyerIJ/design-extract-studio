import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateArtifacts, listArtifacts } from "./artifacts.mjs";
import { parseDesignSummary } from "./summary.mjs";
import { runCodexAnalysis } from "./runner.mjs";
import { runLayoutExtraction } from "./layout-step.mjs";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

function now() {
  return new Date().toISOString();
}

function publicJob(job, recentLog = "") {
  const output = structuredClone(job);
  delete output.cancelRequested;
  delete output.internal;
  output.recentLog = recentLog;
  return output;
}

export class JobManager extends EventEmitter {
  constructor({ config, store, runner }) {
    super();
    this.config = config;
    this.store = store;
    this.runner = runner;
    this.jobs = new Map();
    this.queue = [];
    this.active = new Map();
    this.stopping = false;
    this.setMaxListeners(200);
  }

  async initialize() {
    await this.store.initialize();
    const recovered = await this.store.loadAll();
    for (const job of recovered) {
      if (job.status === "running") {
        job.status = "failed";
        job.finishedAt = now();
        job.updatedAt = job.finishedAt;
        job.pid = null;
        job.progress = {
          percent: job.progress?.percent ?? 0,
          stage: "interrupted",
          message: "Server restarted while extraction was running",
        };
        job.error = {
          code: "INTERRUPTED",
          message: "Extraction was interrupted by a server restart",
        };
        await this.store.appendLog(
          job.id,
          `[server] ${job.error.message}`,
        );
        await this.store.save(job);
      }
      this.jobs.set(job.id, job);
      if (job.status === "queued") this.queue.push(job.id);
    }
    this.queue.sort((a, b) =>
      this.jobs.get(a).createdAt.localeCompare(this.jobs.get(b).createdAt),
    );
    queueMicrotask(() => void this.pump());
  }

  async create(input, retryOf = null) {
    const timestamp = now();
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
    const job = {
      id,
      url: input.url,
      options: input.options,
      status: "queued",
      progress: {
        percent: 0,
        stage: "queued",
        message: "Waiting for the extraction worker",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      pid: null,
      exitCode: null,
      signal: null,
      retryOf,
      error: null,
      integrity: null,
      summary: null,
      analysis: { status: this.config.enableCodexAnalysis ? "pending" : "disabled" },
      layout: {
        status:
          this.config.enableLayoutExtraction && input.options?.layout !== false
            ? "pending"
            : "disabled",
      },
      artifactCount: 0,
      cancelRequested: false,
    };
    await this.store.create(job);
    await this.store.appendLog(job.id, `[server] Job queued for ${job.url}`);
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emitJob(job, "snapshot");
    void this.pump();
    return await this.get(id);
  }

  async list({ status } = {}) {
    const jobs = [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs.map((job) => publicJob(job));
  }

  async get(id, includeLog = true) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const recentLog = includeLog ? await this.store.readLogTail(id) : "";
    return publicJob(job, recentLog);
  }

  async retry(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return await this.create(
      { url: job.url, options: structuredClone(job.options) },
      id,
    );
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return await this.get(id);

    job.cancelRequested = true;
    job.updatedAt = now();
    if (job.status === "queued") {
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      job.status = "cancelled";
      job.finishedAt = job.updatedAt;
      job.progress = {
        percent: job.progress.percent,
        stage: "cancelled",
        message: "Cancelled before extraction started",
      };
      await this.store.appendLog(id, "[server] Queued job cancelled");
      await this.store.save(job);
      this.emitJob(job, "snapshot");
    } else {
      job.progress = {
        ...job.progress,
        stage: "cancelling",
        message: "Stopping the extraction process",
      };
      await this.store.appendLog(id, "[server] Cancellation requested");
      await this.store.save(job);
      this.emitJob(job, "snapshot");
      this.active.get(id)?.cancel();
    }
    return await this.get(id);
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (!TERMINAL_STATUSES.has(job.status)) {
      const error = new Error("Only completed jobs can be removed");
      error.code = "JOB_NOT_REMOVABLE";
      error.statusCode = 409;
      throw error;
    }
    this.jobs.delete(id);
    await this.store.remove(id);
    this.emit(`job:${id}`, { type: "deleted", job: { id } });
    return true;
  }

  async artifacts(id) {
    if (!this.jobs.has(id)) return null;
    return await listArtifacts(this.store.artifactDir(id));
  }

  subscribe(id, listener) {
    const eventName = `job:${id}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  emitJob(job, type, data = {}) {
    const payload = { type, job: publicJob(job), ...data };
    this.emit(`job:${job.id}`, payload);
    this.emit("change", payload);
  }

  async log(job, line) {
    const safeLine = String(line).slice(0, 8192);
    await this.store.appendLog(job.id, safeLine);
    this.emitJob(job, "log", { line: safeLine });
  }

  async progress(job, percent, message, stage = "running") {
    if (job.status !== "running") return;
    const next = Math.max(job.progress.percent, Math.min(99, Math.round(percent)));
    job.progress = { percent: next, stage, message };
    job.updatedAt = now();
    await this.store.save(job);
    this.emitJob(job, "progress");
  }

  async pump() {
    if (this.stopping) return;
    while (
      this.active.size < this.config.maxConcurrentJobs &&
      this.queue.length > 0
    ) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      void this.execute(job);
    }
  }

  async execute(job) {
    let cancel = () => {};
    this.active.set(job.id, { cancel: () => cancel() });
    job.status = "running";
    job.startedAt = now();
    job.updatedAt = job.startedAt;
    job.progress = {
      percent: 3,
      stage: "starting",
      message: "Preparing designlang",
    };
    await this.store.save(job);
    await this.log(job, "[server] Extraction worker started");
    this.emitJob(job, "snapshot");

    const hooks = {
      artifactDir: this.store.artifactDir(job.id),
      onSpawn: async (pid, cancelFn) => {
        cancel = cancelFn;
        job.pid = pid ?? null;
        job.updatedAt = now();
        await this.store.save(job);
        this.emitJob(job, "snapshot");
        if (job.cancelRequested) cancelFn();
      },
      onLog: async (line) => await this.log(job, line),
      onProgress: async (percent, message) =>
        await this.progress(job, percent, message),
    };

    try {
      const result = await this.runner(job, hooks);
      job.exitCode = result.exitCode;
      job.signal = result.signal ?? null;
      job.pid = null;
      if (result.exitCode !== 0) {
        throw Object.assign(
          new Error(`designlang exited with code ${result.exitCode}`),
          { code: "EXTRACTION_FAILED" },
        );
      }

      await this.progress(job, 84, "Extracting responsive layout", "layout");
      job.layout = await runLayoutExtraction(job, this.config, hooks);
      if (job.layout.status === "failed") {
        await this.log(
          job,
          `[layout] Layout extraction failed: ${job.layout.error ?? "unknown error"}`,
        );
      }

      await this.progress(job, 88, "Validating generated artifacts", "validating");
      job.integrity = await validateArtifacts(hooks.artifactDir);
      job.artifactCount = job.integrity.fileCount;
      await this.log(
        job,
        `[verify] ${job.integrity.fileCount} files, JSON ${job.integrity.json.valid}/${job.integrity.json.count}, integrity ${job.integrity.ok ? "passed" : "warnings"}`,
      );

      await this.progress(job, 94, "Parsing design system summary", "summarizing");
      const names = await readdir(hooks.artifactDir);
      const summaryFile = names.find((name) =>
        name.endsWith("-design-language.md"),
      );
      if (summaryFile) {
        const markdown = await readFile(join(hooks.artifactDir, summaryFile), "utf8");
        job.summary = parseDesignSummary(markdown);
      }

      await this.progress(job, 97, "Optional analysis", "analysis");
      job.analysis = await runCodexAnalysis(job, this.config, hooks);
      if (job.analysis.status === "failed") {
        await this.log(
          job,
          `[codex] Optional analysis failed: ${job.analysis.error ?? "unknown error"}`,
        );
      }

      job.status = "succeeded";
      job.progress = {
        percent: 100,
        stage: "complete",
        message: job.integrity.ok
          ? "Extraction and validation complete"
          : "Extraction complete with integrity warnings",
      };
      await this.log(job, "[server] Job completed successfully");
    } catch (error) {
      job.pid = null;
      if (error.code === "JOB_CANCELLED" || job.cancelRequested) {
        job.status = "cancelled";
        job.progress = {
          percent: job.progress.percent,
          stage: "cancelled",
          message: "Extraction cancelled",
        };
        job.error = null;
        await this.log(job, "[server] Job cancelled");
      } else {
        job.status = "failed";
        job.progress = {
          percent: job.progress.percent,
          stage: "failed",
          message: "Extraction failed",
        };
        job.error = {
          code: error.code ?? "INTERNAL_ERROR",
          message: String(error.message ?? error).slice(0, 1000),
        };
        await this.log(job, `[error] ${job.error.message}`);
      }
    } finally {
      job.finishedAt = now();
      job.updatedAt = job.finishedAt;
      this.active.delete(job.id);
      await this.store.save(job);
      this.emitJob(job, "snapshot");
      void this.pump();
    }
  }

  async shutdown() {
    this.stopping = true;
    const running = [...this.active.keys()];
    for (const id of running) {
      const job = this.jobs.get(id);
      if (!job) continue;
      job.cancelRequested = true;
      job.error = {
        code: "SERVER_SHUTDOWN",
        message: "Server stopped while extraction was running",
      };
      this.active.get(id)?.cancel();
    }
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
