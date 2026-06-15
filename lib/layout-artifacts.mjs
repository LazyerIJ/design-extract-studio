// Turn the per-breakpoint layout trees into shippable artifacts:
//   <prefix>-layout.json       full machine-readable capture
//   <prefix>-wireframe.svg     scaled vector wireframe of the desktop tree
//   <prefix>-layout-skeleton.html  semantic HTML reconstruction
//   <prefix>-layout.css        responsive grid/flex CSS with @media overrides
// Everything is derived from data the page actually computed — no guessing.

const BP_ORDER = ["desktop", "tablet", "mobile"];

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function labelOf(node) {
  const base = node.role ? `${node.tag}·${node.role}` : node.tag;
  if (node.cls?.length) return `${base} .${node.cls[0]}`;
  if (node.id) return `${base} #${node.id}`;
  return base;
}

function layoutKind(node) {
  if (node.grid) return `grid ${node.grid.columns}col`;
  if (node.flex) {
    const dir = node.flex.direction?.startsWith("col") ? "col" : "row";
    return `flex ${dir}`;
  }
  return "block";
}

// Stable CSS class name per node in the desktop tree (naming only — the tree
// position is a fine identifier *within* one breakpoint).
function annotate(node, path = "0") {
  if (!node) return;
  node._path = path;
  node._cls = `lyt-${path.replace(/\./g, "-")}`;
  (node.children ?? []).forEach((child, i) => annotate(child, `${path}.${i}`));
}

// Index a breakpoint tree by its stable DOM signature so we can cross-match the
// *same* element at another viewport regardless of which siblings were hidden,
// reordered, or reflowed. Falling back to tree position (the old behaviour)
// mismatched boxes whenever the filtered child order diverged between widths.
function indexByDom(tree) {
  const byDom = new Map();
  const all = [];
  (function walk(node) {
    if (!node) return;
    all.push(node);
    if (node.dom && !byDom.has(node.dom)) byDom.set(node.dom, node);
    (node.children ?? []).forEach(walk);
  })(tree);
  return { byDom, all };
}

