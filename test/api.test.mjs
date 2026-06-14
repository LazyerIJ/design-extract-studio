import assert from "node:assert/strict";
import test from "node:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createAppServer } from "../lib/http.mjs";
import { createManager, waitForJob, writeValidPng } from "../test-support/helpers.mjs";
import { parseTarEntries } from "../test-support/tar.mjs";

async function rawRequest(base, path, method = "GET", body = null) {
  const target = new URL(base);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      method,
      path,
      headers: body
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("HTTP API creates jobs and serves validated artifacts", async (t) => {
  const runner = async (_job, hooks) => {
    await hooks.onSpawn(321, () => {});
    await hooks.onLog("fixture extraction");
    await writeFile(
      join(hooks.artifactDir, "fixture-design-language.md"),
      "**Overall Score: 100%** — 1 passing, 0 failing color pairs\n**Overall: 91/100 (Grade: A)**\n",
    );
    await writeFile(join(hooks.artifactDir, "tokens.json"), '{"ok":true}');
    await writeFile(join(hooks.artifactDir, "preview.html"), "<h1>Preview</h1>");
    await writeValidPng(join(hooks.artifactDir, "screen.png"));
    await symlink("tokens.json", join(hooks.artifactDir, "linked.json"));
    return { exitCode: 0, signal: null };
  };
  const { root, config, manager } = await createManager(t, runner);
  await writeFile(join(root, "index.html"), "<!doctype html><title>Test</title>");
  await writeFile(join(root, "app.css"), "body { color: white; }\n");
  await writeFile(join(root, "source.md"), "# Source\n");
  const server = createAppServer({ config, manager });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const invalid = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "file:///etc/passwd" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");

  const create = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      options: { dark: true, screenshots: true, depth: 1, wait: 0 },
    }),
  });
  assert.equal(create.status, 202);
  const created = (await create.json()).job;
  const completed = await waitForJob(
    manager,
    created.id,
    (job) => job.status === "succeeded",
  );
  assert.equal(completed.integrity.ok, true);
  assert.equal(completed.summary.designScore, 91);
  const detail = await fetch(`${base}/api/jobs/${created.id}`).then((response) =>
    response.json()
  );
  assert.equal(detail.job.artifactPath, manager.store.artifactDir(created.id));

  const jobs = await fetch(`${base}/api/jobs`).then((response) => response.json());
  assert.equal(jobs.jobs.length, 1);
  const artifacts = await fetch(
    `${base}/api/jobs/${created.id}/artifacts`,
  ).then((response) => response.json());
  assert.deepEqual(
    artifacts.artifacts.map((artifact) => artifact.path),
    ["fixture-design-language.md", "preview.html", "screen.png", "tokens.json"],
  );
  assert.equal(artifacts.artifacts[0].classification.type, "핵심 디자인 보고서");

  const tokenResponse = await fetch(
    `${base}/api/jobs/${created.id}/artifacts/tokens.json`,
  );
  assert.equal(tokenResponse.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await tokenResponse.json(), { ok: true });
  const htmlArtifact = await fetch(
    `${base}/api/jobs/${created.id}/artifacts/preview.html`,
  );
  assert.equal(htmlArtifact.status, 200);
  assert.match(htmlArtifact.headers.get("content-security-policy"), /^sandbox/);
  assert.equal(htmlArtifact.headers.get("x-frame-options"), "SAMEORIGIN");

  const bundleResponse = await fetch(
    `${base}/api/jobs/${created.id}/artifacts-download`,
  );
  assert.equal(bundleResponse.status, 200);
  assert.equal(bundleResponse.headers.get("content-type"), "application/gzip");
  assert.match(
    bundleResponse.headers.get("content-disposition"),
    new RegExp(`filename="designlang-${created.id}-artifacts\\.tar\\.gz"`),
  );
  const bundleEntries = parseTarEntries(
    Buffer.from(await bundleResponse.arrayBuffer()),
  );
  assert.deepEqual(
    bundleEntries.map((entry) => entry.path),
    ["fixture-design-language.md", "preview.html", "screen.png", "tokens.json"],
  );
  assert.equal(bundleEntries.some((entry) => entry.path === "linked.json"), false);

  const controller = new AbortController();
  const events = await fetch(`${base}/api/jobs/${created.id}/events`, {
    signal: controller.signal,
  });
  const eventReader = events.body.getReader();
  let eventText = "";
  while (!eventText.includes("event: snapshot")) {
    const chunk = await eventReader.read();
    if (chunk.done) break;
    eventText += Buffer.from(chunk.value).toString("utf8");
  }
  controller.abort();
  assert.match(eventText, /event: snapshot/);

  const head = await rawRequest(base, "/app.css", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const appHtml = await rawRequest(base, "/");
  assert.match(appHtml.headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(appHtml.headers["content-security-policy"], /^sandbox/);
  const sourceHead = await rawRequest(
    base,
    "/source-assets/source.md",
    "HEAD",
  );
  assert.equal(sourceHead.status, 200);
  assert.equal(sourceHead.body.length, 0);

  const traversal = await rawRequest(
    base,
    `/api/jobs/${created.id}/artifacts/%2e%2e%2fjob.json`,
  );
  assert.equal(traversal.status, 400);
  assert.equal(JSON.parse(traversal.body).error.code, "INVALID_ARTIFACT_PATH");

  const tooLarge = await rawRequest(
    base,
    "/api/jobs",
    "POST",
    JSON.stringify({ url: `https://example.com/${"a".repeat(17000)}` }),
  );
  assert.equal(tooLarge.status, 413);

  const publicConfigServer = createAppServer({
    config: { ...config, host: "0.0.0.0" },
    manager,
  });
  await new Promise((resolve) =>
    publicConfigServer.listen(0, "127.0.0.1", resolve)
  );
  t.after(() => new Promise((resolve) => publicConfigServer.close(resolve)));
  const publicBase = `http://127.0.0.1:${publicConfigServer.address().port}`;
  const hiddenPath = await fetch(`${publicBase}/api/jobs/${created.id}`).then(
    (response) => response.json(),
  );
  assert.equal("artifactPath" in hiddenPath.job, false);
});
