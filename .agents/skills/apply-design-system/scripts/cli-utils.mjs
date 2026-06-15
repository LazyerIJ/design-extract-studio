export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) values[key] = true;
    else {
      values[key] = next;
      index += 1;
    }
  }
  return values;
}

export function requireArgs(args, names) {
  for (const name of names) {
    if (typeof args[name] !== "string" || !args[name]) {
      throw Object.assign(new Error(`--${name} is required`), {
        code: "CLI_ARGUMENT_REQUIRED",
      });
    }
  }
}

export function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printFailure(error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: error.code ?? "CLI_FAILED",
        message: String(error.message ?? error),
      },
    }, null, 2)}\n`,
  );
  process.exitCode = 1;
}
