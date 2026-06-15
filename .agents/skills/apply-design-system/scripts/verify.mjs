import { verifyDesignSystem } from "../../../../lib/design-apply.mjs";
import {
  parseArgs,
  printFailure,
  printResult,
  requireArgs,
} from "./cli-utils.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  requireArgs(args, ["target"]);
  const result = await verifyDesignSystem({
    targetPath: args.target,
    runCommands: args["skip-commands"] !== true,
    onLog: async (line) => process.stderr.write(`${line}\n`),
  });
  printResult({ ok: true, result });
} catch (error) {
  printFailure(error);
}
