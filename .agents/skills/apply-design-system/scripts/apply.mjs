import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { analyzeApplyRequest } from "../../../../lib/project-analysis.mjs";
import {
  codexPreflight,
  runCodexAdaptation,
  safeInstallDesignSystem,
  verifyDesignSystem,
} from "../../../../lib/design-apply.mjs";
import {
  parseArgs,
  printFailure,
  printResult,
  requireArgs,
} from "./cli-utils.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

try {
  const args = parseArgs(process.argv.slice(2));
  requireArgs(args, ["target", "artifacts", "mode"]);
  if (args.confirmed !== true) {
    throw Object.assign(new Error("--confirmed is required before any write"), {
      code: "CONFIRMATION_REQUIRED",
    });
  }
  if (!["safe", "ai"].includes(args.mode)) {
    throw Object.assign(new Error("--mode must be safe or ai"), {
      code: "CLI_ARGUMENT_INVALID",
    });
  }
  const bundle = await analyzeApplyRequest({
    targetPath: args.target,
    artifactRoot: args.artifacts,
    studioRoot: repoRoot,
  });
  if (!bundle.compatibility.safeInstall) {
    throw Object.assign(new Error(bundle.compatibility.blockers.join(" ")), {
      code: "APPLY_UNSUPPORTED",
    });
  }
  if (args.mode === "ai") {
    const preflight = await codexPreflight();
    if (!preflight.ok) {
      throw Object.assign(new Error(preflight.error), {
        code: "CODEX_PREFLIGHT_FAILED",
      });
    }
  }
  const applicationId = `cli-${randomUUID().slice(0, 12)}`;
  const install = await safeInstallDesignSystem({
    analysis: bundle.analysis,
    compatibility: bundle.compatibility,
    plan: bundle.plan,
    artifactRoot: args.artifacts,
    applicationId,
    onLog: async (line) => process.stderr.write(`${line}\n`),
  });
  let codex = null;
  if (args.mode === "ai") {
    const temporary = await mkdtemp(join(tmpdir(), "design-apply-cli-"));
    const analysisPath = join(temporary, "analysis.json");
    await writeFile(analysisPath, `${JSON.stringify(bundle.analysis, null, 2)}\n`);
    try {
      codex = await runCodexAdaptation({
        targetPath: bundle.analysis.targetPath,
        studioRoot: repoRoot,
        artifactRoot: resolve(args.artifacts),
        analysisPath,
        onLog: async (line) => process.stderr.write(`${line}\n`),
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const verification = await verifyDesignSystem({
    targetPath: bundle.analysis.targetPath,
    expectedManifestSha256: install.manifestSha256,
    onLog: async (line) => process.stderr.write(`${line}\n`),
  });
  printResult({
    ok: true,
    mode: args.mode,
    applicationId,
    analysis: bundle.analysis,
    compatibility: bundle.compatibility,
    plan: bundle.plan,
    result: { ...install, codex, verification },
  });
} catch (error) {
  printFailure(error);
}
