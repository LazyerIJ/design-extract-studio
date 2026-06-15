import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLayoutExtraction } from "../lib/layout-step.mjs";

// Opt-in: layout runs only when options.layout === true.
const JOB = { url: "https://example.com/", options: { layout: true } };

async function artifactDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "layout-step-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function hooks(dir, signal) {
  return { artifactDir: dir, signal, onLog: async () => {}, onProgress: async () => {} };
}

const SAMPLE = {
  generatedAt: "2026-06-15T00:00:00.000Z",
  url: "https://example.com/",
  breakpoints: {
    desktop: {
      width: 1440,
      nodeCount: 1,
      scrollHeight: 1000,
      tree: {
        tag: "main",
        dom: "main",
        grid: { columns: 1, template: "1fr", gap: "0px" },
        rect: { x: 0, y: 0, w: 1440, h: 1000 },
        children: [],
      },
    },
  },
};

// Fake extractor that blocks until its signal aborts — stands in for the real
// Chrome/CDP run so we can exercise the cancel/timeout contract deterministically.
function blockingExtract(record) {
  return ({ signal }) => {
    record.signal = signal;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

test("disabled by config returns a disabled status without running", async (t) => {
  const dir = await artifactDir(t);
  const out = await runLayoutExtraction(
    JOB,
    { enableLayoutExtraction: false, layoutTimeoutMs: 1000 },
    hooks(dir),
    { extract: () => assert.fail("extract should not run") },
  );
  assert.equal(out.status, "disabled");
});

test("disabled per-job (options.layout=false) short-circuits", async (t) => {
  const dir = await artifactDir(t);
  const out = await runLayoutExtraction(
    { ...JOB, options: { layout: false } },
    { enableLayoutExtraction: true, layoutTimeoutMs: 1000 },
    hooks(dir),
    { extract: () => assert.fail("extract should not run") },
  );
  assert.equal(out.status, "disabled");
});

test("success writes the four artifacts and reports breakpoints", async (t) => {
  const dir = await artifactDir(t);
  const out = await runLayoutExtraction(
    JOB,
    { enableLayoutExtraction: true, layoutTimeoutMs: 1000 },
    hooks(dir),
    { extract: async () => SAMPLE },
  );
  assert.equal(out.status, "succeeded");
  assert.equal(out.files.length, 4);
  const written = await readdir(dir);
  assert.ok(written.some((n) => n.endsWith("-layout.css")));
  assert.equal(out.breakpoints[0].name, "desktop");
});

test("timeout aborts the extractor and stays non-fatal (status failed)", async (t) => {
  const dir = await artifactDir(t);
  const record = {};
  const out = await runLayoutExtraction(
    JOB,
    { enableLayoutExtraction: true, layoutTimeoutMs: 40 },
    hooks(dir),
    { extract: blockingExtract(record) },
  );
  assert.equal(out.status, "failed");
  assert.match(out.error, /timed out/i);
  // The extractor was handed a signal and that signal really fired.
  assert.ok(record.signal.aborted);
});

test("cancel (parent abort) propagates as a JOB_CANCELLED throw", async (t) => {
  const dir = await artifactDir(t);
  const parent = new AbortController();
  const record = {};
  const promise = runLayoutExtraction(
    JOB,
    { enableLayoutExtraction: true, layoutTimeoutMs: 60000 },
    hooks(dir, parent.signal),
    { extract: blockingExtract(record) },
  );
  parent.abort(Object.assign(new Error("cancel"), { code: "JOB_CANCELLED" }));
  await assert.rejects(promise, (error) => error.code === "JOB_CANCELLED");
});
