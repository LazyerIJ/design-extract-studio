// Minimal Chrome DevTools Protocol client — zero npm dependencies.
// Uses the global WebSocket shipped with Node >= 22 and drives the system
// Chrome that designlang already requires. Only the surface we need:
// launch, connect, send (with optional flat session id), and event waiting.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Abortable sleep — rejects with the signal's reason the moment it fires so a
// cancel/timeout during a wait unwinds immediately instead of stranding Chrome.
export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function chromeExecutable(config = {}) {
  return config.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME;
}

// Launch headless Chrome with an ephemeral profile and a self-assigned debug
// port. Chrome writes the chosen port + ws path to DevToolsActivePort once the
// endpoint is live, so we poll that file instead of parsing stderr.
export async function launchChrome(chromePath, { signal } = {}) {
  if (signal?.aborted) throw signal.reason;
  const userDataDir = await mkdtemp(join(tmpdir(), "dls-layout-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ];
  const child = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });

  // Kill Chrome + drop the profile, then surface why we bailed. The caller's
  // finally also kills the child once we return ok, so success needs no cleanup.
  const fail = async (error) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  };

  // Chrome writes the port + ws path to DevToolsActivePort once live; an abort
  // (cancel/timeout/shutdown) during the wait unwinds via the abortable delay.
  const portFile = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 100; i += 1) {
    if (signal?.aborted) return fail(signal.reason);
    if (child.exitCode !== null) break;
    try {
      const [port, path] = (await readFile(portFile, "utf8")).split("\n");
      if (port && path) {
        return { child, wsUrl: `ws://127.0.0.1:${port.trim()}${path.trim()}`, userDataDir };
      }
    } catch {
      // not written yet
    }
    try {
      await delay(100, signal);
    } catch (error) {
      return fail(error);
    }
  }
  return fail(
    new Error(`Chrome did not expose a DevTools endpoint${stderr ? `: ${stderr.slice(-300)}` : ""}`),
  );
}

export class CDPConnection {
  constructor(ws, signal) {
    this.ws = ws;
    this.signal = signal;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
    // Abort fails all in-flight + future calls and tears the socket down so the
    // extractor unwinds to its finally block (Chrome kill) without waiting.
    this.#onAbort = () => {
      const reason = signal?.reason ?? new Error("CDP connection aborted");
      for (const { reject } of this.pending.values()) reject(reason);
      this.pending.clear();
      this.close();
    };
    signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  #onAbort;

  static async connect(wsUrl, { signal } = {}) {
    if (signal?.aborted) throw signal.reason;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("CDP socket error"));
      }, { once: true });
    });
    return new CDPConnection(ws, signal);
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.signal?.aborted) return Promise.reject(this.signal.reason);
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  // Resolve on the next matching protocol event (optionally scoped to a flat
  // session), with a timeout so a stalled page can't hang the run.
  waitForEvent(method, { sessionId, timeoutMs = 15000 } = {}) {
    if (this.signal?.aborted) return Promise.reject(this.signal.reason);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        cleanup();
        reject(this.signal.reason);
      };
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        cleanup();
        resolve(message.params);
      };
      this.listeners.add(listener);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close() {
    this.signal?.removeEventListener("abort", this.#onAbort);
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
