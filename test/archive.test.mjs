import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createArtifactBundle } from "../lib/archive.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";
import { parseTarEntries } from "../test-support/tar.mjs";

async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("artifact bundle is a readable tar.gz containing only regular files", async (t) => {
  const root = await temporaryProject(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "design-language.md"), "# Design");
  await writeFile(join(root, "nested", "variables.css"), ":root{}");
  await symlink("design-language.md", join(root, "linked.md"));

  const bundle = await createArtifactBundle(root);
  assert.deepEqual(bundle.entries.map((entry) => entry.path), [
    "design-language.md",
    "nested/variables.css",
  ]);
  const entries = parseTarEntries(await streamBuffer(bundle.stream));
  assert.deepEqual(entries.map((entry) => entry.path), [
    "design-language.md",
    "nested/variables.css",
  ]);
  assert.equal(entries[0].content.toString("utf8"), "# Design");
  assert.equal(entries[1].content.toString("utf8"), ":root{}");
});
