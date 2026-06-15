// Pipeline step that bolts layout extraction onto the existing designlang run.
// Non-fatal by contract: any failure here is logged and surfaced as a status,
// never thrown, so the original design-system extraction result is preserved.

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractLayout, DEFAULT_BREAKPOINTS } from "./layout-extractor.mjs";
import { generateLayoutArtifacts } from "./layout-artifacts.mjs";

// Reuse designlang's own file prefix (e.g. "stripe-com") so layout artifacts
// sit alongside its output; fall back to a hostname slug.
async function derivePrefix(artifactDir, url) {
  try {
    const names = await readdir(artifactDir);
    const anchor = names.find((name) => name.endsWith("-design-language.md"));
    if (anchor) return anchor.slice(0, -"-design-language.md".length);
  } catch {
    // fall through to hostname
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
  } catch {
    return "site";
  }
}

export async function runLayoutExtraction(
  job,
  config,
  hooks,
  { extract = extractLayout } = {},
) {
  // Opt-in: run only when the capability is enabled AND the job explicitly
  // requested layout (options.layout === true). Omitted/false → skip.
  if (!config.enableLayoutExtraction || job.options?.layout !== true) {
    return { status: "disabled" };
  }

  // Cancel/shutdown (hooks.signal) and the per-job timeout share one signal, so
  // an abort from either source unwinds the CDP connection, the in-page waits,
  // and the Chrome child all the way down — nothing is left running.
  const parent = hooks.signal;
  const timeout = AbortSignal.timeout(config.layoutTimeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;

  const prefix = await derivePrefix(hooks.artifactDir, job.url);
  try {
    const data = await extract({
      url: job.url,
      config,
      breakpoints: DEFAULT_BREAKPOINTS,
      onLog: hooks.onLog,
      onProgress: async () => {},
      signal,
    });

    const artifacts = generateLayoutArtifacts(data, prefix);
    const files = [];
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(hooks.artifactDir, name), content, "utf8");
      files.push(name);
    }

    const breakpoints = Object.entries(data.breakpoints).map(([name, value]) => ({
      name,
      width: value.width,
      nodes: value.nodeCount,
      scrollHeight: value.scrollHeight,
    }));
    await hooks.onLog(
      `[layout] wrote ${files.length} artifacts across ${breakpoints.length} breakpoints`,
    );
    return { status: "succeeded", prefix, files, breakpoints };
  } catch (error) {
    // A cancel/shutdown must fail the whole job (not be swallowed as a layout
    // warning), so re-throw when the *parent* signal fired. A timeout or a
    // genuine extraction error stays non-fatal by contract.
    if (parent?.aborted) {
      const cancelled = new Error("Layout extraction cancelled");
      cancelled.code = "JOB_CANCELLED";
      throw cancelled;
    }
    const reason = timeout.aborted
      ? `Layout extraction timed out after ${config.layoutTimeoutMs}ms`
      : error.message;
    await hooks.onLog(`[layout] extraction skipped: ${reason}`);
    return { status: "failed", error: String(reason ?? error).slice(0, 500) };
  }
}
