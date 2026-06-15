// Layout extraction pass — runs alongside designlang's design-system pass.
// designlang gives us section bounding boxes + a design token system; this
// adds the actual *layout model*: per-breakpoint nesting trees annotated with
// the CSS grid/flex/gap each container uses, so the result can be replayed as
// a responsive HTML/CSS skeleton.

import { rm } from "node:fs/promises";
import { chromeExecutable, launchChrome, CDPConnection, delay } from "./cdp.mjs";

export const DEFAULT_BREAKPOINTS = [
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "tablet", width: 834, height: 1112, mobile: false },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

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

  // A stable per-element token (tag + id + role + first classes). Identical for
  // the same element at every viewport because it reads the DOM, not layout.
  function token(el) {
    const id = el.id ? `#${el.id}` : "";
    const role = el.getAttribute("role") ? `[${el.getAttribute("role")}]` : "";
    const cls = (el.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join("");
    return `${el.tagName.toLowerCase()}${id}${role}${cls}`;
  }

  // Full DOM-ancestry signature from <body> down to the element, with an
  // nth-of-token index to disambiguate identical siblings. This is the stable
  // identity used to cross-match the same box across breakpoints — it depends on
  // document structure, never on responsive visibility/order/reflow.
  function domSignature(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== "BODY") {
      let nth = 0;
      let sib = cur.previousElementSibling;
      const tok = token(cur);
      while (sib) {
        if (token(sib) === tok) nth += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(nth ? `${tok}:${nth}` : tok);
      cur = cur.parentElement;
    }
    return parts.join(">");
  }

  // Count top-level grid tracks without being fooled by spaces inside
  // minmax()/repeat()/fit-content() or [line-name] groups.
  function countTracks(tpl) {
    if (!tpl || tpl === "none") return 1;
    const cleaned = tpl.replace(/\[[^\]]*\]/g, " ");
    let depth = 0;
    let count = 0;
    let inToken = false;
    for (const ch of cleaned) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && /\s/.test(ch)) {
        inToken = false;
        continue;
      }
      if (depth === 0 && !inToken) {
        count += 1;
        inToken = true;
      }
    }
    return count || 1;
  }

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
      dom: domSignature(el),
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
        columns: countTracks(tpl),
        template: tpl && tpl !== "none" ? tpl : null,
        rows: cs.gridTemplateRows && cs.gridTemplateRows !== "none" ? cs.gridTemplateRows : null,
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

async function captureBreakpoint(send, conn, sessionId, url, bp, walkOpts, signal) {
  if (signal?.aborted) throw signal.reason;
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
  await delay(bp.wait ?? 1500, signal);

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
  signal,
} = {}) {
  if (signal?.aborted) throw signal.reason;
  const walkOpts = {
    maxDepth: config.layoutMaxDepth ?? 7,
    maxNodes: config.layoutMaxNodes ?? 500,
    minArea: config.layoutMinArea ?? 1600,
  };
  const chromePath = chromeExecutable(config);
  await onLog(`[layout] launching headless Chrome (${chromePath})`);
  const { child, wsUrl, userDataDir, disposeAbort } = await launchChrome(chromePath, { signal });

  let conn;
  try {
    conn = await CDPConnection.connect(wsUrl, { signal });
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
      if (signal?.aborted) throw signal.reason;
      await onLog(`[layout] capturing ${bp.name} (${bp.width}px)`);
      out[bp.name] = {
        width: bp.width,
        height: bp.height,
        mobile: Boolean(bp.mobile),
        ...(await captureBreakpoint(send, conn, sessionId, url, bp, walkOpts, signal)),
      };
      done += 1;
      await onProgress(
        Math.round((done / breakpoints.length) * 100),
        `Captured ${bp.name} layout`,
      );
    }
    return { generatedAt: new Date().toISOString(), url, breakpoints: out };
  } finally {
    disposeAbort?.();
    conn?.close();
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}
