import assert from "node:assert/strict";
import test from "node:test";
import { delay } from "../lib/cdp.mjs";
import { extractLayout } from "../lib/layout-extractor.mjs";

test("delay rejects immediately when its signal is already aborted", async () => {
  const reason = new Error("nope");
  await assert.rejects(delay(1000, AbortSignal.abort(reason)), (e) => e === reason);
});

test("delay rejects with the abort reason when aborted mid-wait", async () => {
  const ac = new AbortController();
  const reason = Object.assign(new Error("cancel"), { code: "JOB_CANCELLED" });
  const pending = delay(5000, ac.signal);
  ac.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
});

test("delay still resolves normally without a signal", async () => {
  await delay(1); // resolves
});

test("extractLayout throws before launching Chrome when already aborted", async () => {
  // No Chrome should ever spawn: the guard fires on the aborted signal first.
  const reason = new Error("pre-aborted");
  let logged = false;
  await assert.rejects(
    extractLayout({
      url: "https://example.com/",
      signal: AbortSignal.abort(reason),
      onLog: async () => {
        logged = true;
      },
    }),
    (e) => e === reason,
  );
  assert.equal(logged, false, "must not reach the Chrome-launch log");
});
