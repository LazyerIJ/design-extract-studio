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
        dom: "main",
        rect: { x: 0, y: 0, w: 1440, h: 1800 },
        display: "grid",
        grid: { columns: 3, template: "1fr 1fr 1fr", gap: "24px", justify: "normal" },
        childCount: 1,
        children: [
          {
            tag: "section",
            dom: "main>section",
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
        dom: "main",
        rect: { x: 0, y: 0, w: 390, h: 2400 },
        display: "grid",
        grid: { columns: 1, template: "1fr", gap: "16px", justify: "normal" },
        childCount: 1,
        children: [
          {
            tag: "section",
            dom: "main>section",
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
  // The real computed template is preserved verbatim, not flattened to repeat().
  assert.match(css, /display: grid; grid-template-columns: 1fr 1fr 1fr/);
  assert.doesNotMatch(css, /repeat\(/);
  assert.match(css, /@media \(max-width: 390px\)/);
  // grid collapses 3col -> 1col and flex row -> column at mobile
  assert.match(css, /grid-template-columns: 1fr;/);
  assert.match(css, /flex-direction: column/);
});

test("asymmetric grid tracks are preserved, not flattened to 1fr columns", () => {
  const capture = {
    generatedAt: "2026-06-15T00:00:00.000Z",
    url: "https://example.com/",
    breakpoints: {
      desktop: {
        width: 1440,
        height: 900,
        scrollHeight: 1000,
        tree: {
          tag: "main",
          dom: "main",
          // 240px sidebar + fluid content — the exact shape the old code
          // destroyed by emitting repeat(2, 1fr).
          grid: { columns: 2, template: "240px minmax(0, 760px)", gap: "24px" },
          rect: { x: 0, y: 0, w: 1440, h: 1000 },
          children: [],
        },
      },
    },
  };
  const css = generateLayoutArtifacts(capture, "site")["site-layout.css"];
  assert.match(css, /grid-template-columns: 240px minmax\(0, 760px\)/);
  assert.doesNotMatch(css, /repeat\(2, 1fr\)/);
});

test("cross-breakpoint matching uses DOM identity, never filtered position", () => {
  // Desktop: a sidebar grid + a content flex side by side. Mobile drops the
  // sidebar entirely, so the content node slides into position 0. Position-based
  // matching would graft the content's rule onto the sidebar; DOM matching must
  // instead leave the unmatched sidebar alone and report it.
  const capture = {
    generatedAt: "2026-06-15T00:00:00.000Z",
    url: "https://example.com/",
    breakpoints: {
      desktop: {
        width: 1440,
        height: 900,
        scrollHeight: 1000,
        tree: {
          tag: "main",
          dom: "main",
          grid: { columns: 2, template: "240px 1fr", gap: "24px" },
          rect: { x: 0, y: 0, w: 1440, h: 1000 },
          children: [
            {
              tag: "aside",
              dom: "main>aside.sidebar",
              cls: ["sidebar"],
              grid: { columns: 1, template: "1fr", gap: "8px" },
              rect: { x: 0, y: 0, w: 240, h: 800 },
              children: [],
            },
            {
              tag: "section",
              dom: "main>section.content",
              cls: ["content"],
              flex: { direction: "row", gap: "16px" },
              rect: { x: 264, y: 0, w: 1176, h: 800 },
              children: [],
            },
          ],
        },
      },
      mobile: {
        width: 390,
        height: 844,
        scrollHeight: 1400,
        tree: {
          tag: "main",
          dom: "main",
          grid: { columns: 1, template: "1fr", gap: "12px" },
          rect: { x: 0, y: 0, w: 390, h: 1400 },
          children: [
            // sidebar is gone; content is now the first (and only) child
            {
              tag: "section",
              dom: "main>section.content",
              cls: ["content"],
              flex: { direction: "column", gap: "16px" },
              rect: { x: 0, y: 0, w: 390, h: 800 },
              children: [],
            },
          ],
        },
      },
    },
  };
  const css = generateLayoutArtifacts(capture, "site")["site-layout.css"];
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 390px)"));
  const sidebarCls = "lyt-0-0";
  const contentCls = "lyt-0-1";
  // The content node really did go row -> column; that override must land.
  assert.match(mobileBlock, new RegExp(`\\.${contentCls} \\{[^}]*flex-direction: column`));
  // The sidebar is absent at mobile and must NOT inherit the content's flex
  // rule (the bug). It is reported as an unmatched container instead.
  assert.doesNotMatch(
    mobileBlock,
    new RegExp(`\\.${sidebarCls} \\{[^}]*flex-direction: column`),
  );
  assert.match(css, /limitations: \d+ tablet \+ \d+ mobile container/);
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

test("repeated siblings with one conditionally removed are ambiguous → not mismatched", () => {
  // Desktop: two identical section.card. Mobile: the FIRST is removed. A
  // positional/nth signature would let the survivor collide with desktop's
  // first card; pure-ancestry signatures make both cards share one signature →
  // ambiguous → skipped, never given the wrong responsive rule.
  const card = (flexDir, x) => ({
    tag: "section", dom: "main>section.card", cls: ["card"],
    flex: { direction: flexDir, gap: "8px" }, rect: { x, y: 0, w: 700, h: 400 }, children: [],
  });
  const capture = {
    generatedAt: "2026-06-15T00:00:00.000Z",
    url: "https://example.com/",
    breakpoints: {
      desktop: { width: 1440, height: 900, scrollHeight: 1000, tree: {
        tag: "main", dom: "main", grid: { columns: 2, template: "1fr 1fr", gap: "16px" },
        rect: { x: 0, y: 0, w: 1440, h: 1000 }, children: [card("row", 0), card("row", 720)],
      } },
      mobile: { width: 390, height: 844, scrollHeight: 1400, tree: {
        tag: "main", dom: "main", grid: { columns: 1, template: "1fr", gap: "12px" },
        rect: { x: 0, y: 0, w: 390, h: 1400 }, children: [card("column", 0)], // first removed
      } },
    },
  };
  const css = generateLayoutArtifacts(capture, "site")["site-layout.css"];
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 390px)"));
  // Neither card class may inherit the survivor's column rule (the bug).
  assert.doesNotMatch(mobileBlock, /\.lyt-0-0 \{[^}]*flex-direction: column/);
  assert.doesNotMatch(mobileBlock, /\.lyt-0-1 \{[^}]*flex-direction: column/);
  // Ambiguous cards are reported, and the unique parent still gets its override.
  assert.match(css, /limitations:/);
  assert.match(mobileBlock, /\.lyt-0 \{[^}]*grid-template-columns: 1fr/);
});

test("a hostile URL cannot break out of the CSS comment", () => {
  const capture = {
    generatedAt: "2026-06-15T00:00:00.000Z",
    url: "https://evil.example/*/}body{display:none}/*",
    breakpoints: { desktop: { width: 1440, height: 900, scrollHeight: 1000, tree: {
      tag: "main", dom: "main", grid: { columns: 1, template: "1fr" },
      rect: { x: 0, y: 0, w: 1440, h: 1000 }, children: [],
    } } },
  };
  const css = generateLayoutArtifacts(capture, "evil")["evil-layout.css"];
  // The "*/" inside the URL must be neutralised so it can't terminate the
  // comment and inject a real rule.
  assert.doesNotMatch(css, /\*\/\}body\{display:none\}/);
});
