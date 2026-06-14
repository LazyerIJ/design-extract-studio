import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listArtifacts,
  mimeTypeFor,
  resolveArtifactPath,
  validateArtifacts,
} from "../lib/artifacts.mjs";
import { temporaryProject, writeValidPng } from "../test-support/helpers.mjs";

test("artifact listing, MIME detection, and integrity validation", async (t) => {
  const root = await temporaryProject(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "tokens.json"), '{"color":"#050505"}');
  await writeFile(join(root, "nested", "logo.svg"), '<svg viewBox="0 0 1 1"></svg>');
  await writeValidPng(join(root, "screen.png"));

  const files = await listArtifacts(root);
  assert.deepEqual(files.map((file) => file.path), [
    "nested/logo.svg",
    "screen.png",
    "tokens.json",
  ]);
  assert.equal(mimeTypeFor("theme.css"), "text/css; charset=utf-8");
  assert.equal(mimeTypeFor("screen.png"), "image/png");

  const integrity = await validateArtifacts(root);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.fileCount, 3);
  assert.equal(integrity.json.valid, 1);
  assert.equal(integrity.images.pngCount, 1);
  assert.equal(integrity.images.svgCount, 1);
});

test("integrity validation reports empty and malformed artifacts", async (t) => {
  const root = await temporaryProject(t);
  await writeFile(join(root, "empty.css"), "");
  await writeFile(join(root, "bad.json"), "{");
  await writeFile(join(root, "bad.png"), "not png");
  const result = await validateArtifacts(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.emptyFiles, ["empty.css"]);
  assert.equal(result.json.invalid[0].path, "bad.json");
  assert.deepEqual(result.images.invalidPng, ["bad.png"]);
});

test("artifact path resolution blocks traversal, invalid encoding, and symlinks", async (t) => {
  const root = await temporaryProject(t);
  const outside = await temporaryProject(t);
  await writeFile(join(root, "safe.txt"), "safe");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));

  assert.equal(await resolveArtifactPath(root, "safe.txt"), await realpath(join(root, "safe.txt")));
  await assert.rejects(() => resolveArtifactPath(root, "../secret.txt"), {
    code: "INVALID_ARTIFACT_PATH",
  });
  await assert.rejects(() => resolveArtifactPath(root, "%E0%A4%A"), {
    code: "INVALID_ARTIFACT_PATH",
  });
  await assert.rejects(() => resolveArtifactPath(root, "linked.txt"), {
    code: "ARTIFACT_NOT_FOUND",
  });
  await assert.rejects(() => resolveArtifactPath(root, "missing.txt"), {
    code: "ARTIFACT_NOT_FOUND",
  });
});
