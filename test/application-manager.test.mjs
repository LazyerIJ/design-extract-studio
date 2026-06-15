import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationManager } from "../lib/application-manager.mjs";
import { ApplicationStore } from "../lib/application-store.mjs";
import { createConfig } from "../lib/config.mjs";
import { processError } from "../lib/process-utils.mjs";
import { createArtifactFixture, createWebProject } from "../test-support/apply.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";

const JOB_ID = "mfixture-123456789abc";

async function waitForApplication(manager, id, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const application = await manager.get(id);
    if (application && predicate(application)) return application;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for application ${id}`);
}

async function setup(t, processRunner) {
  const root = await temporaryProject(t);
  const studio = join(root, "studio");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  await mkdir(studio);
  await mkdir(target);
  await createWebProject(target);
  await createArtifactFixture(artifacts);
  const config = createConfig({
    projectDir: studio,
    applicationsDir: join(root, "applications"),
    jobsDir: join(root, "jobs"),
    sourceAssetsDir: artifacts,
    applyCommandTimeoutMs: 1000,
    codexApplyTimeoutMs: 1000,
  });
  const extractionManager = {
    store: { artifactDir: () => artifacts },
    get: async (id) => id === JOB_ID ? { id, status: "succeeded" } : null,
  };
  const store = new ApplicationStore(config.applicationsDir);
  const manager = new ApplicationManager({
    config,
    store,
    extractionManager,
    processRunner,
  });
  await manager.initialize();
  t.after(() => manager.shutdown());
  return { root, studio, target, artifacts, config, store, manager };
}

test("application manager persists a successful Safe install", async (t) => {
  const context = await setup(t);
  const created = await context.manager.create(JOB_ID, {
    targetPath: context.target,
    mode: "safe",
    confirmed: true,
  });
  const completed = await waitForApplication(
    context.manager,
    created.id,
    (application) => application.status === "succeeded",
  );
  assert.equal(completed.result.verification.ok, true);
  assert.equal(completed.result.verification.static.ok, true);
  assert.equal("artifactRoot" in completed, false);
  assert.match(completed.recentLog, /completed successfully/);

  const recoveredStore = new ApplicationStore(context.config.applicationsDir);
  const recoveredManager = new ApplicationManager({
    config: context.config,
    store: recoveredStore,
    extractionManager: context.manager.extractionManager,
  });
  await recoveredManager.initialize();
  t.after(() => recoveredManager.shutdown());
  assert.equal((await recoveredManager.get(created.id)).status, "succeeded");
});

test("AI application uses controlled Codex args, locks the target, and cancels", async (t) => {
  const calls = [];
  const processRunner = async (command, args, options = {}) => {
    calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      inheritEnv: options.inheritEnv,
    });
    if (args.includes("exec")) {
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(processError("cancelled", "PROCESS_CANCELLED"));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return {
      command,
      args,
      exitCode: 0,
      signal: null,
      stdout: command === "codex" ? "codex 1.0.0\n" : "",
      stderr: "",
    };
  };
  const context = await setup(t, processRunner);
  const created = await context.manager.create(JOB_ID, {
    targetPath: context.target,
    mode: "ai",
    confirmed: true,
  });
  await waitForApplication(
    context.manager,
    created.id,
    (application) =>
      application.status === "applying" &&
      calls.some((call) => call.args.includes("exec")),
  );
  await assert.rejects(
    context.manager.create(JOB_ID, {
      targetPath: context.target,
      mode: "safe",
      confirmed: true,
    }),
    (error) => error.code === "TARGET_BUSY" && error.statusCode === 409,
  );
  await context.manager.cancel(created.id);
  const cancelled = await waitForApplication(
    context.manager,
    created.id,
    (application) => application.status === "cancelled",
  );
  assert.equal(cancelled.status, "cancelled");
  const execCall = calls.find((call) => call.args.includes("exec"));
  assert.equal(execCall.cwd, created.targetPath);
  assert(execCall.args.includes("workspace-write"));
  assert(execCall.args.includes('approval_policy="never"'));
  assert.equal(execCall.args.includes("danger-full-access"), false);
  assert.equal(execCall.inheritEnv, false);
  assert.equal("OPENAI_API_KEY" in execCall.env, false);
  assert.match(
    execCall.args.at(-1),
    /\.agents\/skills\/apply-design-system\/SKILL\.md/,
  );
});

test("initialize marks nonterminal applications as interrupted", async (t) => {
  const context = await setup(t);
  const timestamp = new Date().toISOString();
  await context.store.create({
    id: "arestart-123456789abc",
    jobId: JOB_ID,
    mode: "safe",
    status: "applying",
    targetPath: context.target,
    gitRoot: context.target,
    artifactRoot: context.artifacts,
    progress: { percent: 50, stage: "applying", message: "Working" },
    analysis: null,
    compatibility: null,
    plan: null,
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    cancelRequested: false,
  });
  const recovered = new ApplicationManager({
    config: context.config,
    store: new ApplicationStore(context.config.applicationsDir),
    extractionManager: context.manager.extractionManager,
  });
  await recovered.initialize();
  t.after(() => recovered.shutdown());
  const application = await recovered.get("arestart-123456789abc");
  assert.equal(application.status, "failed");
  assert.equal(application.error.code, "INTERRUPTED");
});
