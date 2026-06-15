import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  analyzeApplyRequest,
  resolveProjectTarget,
} from "../lib/project-analysis.mjs";
import { createArtifactFixture, createWebProject } from "../test-support/apply.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";

test("analyze detects Vite React, CSS entry, package manager, Tailwind, and shadcn", async (t) => {
  const root = await temporaryProject(t);
  const studio = join(root, "studio");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  await mkdir(studio);
  await mkdir(target);
  await createWebProject(target, { tailwind: "^4.1.0", shadcn: true });
  await createArtifactFixture(artifacts);

  const result = await analyzeApplyRequest({
    targetPath: target,
    artifactRoot: artifacts,
    studioRoot: studio,
    homeDir: dirname(root),
  });

  assert.equal(result.analysis.framework.name, "vite-react");
  assert.equal(result.analysis.packageManager.name, "npm");
  assert.equal(result.analysis.css.entry, "src/index.css");
  assert.equal(result.analysis.css.confidence, "high");
  assert.match(result.analysis.css.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.analysis.tailwind.version, 4);
  assert.equal(result.analysis.shadcn.detected, true);
  assert.equal(result.compatibility.status, "partial");
  assert.equal(result.compatibility.safeInstall, true);
  assert(result.plan.artifacts.some((artifact) => artifact.role === "variables.css"));
});

test("dirty and ambiguous projects are unsupported and produce no write plan", async (t) => {
  const root = await temporaryProject(t);
  const studio = join(root, "studio");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  await mkdir(studio);
  await mkdir(target);
  await createWebProject(target);
  await createArtifactFixture(artifacts);
  await writeFile(join(target, "dirty.txt"), "not committed\n");
  await writeFile(join(target, "src", "main.jsx"), 'import "./index.css";\nimport "./other.css";\n');
  await writeFile(join(target, "src", "other.css"), "body{}\n");

  const result = await analyzeApplyRequest({
    targetPath: target,
    artifactRoot: artifacts,
    studioRoot: studio,
    homeDir: dirname(root),
  });

  assert.equal(result.analysis.git.clean, false);
  assert.equal(result.analysis.css.confidence, "ambiguous");
  assert.equal(result.compatibility.status, "unsupported");
  assert.equal(result.compatibility.safeInstall, false);
  assert.equal(
    result.plan.changes.some((change) => change.action === "update-imports"),
    false,
  );
});

test("target safety rejects studio parents and symlink target paths", async (t) => {
  const root = await temporaryProject(t);
  const studio = join(root, "parent", "studio");
  const parent = dirname(studio);
  const target = join(root, "target");
  await mkdir(studio, { recursive: true });
  await mkdir(target);
  await createWebProject(target);
  await assert.rejects(
    resolveProjectTarget(parent, {
      studioRoot: studio,
      homeDir: dirname(root),
    }),
    (error) => error.code === "TARGET_FORBIDDEN",
  );
  const linked = join(root, "linked");
  await symlink(target, linked);
  await assert.rejects(
    resolveProjectTarget(linked, {
      studioRoot: studio,
      homeDir: dirname(root),
    }),
    (error) => error.code === "TARGET_INVALID",
  );
});

