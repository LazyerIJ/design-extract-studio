import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../lib/config.mjs";
import { JobManager } from "../lib/job-manager.mjs";
import { JobStore } from "../lib/store.mjs";

export async function temporaryProject(t) {
  const root = await mkdtemp(join(tmpdir(), "design-ops-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function testConfig(root, overrides = {}) {
  return createConfig({
    projectDir: root,
    jobsDir: join(root, "jobs"),
    sourceAssetsDir: root,
    npmCache: join(root, "npm-cache"),
    port: 0,
    ...overrides,
  });
}

export async function createManager(t, runner, overrides = {}) {
  const root = await temporaryProject(t);
  const config = testConfig(root, overrides);
  const store = new JobStore(config.jobsDir);
  const manager = new JobManager({ config, store, runner });
  await manager.initialize();
  t.after(() => manager.shutdown());
  return { root, config, store, manager };
}

export async function waitForJob(manager, id, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await manager.get(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

export async function writeValidPng(path) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  await writeFile(path, buffer);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
