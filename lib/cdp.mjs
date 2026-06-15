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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chromeExecutable(config = {}) {
  return config.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME;
}

// Launch headless Chrome with an ephemeral profile and a self-assigned debug
// port. Chrome writes the chosen port + ws path to DevToolsActivePort once the
// endpoint is live, so we poll that file instead of parsing stderr.
export async function launchChrome(chromePath) {
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

  const portFile = join(userDataDir, "DevToolsActivePort");
  let wsUrl = null;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const text = await readFile(portFile, "utf8");
      const [port, path] = text.split("\n");
      if (port && path) {
        wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
        break;
      }
    } catch {
      // not written yet
    }
    await delay(100);
  }

  if (!wsUrl) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error(
      `Chrome did not expose a DevTools endpoint${stderr ? `: ${stderr.slice(-300)}` : ""}`,
    );
  }
  return { child, wsUrl, userDataDir };
}

export class CDPConnection {
  constructor(ws) {
    this.ws = ws;
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
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket error")), {
        once: true,
      });
    });
    return new CDPConnection(ws);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
