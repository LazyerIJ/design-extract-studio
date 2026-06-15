import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function createConfig(overrides = {}) {
  const projectDir = resolve(overrides.projectDir ?? PROJECT_DIR);
  const jobsDir = resolve(overrides.jobsDir ?? join(projectDir, "jobs"));
  const applicationsDir = resolve(
    overrides.applicationsDir ?? join(projectDir, "applications"),
  );
  const sourceAssetsDir = resolve(
    overrides.sourceAssetsDir ?? join(projectDir, "..", "designlang-test-output"),
  );

  return {
    projectDir,
    jobsDir,
    applicationsDir,
    sourceAssetsDir,
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port:
      overrides.port ??
      integerEnv("PORT", 4219, 1, 65535),
    maxConcurrentJobs:
      overrides.maxConcurrentJobs ??
      integerEnv("MAX_CONCURRENT_JOBS", 1, 1, 4),
    maxJobHistory:
      overrides.maxJobHistory ??
      integerEnv("MAX_JOB_HISTORY", 100, 10, 1000),
    npmCache: resolve(
      overrides.npmCache ??
        process.env.DESIGNLANG_NPM_CACHE ??
        "/private/tmp/designlang-npm-cache",
    ),
    enableCodexAnalysis:
      overrides.enableCodexAnalysis ??
      process.env.ENABLE_CODEX_ANALYSIS === "1",
    codexAnalysisTimeoutMs:
      overrides.codexAnalysisTimeoutMs ??
      integerEnv("CODEX_ANALYSIS_TIMEOUT_MS", 120000, 10000, 600000),
    codexApplyTimeoutMs:
      overrides.codexApplyTimeoutMs ??
      integerEnv("CODEX_APPLY_TIMEOUT_MS", 300000, 30000, 1800000),
    applyCommandTimeoutMs:
      overrides.applyCommandTimeoutMs ??
      integerEnv("APPLY_COMMAND_TIMEOUT_MS", 120000, 10000, 900000),
    bodyLimitBytes: overrides.bodyLimitBytes ?? 16 * 1024,
  };
}
