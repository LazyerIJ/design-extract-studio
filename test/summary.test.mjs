import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignSummary } from "../lib/summary.mjs";

const MARKDOWN = `# Design Language: Example
> Extracted from \`https://example.com\` on 2026-06-14
> 321 elements analyzed

### Primary Colors
| Role | Value |
|---|---|
| Background | \`#050505\` |
| Accent | \`#FF2A2A\` |

### Font Families
- **Geist Sans**
- **Geist Mono**

**Base unit:** 2px

### Buttons (16 instances)
### Cards (8 instances)

**Overall Score: 83%** — 25 passing, 5 failing color pairs
**Overall: 72/100 (Grade: C)**
`;

test("parseDesignSummary extracts score, WCAG, tokens, and patterns", () => {
  const summary = parseDesignSummary(MARKDOWN);
  assert.equal(summary.title, "Example");
  assert.equal(summary.sourceUrl, "https://example.com");
  assert.equal(summary.elementsAnalyzed, 321);
  assert.equal(summary.designScore, 72);
  assert.equal(summary.grade, "C");
  assert.equal(summary.wcagScore, 83);
  assert.equal(summary.wcagPassing, 25);
  assert.equal(summary.wcagFailing, 5);
  assert.equal(summary.spacingBase, 2);
  assert.deepEqual(summary.colors, [
    { role: "Background", value: "#050505" },
    { role: "Accent", value: "#FF2A2A" },
  ]);
  assert.deepEqual(summary.fonts, ["Geist Sans", "Geist Mono"]);
  assert.deepEqual(summary.componentPatterns, [
    { name: "Buttons", count: 16 },
    { name: "Cards", count: 8 },
  ]);
});

test("parseDesignSummary preserves partial results when sections are absent", () => {
  const summary = parseDesignSummary("# Design Language: Partial");
  assert.equal(summary.title, "Partial");
  assert.equal(summary.designScore, null);
  assert.deepEqual(summary.colors, []);
});
