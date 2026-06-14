import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { JobStore } from "../lib/store.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";

test("concurrent job saves use independent atomic temporary files", async (t) => {
  const root = await temporaryProject(t);
  const store = new JobStore(root);
  await store.initialize();
  const base = {
    id: "mconcurrent-123456789abc",
    createdAt: new Date().toISOString(),
  };
  await store.create(base);

  await Promise.all(
    Array.from({ length: 40 }, (_, sequence) =>
      store.save({ ...base, sequence }),
    ),
  );

  const files = await readdir(store.jobDir(base.id));
  assert.deepEqual(files.sort(), ["artifacts", "job.json", "job.log"]);
  const saved = await store.loadAll();
  assert.equal(saved.length, 1);
  assert.equal(Number.isInteger(saved[0].sequence), true);
});
