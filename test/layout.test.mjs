import assert from "node:assert/strict";
import test from "node:test";
import { generateLayoutArtifacts } from "../lib/layout-artifacts.mjs";
import { classifyArtifact } from "../lib/artifact-classification.mjs";

// A tiny two-breakpoint capture: a 3-col grid on desktop that collapses to a
// single column on mobile — exactly the responsive delta the feature exists to
// surface.
const CAPTURE = {
  generatedAt: "2026-06-15T00:00:00.000Z",
  url: "https://example.com/",
  breakpoints: {
    desktop: {
      width: 1440,
      height: 900,
      scrollHeight: 1800,
      nodeCount: 2,
      tree: {
        tag: "main",
        rect: { x: 0, y: 0, w: 1440, h: 1800 },
        display: "grid",
        grid: { columns: 3, template: "1fr 1fr 1fr", gap: "24px", justify: "normal" },
        childCount: 1,
        children: [
          {
            tag: "section",
            rect: { x: 0, y: 0, w: 480, h: 300 },
            display: "flex",
            flex: { direction: "row", wrap: "nowrap", justify: "center", align: "center", gap: "8px" },
            childCount: 0,
            children: [],
          },
        ],
      },
    },
    mobile: {
      width: 390,
      height: 844,
      scrollHeight: 2400,
      nodeCount: 2,
      tree: {
        tag: "main",
        rect: { x: 0, y: 0, w: 390, h: 2400 },
        display: "grid",
        grid: { columns: 1, template: "1fr", gap: "16px", justify: "normal" },
        childCount: 1,
        children: [
          {
            tag: "section",
            rect: { x: 0, y: 0, w: 390, h: 300 },
            display: "flex",
            flex: { direction: "column", wrap: "nowrap", justify: "center", align: "center", gap: "8px" },
            childCount: 0,
            children: [],
          },
        ],
      },
    },
  },
};

test("generateLayoutArtifacts emits the four layout files", () => {
  const out = generateLayoutArtifacts(CAPTURE, "example-com");
  assert.deepEqual(Object.keys(out).sort(), [
    "example-com-layout-skeleton.html",
    "example-com-layout.css",
    "example-com-layout.json",
    "example-com-wireframe.svg",
  ]);
  assert.equal(JSON.parse(out["example-com-layout.json"]).url, "https://example.com/");
});

test("layout.css encodes the desktop base and a responsive override", () => {
  const css = generateLayoutArtifacts(CAPTURE, "example-com")["example-com-layout.css"];
  assert.match(css, /display: grid; grid-template-columns: repeat\(3, 1fr\)/);
  assert.match(css, /@media \(max-width: 390px\)/);
  // grid collapses 3col -> 1col and flex row -> column at mobile
  assert.match(css, /grid-template-columns: 1fr/);
  assert.match(css, /flex-direction: column/);
});

test("skeleton uses semantic tags and links the css", () => {
  const html = generateLayoutArtifacts(CAPTURE, "example-com")["example-com-layout-skeleton.html"];
  assert.match(html, /<main class="lyt-0"/);
  assert.match(html, /<section/);
  assert.match(html, /example-com-layout\.css/);
});

test("wireframe is a valid svg root", () => {
  const svg = generateLayoutArtifacts(CAPTURE, "example-com")["example-com-wireframe.svg"];
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
});

test("classifyArtifact routes layout files before the image rule", () => {
  assert.equal(classifyArtifact("site-wireframe.svg").type, "레이아웃");
  assert.ok(classifyArtifact("site-wireframe.svg").categories.includes("layout"));
  assert.equal(classifyArtifact("site-layout.json").type, "레이아웃");
  assert.equal(classifyArtifact("site-layout.css").type, "레이아웃");
  assert.equal(classifyArtifact("site-layout-skeleton.html").type, "레이아웃");
  // a normal screenshot still classifies as image
  assert.equal(classifyArtifact("screenshots/nav.png").type, "이미지");
});
