import assert from "node:assert/strict";
import test from "node:test";
import { JobManager } from "../lib/job-manager.mjs";
import { JobStore } from "../lib/store.mjs";
import {
  createManager,
  temporaryProject,
  testConfig,
  waitForJob,
} from "../test-support/helpers.mjs";

const INPUT = {
  url: "https://example.com/",
  options: { dark: true, screenshots: true, depth: 1, wait: 0 },
};

test("FIFO queue runs only one extraction at a time", async (t) => {
  const starts = [];
  const releases = [];
  const runner = async (job, hooks) => {
    starts.push(job.id);
    await hooks.onSpawn(100 + starts.length, () => {});
    await new Promise((resolve) => releases.push(resolve));
    return { exitCode: 0, signal: null };
  };
  const { manager } = await createManager(t, runner);
  const first = await manager.create(INPUT);
  const second = await manager.create(INPUT);

  await waitForJob(
    manager,
    first.id,
    (job) => job.status === "running" && releases.length === 1,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(starts.length, 1);
  assert.equal((await manager.get(second.id)).status, "queued");

  releases.shift()();
  await waitForJob(manager, first.id, (job) => job.status === "succeeded");
  await waitForJob(
    manager,
    second.id,
    (job) => job.status === "running" && releases.length === 1,
  );
  assert.deepEqual(starts, [first.id, second.id]);
  releases.shift()();
  await waitForJob(manager, second.id, (job) => job.status === "succeeded");
});

test("queued and running jobs can be cancelled", async (t) => {
  let rejectRunning;
  const runner = async (_job, hooks) => {
    await hooks.onSpawn(222, () => {
      const error = new Error("cancelled");
      error.code = "JOB_CANCELLED";
      rejectRunning(error);
    });
    return await new Promise((_resolve, reject) => {
      rejectRunning = reject;
    });
  };
  const { manager } = await createManager(t, runner);
  const running = await manager.create(INPUT);
  const queued = await manager.create(INPUT);
  await waitForJob(manager, running.id, (job) => job.status === "running");

  assert.equal((await manager.cancel(queued.id)).status, "cancelled");
  await manager.cancel(running.id);
  assert.equal(
    (await waitForJob(manager, running.id, (job) => job.status === "cancelled")).status,
    "cancelled",
  );
});

test("cancelling during the layout phase aborts it and marks the job cancelled", async (t) => {
  const root = await temporaryProject(t);
  const config = testConfig(root, { enableLayoutExtraction: true });
  const store = new JobStore(config.jobsDir);

  // designlang finishes instantly; the layout pass then blocks until its signal
  // aborts — mirroring the real Chrome/CDP run so we can prove a cancel reaches
  // it (rather than only the already-dead designlang child).
  let layoutSignal = null;
  const manager = new JobManager({
    config,
    store,
    runner: async () => ({ exitCode: 0 }),
    layoutRunner: async (_job, _config, hooks) => {
      layoutSignal = hooks.signal;
      return await new Promise((_resolve, reject) => {
        hooks.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" })),
          { once: true },
        );
      });
    },
  });
  await manager.initialize();
  t.after(() => manager.shutdown());

  const job = await manager.create(INPUT);
  await waitForJob(manager, job.id, (j) => j.progress.stage === "layout");
  assert.equal(layoutSignal?.aborted, false);

  await manager.cancel(job.id);
  const cancelled = await waitForJob(manager, job.id, (j) => j.status === "cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(layoutSignal.aborted, true);
});

test("server restart marks a formerly running job as interrupted", async (t) => {
  const root = await temporaryProject(t);
  const config = testConfig(root);
  const store = new JobStore(config.jobsDir);
  await store.initialize();
  const timestamp = new Date().toISOString();
  await store.create({
    id: "mrestart-123456789abc",
    url: INPUT.url,
    options: INPUT.options,
    status: "running",
    progress: { percent: 42, stage: "running", message: "Working" },
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    pid: 999,
    exitCode: null,
    signal: null,
    retryOf: null,
    error: null,
    integrity: null,
    summary: null,
    analysis: { status: "disabled" },
    artifactCount: 0,
    cancelRequested: false,
  });

  const manager = new JobManager({
    config,
    store,
    runner: async () => ({ exitCode: 0 }),
  });
  await manager.initialize();
  t.after(() => manager.shutdown());
  const recovered = await manager.get("mrestart-123456789abc");
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.progress.stage, "interrupted");
  assert.equal(recovered.error.code, "INTERRUPTED");
  assert.match(recovered.recentLog, /interrupted by a server restart/i);
});
