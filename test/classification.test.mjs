import assert from "node:assert/strict";
import test from "node:test";
import { classifyArtifact } from "../lib/artifact-classification.mjs";

test("artifact classification recognizes prefixed and nested designlang outputs", () => {
  const language = classifyArtifact("site-design-language.md");
  assert.equal(language.type, "핵심 디자인 보고서");
  assert.equal(language.categories.includes("start"), true);
  assert.equal(language.categories.includes("ai"), true);

  const prompt = classifyArtifact("site-prompts/v0.txt");
  assert.equal(prompt.type, "AI 재현 프롬프트");
  assert.deepEqual(prompt.categories, ["ai"]);

  const screenshot = classifyArtifact("screenshots/button-primary.png");
  assert.equal(screenshot.type, "이미지");
  assert.equal(screenshot.categories.includes("images"), true);

  const variables = classifyArtifact("nested/site-variables.css");
  assert.equal(variables.type, "CSS 변수");
  assert.equal(variables.categories.includes("start"), true);
  assert.equal(variables.categories.includes("developer"), true);
});

test("artifact classification covers developer, designer, and report outputs", () => {
  assert.equal(
    classifyArtifact("site-tailwind.config.js").categories.includes("developer"),
    true,
  );
  assert.equal(
    classifyArtifact("site-figma-variables.json").categories.includes("designer"),
    true,
  );
  assert.equal(
    classifyArtifact("site-stack-intel.json").categories.includes("reports"),
    true,
  );
  assert.equal(classifyArtifact("site-voice.json").categories.includes("ai"), true);
});
