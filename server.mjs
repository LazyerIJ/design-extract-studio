import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "./lib/config.mjs";
import { JobManager } from "./lib/job-manager.mjs";
import { JobStore } from "./lib/store.mjs";
import { createDesignlangRunner } from "./lib/runner.mjs";
import { createAppServer } from "./lib/http.mjs";
import { ApplicationStore } from "./lib/application-store.mjs";
import { ApplicationManager } from "./lib/application-manager.mjs";

const config = createConfig();
await mkdir(config.npmCache, { recursive: true });
const serverStateDir = join(config.projectDir, ".server");
const pidPath = join(serverStateDir, "server.pid");
await mkdir(serverStateDir, { recursive: true });
const temporaryPidPath = `${pidPath}.${process.pid}.tmp`;
await writeFile(temporaryPidPath, `${process.pid}\n`, { mode: 0o600 });
await rename(temporaryPidPath, pidPath);

const store = new JobStore(config.jobsDir);
const manager = new JobManager({
  config,
  store,
  runner: createDesignlangRunner(config),
});
await manager.initialize();

const applicationStore = new ApplicationStore(config.applicationsDir);
const applicationManager = new ApplicationManager({
  config,
  store: applicationStore,
  extractionManager: manager,
});
await applicationManager.initialize();

const server = createAppServer({ config, manager, applicationManager });
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}; stopping jobs and HTTP server`);
  const closed = new Promise((resolve) => server.close(resolve));
  await applicationManager.shutdown();
  await manager.shutdown();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  const recordedPid = await readFile(pidPath, "utf8").catch(() => "");
  if (recordedPid.trim() === String(process.pid)) {
    await rm(pidPath, { force: true });
  }
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
  console.log(`[server] Applications: ${config.applicationsDir}`);
  console.log(`[server] designlang npm cache: ${config.npmCache}`);
  console.log(
    `[server] Optional Codex analysis: ${config.enableCodexAnalysis ? "enabled" : "disabled"}`,
  );
});

export { applicationManager, config, manager, server };
