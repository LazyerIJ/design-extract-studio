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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runLayoutExtraction(job, config, hooks) {
  if (!config.enableLayoutExtraction || job.options?.layout === false) {
    return { status: "disabled" };
  }

  const prefix = await derivePrefix(hooks.artifactDir, job.url);
  try {
    const data = await withTimeout(
      extractLayout({
        url: job.url,
        config,
        breakpoints: DEFAULT_BREAKPOINTS,
        onLog: hooks.onLog,
        onProgress: async () => {},
      }),
      config.layoutTimeoutMs,
      "Layout extraction",
    );

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
    await hooks.onLog(`[layout] extraction skipped: ${error.message}`);
    return { status: "failed", error: String(error.message ?? error).slice(0, 500) };
  }
}