function classSet(node) {
  return new Set(node.cls ?? []);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Match a desktop node to its counterpart in another breakpoint, returning a
// confidence in [0,1]. Exact DOM-signature match is fully trusted; otherwise we
// only fall back to a single unambiguous tag+class candidate, and report low
// confidence so the caller can decline to emit speculative CSS.
function matchNode(node, index) {
  if (node.dom && index.byDom.has(node.dom)) {
    return { match: index.byDom.get(node.dom), confidence: 1 };
  }
  if (!node.dom) {
    // Legacy capture without DOM signatures — fall back to tree position.
    const byPath = getByPath(index.tree, node._path);
    return byPath ? { match: byPath, confidence: 0.5 } : { match: null, confidence: 0 };
  }
  const wantCls = classSet(node);
  const candidates = index.all.filter(
    (other) => other.tag === node.tag && other.role === node.role,
  );
  let best = null;
  let bestScore = 0;
  for (const other of candidates) {
    const score = 0.4 + 0.6 * jaccard(wantCls, classSet(other));
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }
  // Require an unambiguous, class-corroborated candidate; otherwise decline.
  const tied = candidates.filter(
    (o) => 0.4 + 0.6 * jaccard(wantCls, classSet(o)) >= bestScore - 1e-9,
  ).length;
  if (best && tied === 1 && bestScore >= 0.7) {
    return { match: best, confidence: bestScore };
  }
  return { match: null, confidence: 0 };
}

function getByPath(tree, path) {
  if (!tree || !path) return null;
  const parts = path.split(".").slice(1).map(Number);
  let cur = tree;
  for (const i of parts) {
    cur = cur.children?.[i];
    if (!cur) return null;
  }
  return cur;
}

// Real computed track list when we have it (e.g. "240px 760px", "minmax(0,1fr)
// 320px"); only synthesise equal columns when the page didn't expose a
// template, so asymmetric grids aren't flattened to repeat(n, 1fr).
function gridColumns(grid) {
  if (grid.template && grid.template !== "none") return grid.template;
  return grid.columns > 1 ? `repeat(${grid.columns}, 1fr)` : "1fr";
}

function containerDecls(node) {
  if (node.grid) {
    return [
      "display: grid",
      `grid-template-columns: ${gridColumns(node.grid)}`,
      node.grid.gap && node.grid.gap !== "normal" ? `gap: ${node.grid.gap}` : null,
    ].filter(Boolean);
  }
  if (node.flex) {
    return [
      "display: flex",
      `flex-direction: ${node.flex.direction || "row"}`,
      node.flex.wrap && node.flex.wrap !== "nowrap" ? `flex-wrap: ${node.flex.wrap}` : null,
      node.flex.justify && node.flex.justify !== "normal" ? `justify-content: ${node.flex.justify}` : null,
      node.flex.align && node.flex.align !== "normal" ? `align-items: ${node.flex.align}` : null,
      node.flex.gap && node.flex.gap !== "normal" ? `gap: ${node.flex.gap}` : null,
    ].filter(Boolean);
  }
  return null;
}

function isContainer(node) {
  return Boolean(node.grid || node.flex);
}

// ---- responsive CSS ---------------------------------------------------------

function buildCss(data, prefix) {
  const desktop = data.breakpoints.desktop?.tree || firstTree(data);
  if (!desktop) return `/* no layout tree captured for ${prefix} */\n`;
  annotate(desktop);

  const base = [];
  const containers = [];
  (function collect(node) {
    if (!node) return;
    if (isContainer(node)) {
      const decls = containerDecls(node);
      if (decls) {
        base.push(`.${node._cls} { ${decls.join("; ")}; }`);
        containers.push(node);
      }
    }
    (node.children ?? []).forEach(collect);
  })(desktop);

  const media = { tablet: [], mobile: [] };
  const skipped = { tablet: 0, mobile: 0 };
  for (const bpName of ["tablet", "mobile"]) {
    const tree = data.breakpoints[bpName]?.tree;
    if (!tree) continue;
    const index = { ...indexByDom(tree), tree };
    for (const node of containers) {
      const { match, confidence } = matchNode(node, index);
      if (!match) {
        // We couldn't confidently locate this box at this width — don't guess a
        // responsive rule (the old position-based match invented wrong ones).
        skipped[bpName] += 1;
        continue;
      }
      if (!isContainer(match)) {
        // Confidently matched, but it's no longer a flex/grid container here →
        // it genuinely collapsed to normal flow.
        media[bpName].push(`  .${node._cls} { display: block; }`);
        continue;
      }
      const before = containerDecls(node).join("; ");
      const after = containerDecls(match).join("; ");
      if (before !== after) {
        const note = confidence < 1 ? ` /* ~${Math.round(confidence * 100)}% match */` : "";
        media[bpName].push(`  .${node._cls} { ${after}; }${note}`);
      }
    }
  }

  const limitation = [];
  if (skipped.tablet || skipped.mobile) {
    limitation.push(
      `/* limitations: ${skipped.tablet} tablet + ${skipped.mobile} mobile container(s) could not be`,
      "   matched confidently across breakpoints and were left at their desktop rule. */",
    );
  }
  const lines = [
    `/* Responsive layout — extracted from ${esc(data.url)} */`,
    `/* desktop=${data.breakpoints.desktop?.width ?? "?"} tablet=${data.breakpoints.tablet?.width ?? "?"} mobile=${data.breakpoints.mobile?.width ?? "?"} */`,
    "/* Best-effort skeleton: rules below are derived from the page's own computed",
    "   layout. Boxes that couldn't be cross-matched are reported, not invented. */",
    ...limitation,
    "",
    "/* Base = desktop */",
    ...base,
    "",
  ];
  const tabletW = data.breakpoints.tablet?.width;
  const mobileW = data.breakpoints.mobile?.width;
  if (media.tablet.length && tabletW) {
    lines.push(`@media (max-width: ${tabletW}px) {`, ...media.tablet, "}", "");
  }
  if (media.mobile.length && mobileW) {
    lines.push(`@media (max-width: ${mobileW}px) {`, ...media.mobile, "}", "");
  }
  return lines.join("\n");
}

// ---- HTML skeleton ----------------------------------------------------------

function buildSkeleton(data, prefix) {
  const desktop = data.breakpoints.desktop?.tree || firstTree(data);
  if (!desktop) return `<!-- no layout tree for ${esc(prefix)} -->`;
  annotate(desktop);

  function render(node, depth) {
    const pad = "  ".repeat(depth + 2);
    const tag = ["header", "nav", "main", "section", "article", "aside", "footer"].includes(node.tag)
      ? node.tag
      : "div";
    const cls = isContainer(node) ? ` class="${node._cls}"` : "";
    const note = ` data-layout="${esc(layoutKind(node))}"`;
    const kids = node.children ?? [];
    if (!kids.length) {
      return `${pad}<${tag}${cls}${note}><!-- ${esc(labelOf(node))} --></${tag}>`;
    }
    const inner = kids.map((child) => render(child, depth + 1)).join("\n");
    return `${pad}<${tag}${cls}${note}>\n${inner}\n${pad}</${tag}>`;
  }

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>Layout skeleton — ${esc(data.url)}</title>`,
    `  <link rel="stylesheet" href="${esc(prefix)}-layout.css">`,
    "  <style>",
    "    [data-layout] { outline: 1px dashed rgba(83,58,253,.35); min-height: 2rem; padding: 4px; }",
    '    [data-layout]::before { content: attr(data-layout); font: 10px ui-monospace, monospace; color: #533afd; opacity:.7; }',
    "  </style>",
    "</head>",
    "<body>",
    render(desktop, 0),
    "</body>",
    "</html>",
  ].join("\n");
}

// ---- wireframe SVG ----------------------------------------------------------

function buildWireframe(data, prefix) {
  const cap = data.breakpoints.desktop || firstCapture(data);
  const tree = cap?.tree;
  if (!tree) return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
  const docW = cap.width || tree.rect?.w || 1440;
  const docH = Math.max(cap.scrollHeight || tree.rect?.h || 1000, 1);
  const W = 520;
  const scale = W / docW;
  const H = Math.min(Math.round(docH * scale), 6000);
  const palette = ["#eef0ff", "#e3e7ff", "#d9deff", "#cfd6ff"];

  const rects = [];
  (function draw(node, depth) {
    if (!node?.rect) return;
    const { x, y, w, h } = node.rect;
    const rx = Math.round(x * scale);
    const ry = Math.round(y * scale);
    const rw = Math.max(Math.round(w * scale), 1);
    const rh = Math.max(Math.round(h * scale), 1);
    if (ry <= H) {
      const fill = isContainer(node) ? palette[Math.min(depth, palette.length - 1)] : "#fafbff";
      rects.push(
        `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="#533afd" stroke-opacity="${0.15 + Math.min(depth, 4) * 0.12}" stroke-width="1" rx="2"/>`,
      );
      if (rw > 70 && rh > 16) {
        rects.push(
          `<text x="${rx + 4}" y="${ry + 12}" font-family="ui-monospace,monospace" font-size="9" fill="#3a2fb8">${esc(labelOf(node))} · ${esc(layoutKind(node))}</text>`,
        );
      }
    }
    (node.children ?? []).forEach((child) => draw(child, depth + 1));
  })(tree, 0);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    rects.join("\n"),
    "</svg>",
  ].join("\n");
}

function firstTree(data) {
  return firstCapture(data)?.tree || null;
}
function firstCapture(data) {
  for (const name of BP_ORDER) {
    if (data.breakpoints?.[name]) return data.breakpoints[name];
  }
  const vals = Object.values(data.breakpoints || {});
  return vals[0] || null;
}

export function generateLayoutArtifacts(data, prefix) {
  return {
    [`${prefix}-layout.json`]: JSON.stringify(data, null, 2),
    [`${prefix}-layout.css`]: buildCss(data, prefix),
    [`${prefix}-layout-skeleton.html`]: buildSkeleton(data, prefix),
    [`${prefix}-wireframe.svg`]: buildWireframe(data, prefix),
  };
}
