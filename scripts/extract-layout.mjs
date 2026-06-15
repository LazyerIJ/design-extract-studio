// Standalone layout extraction CLI — also the entry the job pipeline reuses.
// Usage: node scripts/extract-layout.mjs <url> [outDir] [namePrefix]
//   node scripts/extract-layout.mjs https://stripe.com /tmp/out stripe-com

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractLayout } from "../lib/layout-extractor.mjs";
import { generateLayoutArtifacts } from "../lib/layout-artifacts.mjs";

async function main() {
  const [url, outDir = "/tmp/layout-out", prefix = "site"] = process.argv.slice(2);
  if (!url) {
    console.error("usage: node scripts/extract-layout.mjs <url> [outDir] [prefix]");
    process.exit(1);
  }
  await mkdir(outDir, { recursive: true });
  const data = await extractLayout({
    url,
    onLog: (line) => console.log(line),
    onProgress: (pct, msg) => console.log(`[layout] ${pct}% ${msg}`),
  });

  const artifacts = generateLayoutArtifacts(data, prefix);
  for (const [name, content] of Object.entries(artifacts)) {
    await writeFile(join(outDir, name), content, "utf8");
    console.log(`wrote ${name} (${content.length} bytes)`);
  }
  console.log("\nbreakpoints:");
  for (const [bp, v] of Object.entries(data.breakpoints)) {
    console.log(`  ${bp.padEnd(8)} ${v.width}px  nodes=${v.nodeCount} scrollH=${v.scrollHeight}`);
  }
}

main().catch((error) => {
  console.error("layout extraction failed:", error.message);
  process.exit(1);
});
