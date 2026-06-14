import { mkdir } from "node:fs/promises";
import { createConfig } from "./lib/config.mjs";
import { JobManager } from "./lib/job-manager.mjs";
import { JobStore } from "./lib/store.mjs";
import { createDesignlangRunner } from "./lib/runner.mjs";
import { createAppServer } from "./lib/http.mjs";

const config = createConfig();
await mkdir(config.npmCache, { recursive: true });

const store = new JobStore(config.jobsDir);
const manager = new JobManager({
  config,
  store,
  runner: createDesignlangRunner(config),
});
await manager.initialize();

const server = createAppServer({ config, manager });
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}; stopping jobs and HTTP server`);
  const closed = new Promise((resolve) => server.close(resolve));
  await manager.shutdown();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  process.exitCode = 0;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal));
}

server.listen(config.port, config.host, () => {
  const address = server.address();
  console.log(
    `[server] Design Extract Studio listening on http://${config.host}:${address.port}`,
  );
  console.log(`[server] Jobs: ${config.jobsDir}`);
  console.log(`[server] designlang npm cache: ${config.npmCache}`);
  console.log(
    `[server] Optional Codex analysis: ${config.enableCodexAnalysis ? "enabled" : "disabled"}`,
  );
});

export { config, manager, server };
