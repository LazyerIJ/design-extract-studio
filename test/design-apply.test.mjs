import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeApplyRequest } from "../lib/project-analysis.mjs";
import {
  runCodexAdaptation,
  safeInstallDesignSystem,
  verifyDesignSystem,
} from "../lib/design-apply.mjs";
import {
  commitAll,
  createArtifactFixture,
  createWebProject,
} from "../test-support/apply.mjs";
import { temporaryProject } from "../test-support/helpers.mjs";

async function fixture(t, options = {}) {
  const root = await temporaryProject(t);
  const studio = join(root, "studio");
  const target = join(root, "target");
  const artifacts = join(root, "artifacts");
  await mkdir(studio);
  await mkdir(target);
  await createWebProject(target, options);
  await createArtifactFixture(artifacts);
  const analyze = () => analyzeApplyRequest({
    targetPath: target,
    artifactRoot: artifacts,
    studioRoot: studio,
    homeDir: dirname(root),
  });
  return { root, studio, target, artifacts, analyze };
}

test("Safe install copies managed artifacts, inserts one import block, and verifies", async (t) => {
  const context = await fixture(t);
  let bundle = await context.analyze();
  const first = await safeInstallDesignSystem({
    ...bundle,
    artifactRoot: context.artifacts,
    applicationId: "application-one",
  });
  assert.equal(first.manifestPath, ".design-system/manifest.json");
  let css = await readFile(join(context.target, "src", "index.css"), "utf8");
  assert.equal(css.match(/design-extract-studio:start/g)?.length, 1);
  assert.match(css, /@import "\.\.\/\.design-system\/artifacts\/variables\.css";/);
  const verification = await verifyDesignSystem({
    targetPath: context.target,
    expectedManifestSha256: first.manifestSha256,
    runCommands: false,
  });
  assert.equal(verification.static.ok, true);
  assert.equal(verification.static.fileChecks.length, 5);
  const manifestPath = join(context.target, ".design-system/manifest.json");
  const manifestSource = await readFile(manifestPath);
  const changedManifest = JSON.parse(manifestSource);
  changedManifest.files = [];
  await writeFile(manifestPath, `${JSON.stringify(changedManifest)}\n`);
  await assert.rejects(
    verifyDesignSystem({
      targetPath: context.target,
      expectedManifestSha256: first.manifestSha256,
      runCommands: false,
    }),
    (error) => error.code === "VERIFY_MANIFEST_CHANGED",
  );
  await writeFile(manifestPath, manifestSource);

  await commitAll(context.target, "first install");
  bundle = await context.analyze();
  await safeInstallDesignSystem({
    ...bundle,
    artifactRoot: context.artifacts,
    applicationId: "application-two",
  });
  css = await readFile(join(context.target, "src", "index.css"), "utf8");
  assert.equal(css.match(/design-extract-studio:start/g)?.length, 1);
});

test("Safe install refuses stale analysis and managed symlinks", async (t) => {
  const stale = await fixture(t);
  const staleBundle = await stale.analyze();
  await writeFile(join(stale.target, "src", "index.css"), "body { color: red; }\n");
  await assert.rejects(
    safeInstallDesignSystem({
      ...staleBundle,
      artifactRoot: stale.artifacts,
      applicationId: "stale",
    }),
    (error) => error.code === "GIT_DIRTY",
  );

  const linked = await fixture(t);
  await mkdir(join(linked.target, ".design-system"));
  await symlink(linked.artifacts, join(linked.target, ".design-system", "artifacts"));
  await commitAll(linked.target, "track unsafe managed symlink");
  const linkedBundle = await linked.analyze();
  await assert.rejects(
    safeInstallDesignSystem({
      ...linkedBundle,
      artifactRoot: linked.artifacts,
      applicationId: "linked",
    }),
    (error) => error.code === "MANAGED_PATH_UNSAFE",
  );
});

test("verify runs available scripts without a shell and fails on command errors", async (t) => {
  const context = await fixture(t, {
    scripts: { build: "node -e true", lint: "node -e true", test: "node -e true" },
  });
  const bundle = await context.analyze();
  await safeInstallDesignSystem({
    ...bundle,
    artifactRoot: context.artifacts,
    applicationId: "commands",
  });
  await writeFile(join(context.target, "package-lock.json"), '{"changed":true}\n');
  await assert.rejects(
    verifyDesignSystem({
      targetPath: context.target,
      runCommands: false,
    }),
    (error) =>
      error.code === "VERIFY_FORBIDDEN_CHANGE" &&
      error.paths.includes("package-lock.json"),
  );
  await writeFile(join(context.target, "package-lock.json"), "{}\n");
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      inheritEnv: options.inheritEnv,
    });
    return {
      command,
      args,
      exitCode: args.at(-1) === "lint" ? 1 : 0,
      signal: null,
      stdout: "",
      stderr: "",
    };
  };
  await assert.rejects(
    verifyDesignSystem({
      targetPath: context.target,
      processRunner: runner,
    }),
    (error) => error.code === "VERIFY_COMMAND_FAILED",
  );
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      ["npm", ["run", "build"]],
      ["npm", ["run", "lint"]],
    ],
  );
  assert.equal(
    calls.every((call) => call.cwd === bundle.analysis.targetPath),
    true,
  );
  assert.equal(calls.every((call) => call.inheritEnv === false), true);
  assert.equal(
    calls.every((call) => !("OPENAI_API_KEY" in call.env)),
    true,
  );
});

test("controlled Codex prompt names the repo skill and CLI paths with a minimal environment", async (t) => {
  const context = await fixture(t);
  const analysisPath = join(context.root, "analysis.json");
  await writeFile(analysisPath, "{}\n");
  const calls = [];
  const result = await runCodexAdaptation({
    targetPath: context.target,
    studioRoot: context.studio,
    artifactRoot: context.artifacts,
    analysisPath,
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        command,
        args,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
      };
    },
  });
  const call = calls[0];
  const prompt = call.args.at(-1);
  const skillPath = join(
    context.studio,
    ".agents/skills/apply-design-system/SKILL.md",
  );
  assert.equal(call.command, "codex");
  assert.equal(call.options.cwd, context.target);
  assert.equal(call.options.inheritEnv, false);
  assert.equal("OPENAI_API_KEY" in call.options.env, false);
  assert.match(prompt, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const script of ["analyze.mjs", "apply.mjs", "verify.mjs"]) {
    assert.match(prompt, new RegExp(`${script.replace(".", "\\.")}`));
  }
  assert.match(prompt, /MUST read and follow/);
  assert.equal(result.skillPath, skillPath);
});

test("controlled Codex failure preserves the exit code without exposing output in the error", async (t) => {
  const context = await fixture(t);
  const analysisPath = join(context.root, "analysis.json");
  await writeFile(analysisPath, "{}\n");
  await assert.rejects(
    runCodexAdaptation({
      targetPath: context.target,
      studioRoot: context.studio,
      artifactRoot: context.artifacts,
      analysisPath,
      processRunner: async () => ({
        exitCode: 17,
        signal: null,
        stdout: "OPENAI_API_KEY=secret",
        stderr: "provider detail",
      }),
    }),
    (error) =>
      error.code === "CODEX_FAILED" &&
      error.exitCode === 17 &&
      /exit code 17/.test(error.message) &&
      !/secret|provider detail/.test(error.message),
  );
});
