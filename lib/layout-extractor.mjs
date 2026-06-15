// Layout extraction pass — runs alongside designlang's design-system pass.
// designlang gives us section bounding boxes + a design token system; this
// adds the actual *layout model*: per-breakpoint nesting trees annotated with
// the CSS grid/flex/gap each container uses, so the result can be replayed as
// a responsive HTML/CSS skeleton.

import { rm } from "node:fs/promises";
import { chromeExecutable, launchChrome, CDPConnection } from "./cdp.mjs";

export const DEFAULT_BREAKPOINTS = [
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "tablet", width: 834, height: 1112, mobile: false },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serialized verbatim into the page. Must be fully self-contained — no closure
// over module scope. Walks the DOM from <body>, keeping structural sections and
// flex/grid containers (plus any node that fans out into >=2 visible children),
// and records the layout properties needed to reconstruct it.
function inPageWalk(opts) {
  const MAX_DEPTH = opts.maxDepth;
  const MAX_NODES = opts.maxNodes;
  const MIN_AREA = opts.minArea;
  const vw = window.innerWidth;
  const STRUCTURAL = new Set([
    "header",
    "nav",
    "main",
    "section",
    "article",
    "aside",
    "footer",
    "ul",
    "ol",
    "form",
  ]);
  let count = 0;

  function visible(el, r, cs) {
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number(cs.opacity) === 0) return false;
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < 0 || r.right < 0 || r.left > vw) return false;
    return true;
  }

  function describe(el, cs, r) {
    const display = cs.display;
    const node = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      id: el.id || null,
      cls: (el.getAttribute("class") || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      display,
    };
    if (display.indexOf("flex") !== -1) {
      node.flex = {
        direction: cs.flexDirection,
        wrap: cs.flexWrap,
        justify: cs.justifyContent,
        align: cs.alignItems,
        gap: cs.gap,
      };
    } else if (display.indexOf("grid") !== -1) {
      const tpl = cs.gridTemplateColumns;
      node.grid = {
        columns: tpl && tpl !== "none" ? tpl.split(" ").filter(Boolean).length : 1,
        template: tpl,
        gap: cs.gap,
        justify: cs.justifyItems,
      };
    }
    return node;
  }

  function build(el, depth) {
    if (count >= MAX_NODES || depth > MAX_DEPTH) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r, cs)) return null;

    const kids = [];
    for (const child of el.children) {
      if (child.nodeType !== 1) continue;
      const sub = build(child, depth + 1);
      if (sub) kids.push(sub);
    }

    const tag = el.tagName.toLowerCase();
    const isContainer =
      cs.display.indexOf("flex") !== -1 || cs.display.indexOf("grid") !== -1;
    const structural = STRUCTURAL.has(tag);
    const keep = depth === 0 || structural || isContainer || kids.length >= 2;

    if (!keep) {
      if (kids.length === 1) return kids[0];
      return null;
    }
    if (r.width * r.height < MIN_AREA && kids.length === 0) return null;

    count += 1;
    const node = describe(el, cs, r);
    node.childCount = el.childElementCount;
    node.children = kids;
    return node;
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { w: vw, h: window.innerHeight },
    scrollHeight: document.documentElement.scrollHeight,
    nodeCount: count,
    tree: build(document.body, 0),
  };
}

async function captureBreakpoint(send, conn, sessionId, url, bp, walkOpts) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: bp.width,
    height: bp.height,
    deviceScaleFactor: 1,
    mobile: Boolean(bp.mobile),
  });
  const loaded = conn
    .waitForEvent("Page.loadEventFired", { sessionId, timeoutMs: 20000 })
    .catch(() => null);
  await send("Page.navigate", { url });
  await loaded;
  await delay(bp.wait ?? 1500);

  const expression = `(${inPageWalk.toString()})(${JSON.stringify(walkOpts)})`;
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "in-page evaluation failed",
    );
  }
  const value = result.result?.value ?? null;
  value.nodeCount = countNodes(value?.tree);
  return value;
}

function countNodes(node) {
  if (!node) return 0;
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

export async function extractLayout({
  url,
  config = {},
  breakpoints = DEFAULT_BREAKPOINTS,
  onLog = () => {},
  onProgress = () => {},
} = {}) {
  const walkOpts = {
    maxDepth: config.layoutMaxDepth ?? 7,
    maxNodes: config.layoutMaxNodes ?? 500,
    minArea: config.layoutMinArea ?? 1600,
  };
  const chromePath = chromeExecutable(config);
  await onLog(`[layout] launching headless Chrome (${chromePath})`);
  const { child, wsUrl, userDataDir } = await launchChrome(chromePath);

  let conn;
  try {
    conn = await CDPConnection.connect(wsUrl);
    const { targetId } = await conn.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await conn.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const send = (method, params) => conn.send(method, params, sessionId);
    await send("Page.enable", {});
    await send("Runtime.enable", {});

    const out = {};
    let done = 0;
    for (const bp of breakpoints) {
      await onLog(`[layout] capturing ${bp.name} (${bp.width}px)`);
      out[bp.name] = {
        width: bp.width,
        height: bp.height,
        mobile: Boolean(bp.mobile),
        ...(await captureBreakpoint(send, conn, sessionId, url, bp, walkOpts)),
      };
      done += 1;
      await onProgress(
        Math.round((done / breakpoints.length) * 100),
        `Captured ${bp.name} layout`,
      );
    }
    return { generatedAt: new Date().toISOString(), url, breakpoints: out };
  } finally {
    conn?.close();
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}
