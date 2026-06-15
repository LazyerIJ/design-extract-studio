import { spawn } from "node:child_process";

const TARGET_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "COLORTERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

export function processError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function createTargetProcessEnv(overrides = {}) {
  const env = {};
  for (const name of TARGET_ENV_ALLOWLIST) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

export async function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    inheritEnv = true,
    timeoutMs = 30000,
    signal,
    onOutput,
    maxOutputBytes = 256 * 1024,
  } = options;

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? { ...process.env, ...env } : { ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (source, chunk) => {
      const text = chunk.toString("utf8");
      if (source === "stdout") stdout = `${stdout}${text}`.slice(-maxOutputBytes);
      else stderr = `${stderr}${text}`.slice(-maxOutputBytes);
      onOutput?.(source, text);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2500);
      force.unref();
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(
        processError(error.message, error.code === "ENOENT" ? "COMMAND_NOT_FOUND" : "PROCESS_ERROR", {
          command,
          cause: error,
        }),
      );
    });
    child.on("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(processError("Process cancelled", "PROCESS_CANCELLED", { command }));
        return;
      }
      if (timedOut) {
        reject(processError(`Process timed out after ${timeoutMs}ms`, "PROCESS_TIMEOUT", {
          command,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ command, args, exitCode, signal: exitSignal, stdout, stderr });
    });
  });
}

export async function commandAvailable(command) {
  try {
    const result = await runProcess(command, ["--version"], { timeoutMs: 10000 });
    return { available: result.exitCode === 0, version: result.stdout.trim() || result.stderr.trim() };
  } catch (error) {
    return { available: false, error: error.message };
  }
}
