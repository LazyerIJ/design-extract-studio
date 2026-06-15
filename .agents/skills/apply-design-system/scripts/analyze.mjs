import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeApplyRequest } from "../../../../lib/project-analysis.mjs";
import {
  parseArgs,
  printFailure,
  printResult,
  requireArgs,
} from "./cli-utils.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

try {
  const args = parseArgs(process.argv.slice(2));
  requireArgs(args, ["target", "artifacts"]);
  const result = await analyzeApplyRequest({
    targetPath: args.target,
    artifactRoot: args.artifacts,
    studioRoot: repoRoot,
  });
  printResult({ ok: true, ...result });
} catch (error) {
  printFailure(error);
}
