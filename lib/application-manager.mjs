import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import {
  analyzeApplyRequest,
  resolveProjectTarget,
} from "./project-analysis.mjs";
import {
  codexPreflight,
  runCodexAdaptation,
  safeInstallDesignSystem,
  verifyDesignSystem,
} from "./design-apply.mjs";
import { runProcess } from "./process-utils.mjs";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function now() {
  return new Date().toISOString();
}

function publicApplication(application, recentLog = "") {
  const output = structuredClone(application);
  delete output.cancelRequested;
  delete output.artifactRoot;
  output.recentLog = recentLog;
  return output;
}

function redact(text, replacements) {
  let output = String(text);
  for (const [needle, replacement] of replacements) {
    if (needle) output = output.split(needle).join(replacement);
  }
  return output.replace(
    /\b(?:AWS|OPENAI|ANTHROPIC|GITHUB|NPM)_[A-Z0-9_]*=\S+/g,
    "[redacted]",
  );
}

export class ApplicationManager extends EventEmitter {
  constructor({
    config,
    store,
    extractionManager,
    processRunner = runProcess,
  }) {
    super();
    this.config = config;
    this.store = store;
    this.extractionManager = extractionManager;
    this.processRunner = processRunner;
    this.applications = new Map();
    this.active = new Map();
    this.targetLocks = new Map();
    this.stopping = false;
    this.setMaxListeners(200);
  }

  async initialize() {
    await this.store.initialize();
    const recovered = await this.store.loadAll();
    for (const application of recovered) {
      if (!TERMINAL.has(application.status)) {
        application.status = "failed";
        application.finishedAt = now();
        application.updatedAt = application.finishedAt;
        application.error = {
          code: "INTERRUPTED",
          message: "Application was interrupted by a server restart",
        };
        application.progress = {
          percent: application.progress?.percent ?? 0,
          stage: "interrupted",
          message: application.error.message,
        };
        await this.store.appendLog(application.id, `[server] ${application.error.message}`);
        await this.store.save(application);
      }
      this.applications.set(application.id, application);
    }
  }

  async extraction(jobId) {
    const job = await this.extractionManager.get(jobId, false);
    if (!job || job.status !== "succeeded") {
      throw Object.assign(new Error("A succeeded extraction job is required"), {
        code: "EXTRACTION_NOT_READY",
        statusCode: 409,
      });
    }
    return {
      job,
      artifactRoot: this.extractionManager.store.artifactDir(jobId),
    };
  }

  async analyze(jobId, targetPath) {
    const { artifactRoot } = await this.extraction(jobId);
    return await analyzeApplyRequest({
      targetPath,
      artifactRoot,
      studioRoot: this.config.projectDir,
      homeDir: homedir(),
    });
  }

