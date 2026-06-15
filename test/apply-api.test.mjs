import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppServer, isLoopbackBind } from "../lib/http.mjs";
import { ApplicationManager } from "../lib/application-manager.mjs";
import { ApplicationStore } from "../lib/application-store.mjs";
import { createConfig } from "../lib/config.mjs";
import { createArtifactFixture, createWebProject } from "../test-support/apply.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";

const JOB_ID = "mfixture-123456789abc";

test("loopback detection accepts hostnames and bracketed IPv6", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
  assert.equal(isLoopbackBind("localhost"), true);
  assert.equal(isLoopbackBind("::1"), true);
  assert.equal(isLoopbackBind("[::1]"), true);
  assert.equal(isLoopbackBind("0.0.0.0"), false);
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function poll(base, id) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/applications/${id}`);
    const data = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(data.application.status)) {
      return data.application;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out polling application");
}

test("localhost API analyzes and applies, while non-loopback configuration rejects it", async (t) => {
  const root = await temporaryProject(t);
  const studio = join(root, "studio");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  await mkdir(studio);
  await mkdir(target);
  await createWebProject(target);
  await createArtifactFixture(artifacts);
  await writeFile(join(studio, "index.html"), "<!doctype html><title>Apply API</title>");
  await writeFile(join(studio, "app.css"), "");
  await writeFile(join(studio, "app.js"), "");
  const config = createConfig({
    projectDir: studio,
    applicationsDir: join(root, "applications"),
    jobsDir: join(root, "jobs"),
    sourceAssetsDir: artifacts,
    port: 0,
  });
  const extractionManager = {
    store: { artifactDir: () => artifacts },
    get: async (id) => id === JOB_ID
      ? { id, status: "succeeded", recentLog: "" }
      : null,
    list: async () => [{ id: JOB_ID, status: "succeeded" }],
  };
  const applicationManager = new ApplicationManager({
    config,
    store: new ApplicationStore(config.applicationsDir),
    extractionManager,
  });
  await applicationManager.initialize();
  t.after(() => applicationManager.shutdown());
  const server = createAppServer({
    config,
    manager: extractionManager,
    applicationManager,
  });
  const base = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.applyEnabled, true);
  const analysisResponse = await fetch(
    `${base}/api/jobs/${JOB_ID}/applications/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPath: target }),
    },
  );
  assert.equal(analysisResponse.status, 200);
  const analysis = await analysisResponse.json();
  assert.equal(analysis.compatibility.safeInstall, true);

  const crossOrigin = await fetch(
    `${base}/api/jobs/${JOB_ID}/applications/analyze`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ targetPath: target }),
    },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "LOCAL_ORIGIN_REQUIRED");

  const nonJson = await fetch(
    `${base}/api/jobs/${JOB_ID}/applications/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ targetPath: target }),
    },
  );
  assert.equal(nonJson.status, 415);
  assert.equal((await nonJson.json()).error.code, "JSON_CONTENT_TYPE_REQUIRED");

  const createResponse = await fetch(`${base}/api/jobs/${JOB_ID}/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetPath: target, mode: "safe", confirmed: true }),
  });
  assert.equal(createResponse.status, 202);
  const created = (await createResponse.json()).application;
  const completed = await poll(base, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.verification.ok, true);
  const history = await fetch(
    `${base}/api/jobs/${JOB_ID}/applications`,
  ).then((response) => response.json());
  assert.equal(history.applications.length, 1);

  const publicConfig = { ...config, host: "0.0.0.0" };
  const publicServer = createAppServer({
    config: publicConfig,
    manager: extractionManager,
    applicationManager,
  });
  const publicBase = await listen(publicServer);
  t.after(() => new Promise((resolve) => publicServer.close(resolve)));
  const publicHealth = await fetch(`${publicBase}/api/health`).then((response) => response.json());
  assert.equal(publicHealth.applyEnabled, false);
  const rejected = await fetch(
    `${publicBase}/api/jobs/${JOB_ID}/applications/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPath: target }),
    },
  );
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, "APPLY_LOCALHOST_ONLY");
});
