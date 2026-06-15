/* Peel — design-extract-studio 프론트엔드.
   백엔드 REST/SSE API에 그대로 연결한다. (CSP: script-src 'self' → 외부 파일) */
(() => {
  "use strict";

  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
  const TOPICS = [
    { key: "doc", label: "핵심 문서" },
    { key: "token", label: "색·토큰" },
    { key: "layout", label: "레이아웃" },
    { key: "motion", label: "모션" },
    { key: "comp", label: "컴포넌트" },
    { key: "img", label: "이미지" },
    { key: "ai", label: "AI·기타" },
  ];

  const state = {
    jobs: [],
    current: null,
    artifacts: [],
    layoutData: null,
    es: null,
    saveDir: null,
    filter: "all",
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  // ── 공통 ────────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      cache: "no-store",
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error?.message || `HTTP ${res.status}`);
      err.code = data.error?.code;
      err.field = data.error?.field;
      throw err;
    }
    return data;
  }

  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  };
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function fmtDuration(job) {
    if (!job?.startedAt) return "—";
    const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
    const s = Math.max(0, Math.round((end - new Date(job.startedAt)) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const extLabel = (name) => {
    const e = (name.split(".").pop() || "").toUpperCase();
    return e.length > 4 ? e.slice(0, 4) : e || "FILE";
  };
  const artifactUrl = (id, path) =>
    `/api/jobs/${encodeURIComponent(id)}/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`;
  const bundleUrl = (id) => `/api/jobs/${encodeURIComponent(id)}/artifacts-download`;

  // 파일명을 주제(topic)로 분류 — 레이아웃·모션처럼 한 묶음이 흩어지지 않게.
  function topicOf(a) {
    const n = a.name.toLowerCase();
    const p = a.path.toLowerCase();
    if (/-wireframe\.svg$|-layout\.(css|json)$|-layout-skeleton\.html$|(^|[-_/])layout[-_.]/.test(n)) return "layout";
    if (n.includes("motion")) return "motion";
    if (/variables|tokens|gradients|reset|theme|shadcn|tailwind/.test(n)) return "token";
    if (/-design-language\.md$|^design-language\.md$|-preview\.html$|^preview\.html$|-design\.md$|agent\.md$|design\.md$/.test(n)) return "doc";
    if (n.includes("anatomy") || n.endsWith(".tsx") || n.endsWith(".d.ts") || n.includes("react")) return "comp";
    if (a.classification?.type === "이미지" || /\.(png|jpe?g|webp|gif)$/.test(n) || p.includes("/screenshots/") || n.endsWith("logo.svg")) return "img";
    return "ai";
  }

  // ── 상태 모드: idle / running / done / failed ────────────────────────────
  function setMode(mode, job) {
    const urlIn = $("#url-input"), run = $("#run-btn");
    const prog = $("#progress-section"), result = $("#result-section");
    if (mode === "idle") {
      urlIn.disabled = false; urlIn.value = "";
      run.textContent = "추출 실행"; run.disabled = false; run.dataset.act = "run";
      prog.hidden = true; result.hidden = true;
    } else if (mode === "running") {
      urlIn.disabled = true; if (job) urlIn.value = job.url;
      run.textContent = "추출 중…"; run.disabled = true; run.dataset.act = "";
      prog.hidden = false; result.hidden = true;
    } else if (mode === "done") {
      urlIn.disabled = true; if (job) urlIn.value = job.url;
      run.textContent = "＋ 새 웹사이트 추출"; run.disabled = false; run.dataset.act = "new";
      prog.hidden = true; result.hidden = false;
    } else if (mode === "failed") {
      urlIn.disabled = true; if (job) urlIn.value = job.url;
      run.textContent = "＋ 새 웹사이트 추출"; run.disabled = false; run.dataset.act = "new";
      prog.hidden = false; result.hidden = true;
    }
  }

  function renderProgress(job) {
    const pct = Math.max(0, Math.min(100, Math.round(job.progress?.percent ?? 0)));
    $("#prog-pct").textContent = pct;
    $("#prog-bar").style.width = pct + "%";
    const badge = $("#prog-badge");
    if (job.status === "failed") {
      $("#prog-state").textContent = "실패";
      badge.textContent = "● 실패"; badge.className = "badge bad";
      $("#prog-now").textContent = job.error?.message || "추출에 실패했습니다.";
    } else if (job.status === "cancelled") {
      $("#prog-state").textContent = "취소됨";
      badge.textContent = "● 취소됨"; badge.className = "badge";
      $("#prog-now").textContent = "사용자가 추출을 취소했습니다.";
    } else if (job.status === "succeeded") {
      $("#prog-state").textContent = "완료";
      badge.textContent = "● 완료"; badge.className = "badge done";
      $("#prog-now").textContent = "모든 파일 생성 완료.";
    } else {
      $("#prog-state").textContent = "추출 중…";
      badge.textContent = "● 추출 중"; badge.className = "badge";
      $("#prog-now").textContent = `${job.progress?.stage ?? ""} · ${job.progress?.message ?? ""}`;
    }
  }

  // ── 결과 렌더 ────────────────────────────────────────────────────────────
  function renderResultHeader(job) {
    $("#res-host").textContent = hostOf(job.url);
    $("#res-sub").textContent = `job ${job.id} · ${job.url} · ${fmtWhen(job.finishedAt || job.createdAt)}`;
    const dd = (id, v) => { $(id).textContent = v; };
    dd("#stat-status", job.status === "succeeded" ? "완료" : job.status);
    dd("#stat-files", job.artifactCount ?? "—");
    dd("#stat-duration", fmtDuration(job));
    const s = job.summary;
    dd("#stat-wcag", s?.wcagScore != null ? `${s.wcagScore}%${s.grade ? " · " + s.grade : ""}` : (s?.grade || "—"));
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  async function renderLayout(job) {
    const block = $("#layout-block");
    const layout = job.layout;
    if (!layout || layout.status !== "succeeded" || !layout.breakpoints?.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;

    // Load the full per-breakpoint trees (layout.json) so we can draw a clean
    // nested wireframe and re-draw it (real reflow) when a breakpoint is picked.
    state.layoutData = null;
    const jsonArt = state.artifacts.find((a) => a.name.endsWith("-layout.json") || a.name === "layout.json");
    if (jsonArt) {
      try {
        const res = await fetch(artifactUrl(job.id, jsonArt.path), { cache: "no-store" });
        if (res.ok) state.layoutData = await res.json();
      } catch { /* fall back to empty */ }
    }

    const order = { mobile: 0, tablet: 1, desktop: 2 };
    const bps = [...layout.breakpoints].sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
    const active = bps.find((b) => b.name === "desktop") || bps[bps.length - 1];
    const cards = $("#bp-cards");
    cards.innerHTML = "";
    for (const bp of bps) {
      const card = el("button", "bp");
      card.type = "button";
      card.dataset.name = bp.name;
      card.append(
        el("div", "bp-t", cap(bp.name)),
        el("div", "bp-w", `${bp.width}px`),
        el("div", "bp-m", `${bp.nodes ?? "?"} nodes · ${bp.scrollHeight ?? "?"}px`),
      );
      if (bp.name === active?.name) card.classList.add("on");
      card.addEventListener("click", () => {
        cards.querySelectorAll(".bp").forEach((c) => c.classList.remove("on"));
        card.classList.add("on");
        renderWireframe(bp);
      });
      cards.append(card);
    }
    if (active) renderWireframe(active);
  }

  // ── 와이어프레임: layout.json 트리를 중첩 박스로 그림 ────────────────────
  function layoutKind(node) {
    if (node.grid) return `grid ${node.grid.columns || 1}col`;
    if (node.flex) return `flex ${String(node.flex.direction || "row").startsWith("col") ? "col" : "row"}`;
    return "block";
  }
  function wfLabel(node) {
    const ident = node.cls?.length ? `.${node.cls[0]}` : node.id ? `#${node.id}` : "";
    return `${node.tag}${ident ? " " + ident : ""} · ${layoutKind(node)}`;
  }
  function wfNode(node) {
    const kids = node.children ?? [];
    const box = el("div", `wf-node${kids.length ? "" : " leaf"}`);
    box.append(el("div", "wf-label", wfLabel(node)));
    if (kids.length) {
      const inner = el("div", "wf-kids");
      if (node.grid) {
        inner.style.display = "grid";
        inner.style.gridTemplateColumns = `repeat(${Math.min(node.grid.columns || 1, kids.length, 6)}, minmax(0, 1fr))`;
      } else if (node.flex && String(node.flex.direction || "row").startsWith("row")) {
        inner.style.flexDirection = "row";
      }
      kids.forEach((k) => inner.append(wfNode(k)));
      box.append(inner);
    }
    return box;
  }
  function renderWireframe(bp) {
    $("#wf-title").textContent = `${cap(bp.name)} 와이어프레임 · ${bp.width}px`;
    const host = $("#wireframe-host");
    host.innerHTML = "";
    const tree = state.layoutData?.breakpoints?.[bp.name]?.tree;
    if (!tree) {
      host.append(el("p", "wf-empty", "와이어프레임 데이터를 불러오지 못했습니다."));
      return;
    }
    const canvas = el("div", "wf-canvas");
    canvas.style.maxWidth = bp.name === "mobile" ? "320px" : bp.name === "tablet" ? "600px" : "100%";
    canvas.append(wfNode(tree));
    host.append(canvas);
  }

  function renderPreview(job) {
    const block = $("#preview-block");
    const prev = state.artifacts.find((a) => a.name.endsWith("-preview.html") || a.name === "preview.html");
    if (!prev) { block.hidden = true; return; }
    block.hidden = false;
    const url = artifactUrl(job.id, prev.path);
    $("#preview-frame").src = url;
    $("#preview-open").href = url;
    $("#preview-title").textContent = `${hostOf(job.url)} · 추출 결과 미리보기`;
  }

  function renderDownloads(job) {
    const present = new Set(state.artifacts.map(topicOf));
    const chips = $("#dl-chips");
    chips.innerHTML = "";
    const allChip = el("span", "chip on", `전체 ${state.artifacts.length}`);
    allChip.dataset.topic = "all";
    chips.append(allChip);
    for (const t of TOPICS) {
      if (!present.has(t.key)) continue;
      const c = el("span", "chip", t.label);
      c.dataset.topic = t.key;
      chips.append(c);
    }
    chips.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        chips.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
        c.classList.add("on");
        state.filter = c.dataset.topic;
        applyFilter();
      }));

    const files = $("#dl-files");
    files.innerHTML = "";
    if (!state.artifacts.length) {
      files.append(el("div", "files-empty", "생성된 파일이 없습니다."));
      return;
    }
    for (const a of state.artifacts) {
      const row = el("div", "file");
      row.dataset.topic = topicOf(a);
      const cb = el("input"); cb.type = "checkbox"; cb.dataset.path = a.path;
      const ico = el("span", "ico", extLabel(a.name));
      const info = el("span", "info");
      const link = el("a", "n", a.name);
      link.href = artifactUrl(job.id, a.path);
      link.target = "_blank"; link.rel = "noopener";
      info.append(link);
      row.append(cb, ico, info, el("span", "size", fmtBytes(a.size)));
      files.append(row);
    }
    state.filter = "all";
    applyFilter();
  }

  function applyFilter() {
    const t = state.filter;
    $("#dl-files").querySelectorAll(".file").forEach((row) => {
      row.hidden = t !== "all" && row.dataset.topic !== t;
    });
  }

  function selectedPaths() {
    return [...$("#dl-files").querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.dataset.path);
  }

  // ── 다운로드 / 폴더 저장 ───────────────────────────────────────────────
  function triggerDownload(url) {
    const a = el("a"); a.href = url; a.download = ""; document.body.append(a); a.click(); a.remove();
  }
  async function saveToFolder(paths) {
    let saved = 0;
    for (const path of paths) {
      const res = await fetch(artifactUrl(state.current.id, path));
      if (!res.ok) continue;
      const blob = await res.blob();
      const parts = path.split("/");
      let dir = state.saveDir;
      for (let i = 0; i < parts.length - 1; i += 1) dir = await dir.getDirectoryHandle(parts[i], { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable(); await w.write(blob); await w.close();
      saved += 1;
    }
    alert(`${saved}개 파일을 '${state.saveDir.name}' 폴더에 저장했어요.`);
  }
  async function downloadAll() {
    $("#dl-files").querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = true; });
    if (state.saveDir) { await saveToFolder(state.artifacts.map((a) => a.path)); return; }
    triggerDownload(bundleUrl(state.current.id)); // tar.gz 한 파일로 전체
  }
  async function downloadSelected() {
    const paths = selectedPaths();
    if (!paths.length) { alert("받을 파일을 먼저 체크하세요."); return; }
    if (state.saveDir) { await saveToFolder(paths); return; }
    paths.forEach((p, i) => setTimeout(() => triggerDownload(artifactUrl(state.current.id, p) + "?download=1"), i * 250));
  }
  async function pickFolder() {
    try {
      state.saveDir = await window.showDirectoryPicker();
      $("#res-folder").textContent = `📁 ${state.saveDir.name}`;
    } catch { /* 취소 */ }
  }
  // "이 폴더에 저장": 폴더를 먼저 골라야 하며, 선택 항목(없으면 전체)을 그 폴더에 씀.
  async function saveToChosenFolder() {
    if (!state.saveDir) { alert("먼저 ‘폴더 선택’으로 저장할 폴더를 고르세요."); return; }
    const sel = selectedPaths();
    const paths = sel.length ? sel : state.artifacts.map((a) => a.path);
    if (!paths.length) { alert("저장할 파일이 없습니다."); return; }
    await saveToFolder(paths);
  }

  // ── 작업 / SSE ───────────────────────────────────────────────────────────
  function closeES() { if (state.es) { state.es.close(); state.es = null; } }

  function applyJobState(job) {
    state.current = job;
    renderResultHeader(job);
    if (job.status === "succeeded") {
      setMode("done", job);
      loadArtifacts(job.id);
    } else if (job.status === "failed" || job.status === "cancelled") {
      setMode("failed", job); renderProgress(job);
    } else {
      setMode("running", job); renderProgress(job); connectES(job.id);
    }
  }

  async function selectJob(id) {
    closeES();
    highlightHistory(id);
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
      applyJobState(job);
      $("#result-section").scrollIntoView?.({ behavior: "smooth", block: "start" });
    } catch (e) { alert("작업을 불러오지 못했어요: " + e.message); }
  }

  function connectES(id) {
    closeES();
    const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    state.es = es;
    for (const name of ["snapshot", "progress", "log"]) {
      es.addEventListener(name, (event) => {
        if (!state.current || state.current.id !== id) return;
        const payload = JSON.parse(event.data);
        if (!payload.job) return;
        state.current = { ...state.current, ...payload.job };
        if (TERMINAL.has(payload.job.status)) {
          closeES();
          renderResultHeader(state.current);
          if (payload.job.status === "succeeded") { setMode("done", state.current); loadArtifacts(id); }
          else { setMode("failed", state.current); renderProgress(state.current); }
          loadJobs();
        } else {
          renderProgress(state.current);
        }
      });
    }
  }

  async function loadArtifacts(id) {
    try {
      const { artifacts } = await api(`/api/jobs/${encodeURIComponent(id)}/artifacts`);
      if (!state.current || state.current.id !== id) return;
      state.artifacts = artifacts || [];
      $("#stat-files").textContent = state.artifacts.length;
      renderLayout(state.current);
      renderPreview(state.current);
      renderDownloads(state.current);
    } catch {
      state.artifacts = [];
      renderDownloads(state.current);
    }
  }

  // ── 작업 이력 ─────────────────────────────────────────────────────────────
  async function loadJobs() {
    try {
      const { jobs } = await api("/api/jobs");
      state.jobs = jobs || [];
      renderHistory();
    } catch { /* ignore */ }
  }
  function highlightHistory(id) {
    $("#history-list").querySelectorAll(".job").forEach((c) =>
      c.classList.toggle("on", c.dataset.id === id));
  }
  function renderHistory() {
    const section = $("#history-section");
    const list = $("#history-list");
    if (!state.jobs.length) { section.hidden = true; return; }
    section.hidden = false;
    $("#history-count").textContent = `${state.jobs.length}개`;
    list.innerHTML = "";
    for (const job of state.jobs) {
      const card = el("div", "job"); card.dataset.id = job.id;
      if (state.current && job.id === state.current.id) card.classList.add("on");
      const running = !TERMINAL.has(job.status);
      const dotColor = job.status === "succeeded" ? "var(--ok)" : running ? "var(--run)" : "var(--bad)";
      const label = job.status === "succeeded" ? "완료" : running ? "진행 중" : job.status === "failed" ? "실패" : "취소";
      const h = el("div", "h");
      h.append(el("span", "host", hostOf(job.url)));
      const right = el("span", "h-right");
      const tag = el("span", "tag");
      const dot = el("span", "d"); dot.style.background = dotColor;
      tag.append(dot, document.createTextNode(label));
      right.append(tag);
      if (TERMINAL.has(job.status)) {
        const del = el("button", "job-del", "×"); del.type = "button"; del.title = "이 작업 삭제";
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteJob(job.id); });
        right.append(del);
      }
      h.append(right);
      const meta = job.status === "succeeded"
        ? `${fmtWhen(job.finishedAt || job.createdAt)} · ${job.artifactCount ?? 0} files · 클릭해 다시 보기`
        : running ? "추출 중 · 클릭해 진행 보기" : fmtWhen(job.finishedAt || job.createdAt);
      card.append(h, el("div", "url", job.url), el("div", "m", meta));
      card.addEventListener("click", () => selectJob(job.id));
      list.append(card);
    }
  }

  async function deleteJob(id) {
    if (!confirm("이 작업과 결과 파일을 삭제할까요?")) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) { alert("삭제하지 못했어요: " + e.message); return; }
    state.jobs = state.jobs.filter((j) => j.id !== id);
    if (state.current && state.current.id === id) startNew();
    renderHistory();
  }

  async function clearHistory() {
    const removable = state.jobs.filter((j) => TERMINAL.has(j.status));
    if (!removable.length) return;
    if (!confirm(`작업 이력 ${removable.length}개와 결과 파일을 모두 삭제할까요?`)) return;
    for (const j of removable) {
      try { await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: "DELETE" }); } catch { /* skip */ }
    }
    await loadJobs();
    if (state.current && !state.jobs.find((j) => j.id === state.current.id)) startNew();
  }

  // ── 제출 ──────────────────────────────────────────────────────────────────
  function collectOptions() {
    const segVal = (id) => Number($(id).querySelector(".on")?.dataset.val ?? 0);
    return {
      dark: $("#opt-dark").checked,
      screenshots: $("#opt-screenshots").checked,
      layout: $("#opt-layout").checked,
      depth: segVal("#seg-depth"),
      wait: segVal("#seg-wait"),
    };
  }
  async function submit() {
    const url = $("#url-input").value.trim();
    if (!url) { alert("먼저 분석할 웹사이트 주소를 입력하세요."); $("#url-input").focus(); return; }
    try {
      const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify({ url, options: collectOptions() }) });
      state.current = job;
      state.jobs.unshift(job); renderHistory();
      applyJobState(job);
    } catch (e) {
      alert(e.field === "url" ? `주소를 확인하세요: ${e.message}` : `추출을 시작하지 못했어요: ${e.message}`);
    }
  }
  function startNew() {
    closeES();
    state.current = null; state.artifacts = [];
    setMode("idle");
    highlightHistory(null);
    $("#url-input").focus();
  }

  // ── health ────────────────────────────────────────────────────────────────
  async function loadHealth() {
    const pill = $("#status-pill");
    try {
      const h = await api("/api/health");
      const q = h.queue || {};
      const busy = (q.queued || 0) + (q.running || 0);
      pill.className = "pill";
      pill.innerHTML = "";
      pill.append(el("span", "dot"), document.createTextNode(busy ? `Online · 작업 ${busy}` : "Online"));
    } catch {
      pill.className = "pill off";
      pill.innerHTML = "";
      pill.append(el("span", "dot"), document.createTextNode("오프라인"));
    }
  }

  // ── init ────────────────────────────────────────────────────────────────
  function bindSegments() {
    document.querySelectorAll(".seg").forEach((seg) =>
      seg.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
        })));
  }

  function init() {
    $("#extract-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if ($("#run-btn").dataset.act === "new") startNew(); else submit();
    });
    bindSegments();
    $("#dl-all").addEventListener("click", downloadAll);
    $("#dl-selected").addEventListener("click", downloadSelected);
    $("#clear-history").addEventListener("click", clearHistory);

    if (window.showDirectoryPicker) {
      $("#pick-folder").addEventListener("click", pickFolder);
      $("#save-folder").addEventListener("click", saveToChosenFolder);
    } else {
      $("#res-folder").textContent = "브라우저 미지원 — ‘전부 다운로드’ 사용";
      $("#pick-folder").disabled = true;
      $("#save-folder").disabled = true;
    }

    setMode("idle");
    loadHealth();
    loadJobs();
    setInterval(loadHealth, 15000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