  async create(jobId, input) {
    if (this.stopping) {
      throw Object.assign(new Error("Server is stopping"), {
        code: "SERVER_STOPPING",
        statusCode: 503,
      });
    }
    const { artifactRoot } = await this.extraction(jobId);
    const target = await resolveProjectTarget(input.targetPath, {
      studioRoot: this.config.projectDir,
      homeDir: homedir(),
    });
    if (this.targetLocks.has(target.targetPath)) {
      throw Object.assign(new Error("Another application is already running for this target"), {
        code: "TARGET_BUSY",
        statusCode: 409,
      });
    }
    const timestamp = now();
    const id = `a${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
    const application = {
      id,
      jobId,
      mode: input.mode,
      status: "queued",
      targetPath: target.targetPath,
      gitRoot: target.gitRoot,
      artifactRoot,
      progress: { percent: 0, stage: "queued", message: "Waiting to analyze target project" },
      analysis: null,
      compatibility: null,
      plan: null,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
    };
    await this.store.create(application);
    this.applications.set(id, application);
    this.targetLocks.set(target.targetPath, id);
    await this.log(application, `[server] Application queued in ${input.mode} mode`);
    this.emitApplication(application);
    void this.execute(application);
    return await this.get(id);
  }

  async list({ jobId } = {}) {
    return [...this.applications.values()]
      .filter((application) => !jobId || application.jobId === jobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((application) => publicApplication(application));
  }

  async get(id, includeLog = true) {
    const application = this.applications.get(id);
    if (!application) return null;
    return publicApplication(
      application,
      includeLog ? await this.store.readLogTail(id) : "",
    );
  }

  subscribe(id, listener) {
    const event = `application:${id}`;
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  emitApplication(application, type = "snapshot", data = {}) {
    this.emit(`application:${application.id}`, {
      type,
      application: publicApplication(application),
      ...data,
    });
  }

  async log(application, line) {
    const replacements = [
      [this.config.projectDir, "<studio>"],
      [application.targetPath, "<target>"],
      [application.artifactRoot, "<artifacts>"],
      [homedir(), "~"],
    ];
    const safe = redact(String(line).slice(0, 8192), replacements);
    await this.store.appendLog(application.id, safe);
    this.emitApplication(application, "log", { line: safe });
  }

  async setProgress(application, percent, stage, message) {
    application.status = stage;
    application.progress = { percent, stage, message };
    application.updatedAt = now();
    await this.store.save(application);
    this.emitApplication(application, "progress");
  }

  async cancel(id) {
    const application = this.applications.get(id);
    if (!application) return null;
    if (TERMINAL.has(application.status)) return await this.get(id);
    application.cancelRequested = true;
    application.updatedAt = now();
    application.progress = {
      ...application.progress,
      stage: "cancelling",
      message: "Stopping application work",
    };
    await this.store.save(application);
    await this.log(application, "[server] Cancellation requested");
    this.active.get(id)?.abort();
    return await this.get(id);
  }

  async execute(application) {
    const controller = new AbortController();
    let terminal;
    this.active.set(application.id, controller);
    application.startedAt = now();
    const failIfCancelled = () => {
      if (controller.signal.aborted || application.cancelRequested) {
        throw Object.assign(new Error("Application cancelled"), {
          code: "APPLICATION_CANCELLED",
        });
      }
    };
    try {
      await this.setProgress(application, 8, "analyzing", "Analyzing framework, Git, and CSS entry");
      const analysisBundle = await this.analyze(application.jobId, application.targetPath);
      application.analysis = analysisBundle.analysis;
      application.compatibility = analysisBundle.compatibility;
      application.plan = analysisBundle.plan;
      await this.store.writeData(application.id, "analysis.json", application.analysis);
      await this.store.writeData(application.id, "plan.json", application.plan);
      await this.store.save(application);
      await this.log(
        application,
        `[analyze] ${application.analysis.framework.name}, CSS ${application.analysis.css.entry ?? "unresolved"}, compatibility ${application.compatibility.status}`,
      );
      failIfCancelled();
      if (!application.compatibility.safeInstall) {
        throw Object.assign(new Error(application.compatibility.blockers.join(" ")), {
          code: "APPLY_UNSUPPORTED",
        });
      }

      if (application.mode === "ai") {
        await this.setProgress(application, 20, "planning", "Checking Codex executable and authentication");
        const preflight = await codexPreflight(this.processRunner);
        if (!preflight.ok) {
          throw Object.assign(new Error(preflight.error), { code: "CODEX_PREFLIGHT_FAILED" });
        }
        await this.log(application, `[codex] preflight passed: ${preflight.version ?? "available"}`);
      } else {
        await this.setProgress(application, 20, "planning", "Safe installation plan confirmed");
      }
      failIfCancelled();

      await this.setProgress(application, 38, "applying", "Installing managed design artifacts");
      const install = await safeInstallDesignSystem({
        analysis: application.analysis,
        compatibility: application.compatibility,
        plan: application.plan,
        artifactRoot: application.artifactRoot,
        applicationId: application.id,
        signal: controller.signal,
        onLog: async (line) => await this.log(application, line),
      });
      let codex = null;
      if (application.mode === "ai") {
        failIfCancelled();
        await this.setProgress(application, 62, "applying", "Running controlled component adaptation");
        codex = await runCodexAdaptation({
          targetPath: application.targetPath,
          studioRoot: this.config.projectDir,
          artifactRoot: application.artifactRoot,
          analysisPath: this.store.file(application.id, "analysis.json"),
          timeoutMs: this.config.codexApplyTimeoutMs,
          signal: controller.signal,
          onLog: async (line) => await this.log(application, line),
          processRunner: this.processRunner,
        });
      }
      failIfCancelled();

      await this.setProgress(application, 78, "verifying", "Verifying manifest, imports, build, lint, and tests");
      const verification = await verifyDesignSystem({
        targetPath: application.targetPath,
        expectedManifestSha256: install.manifestSha256,
        timeoutMs: this.config.applyCommandTimeoutMs,
        signal: controller.signal,
        onLog: async (line) => await this.log(application, line),
        processRunner: this.processRunner,
      });
      application.result = {
        ...install,
        codex,
        verification,
        changedFiles: verification.changedFiles,
        diffSummary: verification.diffSummary,
      };
      await this.store.writeData(application.id, "result.json", application.result);
      terminal = {
        status: "succeeded",
        error: null,
        progress: {
          percent: 100,
          stage: "succeeded",
          message: "Design system applied and verified",
        },
      };
      await this.log(application, "[server] Application completed successfully");
    } catch (error) {
      if (
        error.code === "APPLICATION_CANCELLED" ||
        error.code === "PROCESS_CANCELLED" ||
        application.cancelRequested
      ) {
        terminal = {
          status: "cancelled",
          error: null,
          progress: {
            percent: application.progress.percent,
            stage: "cancelled",
            message: "Application cancelled",
          },
        };
        await this.log(application, "[server] Application cancelled");
      } else {
        const failure = {
          code: error.code ?? "APPLICATION_FAILED",
          message: String(error.message ?? error).slice(0, 1000),
        };
        terminal = {
          status: "failed",
          error: failure,
          progress: {
            percent: application.progress.percent,
            stage: "failed",
            message: "Application failed",
          },
        };
        await this.log(application, `[error] ${failure.message}`);
      }
    } finally {
      const finishedAt = now();
      Object.assign(application, terminal, {
        finishedAt,
        updatedAt: finishedAt,
      });
      try {
        await this.store.save(application);
        this.emitApplication(application);
      } finally {
        this.active.delete(application.id);
        this.targetLocks.delete(application.targetPath);
      }
    }
  }

  async shutdown() {
    this.stopping = true;
    for (const [id, controller] of this.active) {
      const application = this.applications.get(id);
      if (application) application.cancelRequested = true;
      controller.abort();
    }
    const deadline = Date.now() + 5000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
