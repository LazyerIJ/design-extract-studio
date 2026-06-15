(() => {
  "use strict";

  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
  const GUIDE_DEFINITIONS = [
    {
      id: "start",
      title: "처음이라면 이 3개",
      audience: "모든 사용자",
      purpose: "전체 설명, 눈으로 보는 결과, 바로 쓸 CSS 변수를 순서대로 확인합니다.",
      next: "보고서를 읽고 preview를 본 뒤 variables.css를 개발자에게 전달하세요.",
      slots: [
        {
          label: "디자인 설명서",
          match: (path) =>
            path.endsWith("-design-language.md") || path === "design-language.md",
        },
        {
          label: "시각 미리보기",
          match: (path) => path.endsWith("-preview.html") || path === "preview.html",
        },
        {
          label: "CSS 변수",
          match: (path) => path.endsWith("-variables.css") || path === "variables.css",
        },
      ],
    },
    {
      id: "ai",
      title: "AI로 같은 화면 재현",
      audience: "AI 사용자 · 기획자",
      purpose: "디자인 언어와 도구별 prompt를 함께 주어 결과의 일관성을 높입니다.",
      next: "design-language.md와 사용하는 AI 도구의 prompt를 같은 대화에 첨부하세요.",
      slots: [
        {
          label: "디자인 설명서",
          match: (path) =>
            path.endsWith("-design-language.md") || path === "design-language.md",
        },
        {
          label: "AI prompts",
          many: true,
          match: (path) => path.includes("prompts/"),
        },
      ],
    },
    {
      id: "css",
      title: "일반 CSS 프로젝트",
      audience: "프런트엔드 개발자",
      purpose: "프레임워크 없이 토큰, reset, gradient를 기존 CSS에 연결합니다.",
      next: "variables.css를 먼저 import하고 필요한 reset과 gradient를 선택하세요.",
      slots: [
        {
          label: "CSS files",
          many: true,
          match: (path) =>
            path.endsWith("-variables.css") ||
            path.endsWith("-reset.css") ||
            path.endsWith("-gradients.css"),
        },
      ],
    },
    {
      id: "tailwind",
      title: "Tailwind 프로젝트",
      audience: "프런트엔드 개발자",
      purpose: "추출 토큰을 Tailwind theme와 CSS 유틸리티로 사용합니다.",
      next: "프로젝트 버전에 맞는 config 또는 Tailwind v4 CSS를 선택하세요.",
      slots: [
        {
          label: "Tailwind files",
          many: true,
          match: (path) => path.includes("tailwind"),
        },
      ],
    },
    {
      id: "shadcn",
      title: "shadcn/ui 테마",
      audience: "React 개발자",
      purpose: "shadcn/ui의 색상과 radius 변수를 추출 결과에 맞춥니다.",
      next: "기존 globals.css와 비교한 뒤 shadcn theme 변수를 병합하세요.",
      slots: [
        {
          label: "shadcn theme",
          match: (path) => path.includes("shadcn") && path.endsWith(".css"),
        },
      ],
    },
    {
      id: "figma",
      title: "Figma로 옮기기",
      audience: "디자이너",
      purpose: "색상과 토큰을 Figma variables로 다시 구성할 자료를 제공합니다.",
      next: "Figma variables JSON을 토큰 플러그인이나 변수 작성 기준으로 사용하세요.",
      slots: [
        {
          label: "Figma variables",
          match: (path) => path.includes("figma") && path.endsWith(".json"),
        },
      ],
    },
    {
      id: "react",
      title: "React 컴포넌트 구조",
      audience: "React 개발자",
      purpose: "버튼, 카드 같은 컴포넌트의 anatomy와 variant 계약을 확인합니다.",
      next: "anatomy.tsx를 참고해 현재 컴포넌트 API에 variant를 매핑하세요.",
      slots: [
        {
          label: "React anatomy",
          match: (path) => path.includes("anatomy") && path.endsWith(".tsx"),
        },
      ],
    },
    {
      id: "motion",
      title: "모션과 인터랙션",
      audience: "개발자 · 모션 디자이너",
      purpose: "duration, easing과 CSS/프레임워크별 모션 예제를 확인합니다.",
      next: "motion tokens를 기준으로 프로젝트에 맞는 구현 파일 하나를 선택하세요.",
      slots: [
        {
          label: "Motion files",
          many: true,
          match: (path) => path.includes("motion"),
        },
      ],
    },
    {
      id: "voice",
      title: "브랜드 문체와 카피",
      audience: "콘텐츠 디자이너 · AI 사용자",
      purpose: "버튼, 제목, 설명 문구가 같은 말투를 유지하도록 기준을 제공합니다.",
      next: "voice.json을 카피 가이드나 AI system prompt의 문체 기준으로 사용하세요.",
      slots: [
        {
          label: "Brand voice",
          match: (path) => path.includes("voice") && path.endsWith(".json"),
        },
      ],
    },
    {
      id: "reports",
      title: "접근성·진단 보고서",
      audience: "기획자 · QA · 개발자",
      purpose: "WCAG 결과와 구현 상태를 검토하고 개선 작업의 우선순위를 정합니다.",
      next: "design-language의 WCAG 섹션과 진단 JSON/Markdown을 이슈 목록으로 옮기세요.",
      slots: [
        {
          label: "Reports",
          many: true,
          match: (path) =>
            path.endsWith("-design-language.md") ||
            path.includes("form-states") ||
            path.includes("dark-mode") ||
            path.includes("stack-intel") ||
            path.endsWith("-design.md"),
        },
      ],
    },
  ];
  const state = {
    jobs: [],
    selectedId: null,
    selectedJob: null,
    artifacts: [],
    artifactFilter: "",
    artifactCategory: "all",
    applyEnabled: false,
    applyAnalysis: null,
    currentApplication: null,
    applicationPollTimer: null,
    eventSource: null,
    pollTimer: null,
    durationTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function announce(message) {
    const region = $("#form-status");
    if (!region) return;
    region.textContent = "";
    window.setTimeout(() => {
      region.textContent = message;
    }, 20);
  }

  function announceApply(message) {
    const region = $("#apply-live");
    region.textContent = "";
    window.setTimeout(() => {
      region.textContent = message;
    }, 20);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      cache: "no-store",
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || `HTTP ${response.status}`);
      error.code = data.error?.code;
      error.field = data.error?.field;
      throw error;
    }
    return data;
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  }

  function formatDuration(job) {
    if (!job?.startedAt) return "—";
    const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
    const milliseconds = Math.max(0, end - new Date(job.startedAt));
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusClass(status) {
    return `status-label status-label--${status || "queued"}`;
  }

  function statusText(status) {
    return {
      queued: "Queued",
      running: "Running",
      succeeded: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
    }[status] || status || "Unknown";
  }

  function normalizedArtifactPath(artifact) {
    return artifact.path.replaceAll("\\", "/").toLowerCase();
  }

  async function loadHealth() {
    try {
      const health = await api("/api/health");
      state.applyEnabled = health.applyEnabled === true;
      $("#server-status").className = "status-pill";
      $("#server-status").lastChild.textContent = " Online";
      $("#health-badge").textContent = "✓";
      $("#health-message").textContent =
        "system Chrome과 designlang worker를 사용할 준비가 됐습니다.";
      $("#health-running").textContent = health.queue.running;
      $("#health-queued").textContent = health.queue.queued;
      $("#health-codex").textContent = health.codexAnalysis ? "On" : "Off";
      if (state.selectedJob) renderSelectedJob();
    } catch {
      state.applyEnabled = false;
      $("#server-status").className = "status-pill status-pill--error";
      $("#server-status").lastChild.textContent = " Offline";
      $("#health-badge").textContent = "!";
      $("#health-message").textContent =
        "서버에 연결할 수 없습니다. 재연결을 시도하고 있습니다.";
    }
  }

  async function loadJobs({ preserveSelection = true } = {}) {
    const filter = $("#status-filter").value;
    const query = filter ? `?status=${encodeURIComponent(filter)}` : "";
    try {
      const data = await api(`/api/jobs${query}`);
      state.jobs = data.jobs;
      $("#jobs-loading").hidden = true;
      $("#jobs-empty").hidden = state.jobs.length > 0;
      renderJobList();

      const selectedStillVisible = state.jobs.some(
        (job) => job.id === state.selectedId,
      );
      if (!preserveSelection || !selectedStillVisible) {
        if (state.jobs[0]) await selectJob(state.jobs[0].id);
        else clearSelection();
      } else if (state.selectedId) {
        const listed = state.jobs.find((job) => job.id === state.selectedId);
        if (listed) {
          state.selectedJob = { ...state.selectedJob, ...listed };
          renderSelectedJob();
        }
      }
      await loadHealth();
    } catch (error) {
      $("#jobs-loading").textContent = `작업 이력을 불러오지 못했습니다: ${error.message}`;
      $("#jobs-loading").hidden = false;
    }
  }

  function renderJobList() {
    const list = $("#job-list");
    list.replaceChildren();
    for (const job of state.jobs) {
      const item = element("li");
      const button = element("button", "job-item");
      button.type = "button";
      button.dataset.jobId = job.id;
      button.setAttribute(
        "aria-current",
        job.id === state.selectedId ? "true" : "false",
      );

      let host = job.url;
      try {
        host = new URL(job.url).hostname;
      } catch {}

      const top = element("span", "job-item__top");
      top.append(
        element("strong", "", host),
        element("span", statusClass(job.status), statusText(job.status)),
      );
      const url = element("span", "job-item__url", job.url);
      const progress = element("span", "job-item__progress");
      const bar = element("span");
      bar.style.width = `${job.progress?.percent ?? 0}%`;
      progress.append(bar);
      const meta = element(
        "span",
        "job-item__meta",
        `${formatDate(job.createdAt)} · ${job.artifactCount ?? 0} files`,
      );
      button.append(top, url, progress, meta);
      button.addEventListener("click", () => void selectJob(job.id));
      item.append(button);
      list.append(item);
    }
  }

  function clearSelection() {
    closeEventStream();
    stopApplicationPolling();
    state.selectedId = null;
    state.selectedJob = null;
    state.artifacts = [];
    $("#results-guide").hidden = true;
    $("#artifact-location").hidden = true;
    $("#download-all").hidden = true;
    $("#download-all-secondary").hidden = true;
    $("#apply-panel").hidden = true;
    $("#detail-empty").hidden = false;
    $("#detail-content").hidden = true;
  }

  async function selectJob(id) {
    if (!id) return;
    state.selectedId = id;
    state.artifactFilter = "";
    state.artifactCategory = "all";
    state.applyAnalysis = null;
    state.currentApplication = null;
    stopApplicationPolling();
    resetApplyReport();
    $("#artifact-filter").value = "";
    syncArtifactCategoryButtons();
    renderJobList();
    $("#detail-empty").hidden = true;
    $("#detail-content").hidden = false;
    $("#job-log").textContent = "Loading job details…";
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (state.selectedId !== id) return;
      state.selectedJob = data.job;
      renderSelectedJob();
      connectEventStream(id);
      await loadArtifacts(id);
      await loadApplications(id);
    } catch (error) {
      $("#job-log").textContent = `Failed to load job: ${error.message}`;
    }
  }

  function renderSelectedJob() {
    const job = state.selectedJob;
    if (!job) return;

    let host = job.url;
    try {
      host = new URL(job.url).hostname;
    } catch {}
    $("#detail-status").className = statusClass(job.status);
    $("#detail-status").textContent = statusText(job.status);
    $("#detail-id").textContent = job.id;
    $("#detail-host").textContent = host;
    $("#detail-url").textContent = job.url;
    $("#detail-url").href = job.url;

    const progress = job.progress ?? { percent: 0, stage: "queued", message: "" };
    $("#progress-stage").textContent = progress.stage;
    $("#progress-message").textContent =
      job.error?.message || progress.message || statusText(job.status);
    $("#progress-percent").textContent = `${progress.percent}%`;
    $("#job-progress").setAttribute("aria-valuenow", String(progress.percent));
    $("#job-progress span").style.width = `${progress.percent}%`;

    $("#meta-created").textContent = formatDate(job.createdAt);
    $("#meta-started").textContent = formatDate(job.startedAt);
    $("#meta-duration").textContent = formatDuration(job);
    $("#meta-process").textContent = job.pid
      ? `PID ${job.pid}`
      : job.exitCode !== null
        ? `exit ${job.exitCode}`
        : "—";

    const canCancel = job.status === "queued" || job.status === "running";
    $("#cancel-job").hidden = !canCancel;
    $("#retry-job").hidden = !TERMINAL.has(job.status);
    $("#delete-job").hidden = !TERMINAL.has(job.status);

    const succeeded = job.status === "succeeded";
    const bundleUrl = `/api/jobs/${encodeURIComponent(job.id)}/artifacts-download`;
    for (const selector of ["#download-all", "#download-all-secondary"]) {
      const link = $(selector);
      link.hidden = !succeeded;
      link.href = succeeded ? bundleUrl : "#";
    }
    const showPath = succeeded && typeof job.artifactPath === "string";
    $("#artifact-location").hidden = !showPath;
    $("#artifact-path").textContent = showPath ? job.artifactPath : "";
    $("#results-guide").hidden = !succeeded;
    $("#apply-panel").hidden = !(succeeded && state.applyEnabled);
    if (succeeded) renderUsageGuide();

    renderSummary(job);
    renderLayout(job);
    if (typeof job.recentLog === "string") {
      $("#job-log").textContent = job.recentLog || "No log output yet.";
      $("#job-log").scrollTop = $("#job-log").scrollHeight;
    }
    updateDurationTimer();
  }

  function renderSummary(job) {
    const summary = job.summary;
    const integrity = job.integrity;
    $("#summary-score").textContent =
      Number.isFinite(summary?.designScore) ? summary.designScore : "—";
    $("#summary-grade").textContent = summary?.grade
      ? `Grade ${summary.grade}`
      : "Waiting for summary";
    $("#summary-wcag").textContent = Number.isFinite(summary?.wcagScore)
      ? `${summary.wcagScore}%`
      : "—";
    $("#summary-wcag-detail").textContent = Number.isFinite(summary?.wcagFailing)
      ? `${summary.wcagPassing} passing · ${summary.wcagFailing} failing`
      : "No audit yet";
    $("#summary-files").textContent = integrity?.fileCount ?? job.artifactCount ?? "—";
    $("#summary-bytes").textContent = integrity
      ? formatBytes(integrity.totalBytes)
      : "No files yet";
    $("#summary-integrity").textContent = integrity
      ? integrity.ok
        ? "Pass"
        : "Warn"
      : "—";
    $("#summary-integrity-detail").textContent = integrity
      ? `${integrity.json.valid}/${integrity.json.count} JSON · ${integrity.emptyFiles.length} empty`
      : "Validation pending";

    const hasDetails =
      summary &&
      (summary.colors?.length ||
        summary.fonts?.length ||
        summary.spacingBase !== null);
    $("#summary-details").hidden = !hasDetails;
    if (!hasDetails) return;

    const colors = $("#summary-colors");
    colors.replaceChildren();
    for (const color of summary.colors || []) {
      const swatch = element("span", "summary-swatch");
      swatch.style.setProperty("--swatch", color.value);
      swatch.title = `${color.role}: ${color.value}`;
      swatch.append(
        element("i"),
        element("span", "", color.role),
        element("code", "", color.value),
      );
      colors.append(swatch);
    }
    $("#summary-fonts").textContent = summary.fonts?.length
      ? summary.fonts.join(" · ")
      : "No fonts detected";
    $("#summary-notes").textContent = [
      Number.isFinite(summary.elementsAnalyzed)
        ? `${summary.elementsAnalyzed} elements`
        : null,
      Number.isFinite(summary.spacingBase)
        ? `${summary.spacingBase}px spacing base`
        : null,
      summary.componentPatterns?.length
        ? `${summary.componentPatterns.length} component patterns`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function guideMatches(slot) {
    const matches = state.artifacts.filter((artifact) =>
      slot.match(normalizedArtifactPath(artifact)),
    );
    return slot.many ? matches.slice(0, 4) : matches.slice(0, 1);
  }

  function createQuickActions(artifact) {
    const actions = element("span", "guide-file__actions");
    if (artifact.previewable) {
      const preview = element("button", "", "Quick preview");
      preview.type = "button";
      preview.addEventListener("click", () => {
        void previewArtifact(artifact);
        $("#artifact-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      actions.append(preview);
    }
    const download = element("a", "", "Download");
    download.href = artifactUrl(artifact, true);
    download.download = "";
    actions.append(download);
    return actions;
  }

  function renderUsageGuide() {
    const grid = $("#guide-grid");
    grid.replaceChildren();
    if (state.selectedJob?.status !== "succeeded") return;

    for (const guide of GUIDE_DEFINITIONS) {
      const card = element("article", "guide-card");
      card.dataset.guide = guide.id;
      const matchedSlots = guide.slots.map((slot) => ({
        slot,
        artifacts: guideMatches(slot),
      }));
      const available = matchedSlots.reduce(
        (total, entry) => total + entry.artifacts.length,
        0,
      );
      const header = element("div", "guide-card__header");
      header.append(
        element("span", "audience-badge", guide.audience),
        element(
          "span",
          available ? "availability-badge" : "availability-badge is-unavailable",
          available ? `${available} available` : "Unavailable",
        ),
      );
      card.append(
        header,
        element("h4", "", guide.title),
        element("p", "guide-card__purpose", guide.purpose),
      );

      const files = element("div", "guide-files");
      for (const { slot, artifacts } of matchedSlots) {
        if (artifacts.length === 0) {
          const unavailable = element("div", "guide-file is-unavailable");
          unavailable.append(
            element("span", "", slot.label),
            element("small", "", "Unavailable"),
          );
          files.append(unavailable);
          continue;
        }
        for (const artifact of artifacts) {
          const row = element("div", "guide-file");
          const copy = element("span", "guide-file__copy");
          copy.append(
            element("small", "", slot.label),
            element("strong", "", artifact.name),
          );
          row.append(copy, createQuickActions(artifact));
          files.append(row);
        }
      }
      const next = element("p", "guide-card__next");
      next.append(element("strong", "", "다음 행동"), document.createTextNode(` ${guide.next}`));
      card.append(files, next);
      grid.append(card);
    }
  }

  function resetApplyReport() {
    state.applyAnalysis = null;
    $("#compatibility-report").hidden = true;
    $("#apply-confirmed").checked = false;
    $("#start-application").disabled = true;
    $("#application-run").hidden = true;
    $("#application-result").hidden = true;
    $("#application-log").textContent = "적용 로그가 여기에 표시됩니다.";
  }

  function fillList(selector, values, emptyText) {
    const list = $(selector);
    list.replaceChildren();
    const items = values?.length ? values : [emptyText];
    for (const value of items) list.append(element("li", "", value));
  }

  function renderCompatibility(bundle) {
    state.applyAnalysis = bundle;
    const { analysis, compatibility, plan } = bundle;
    $("#compatibility-report").hidden = false;
    const status = $("#compatibility-status");
    status.textContent = compatibility.status;
    status.className =
      compatibility.status === "supported"
        ? "status-label status-label--succeeded"
        : compatibility.status === "partial"
          ? "status-label status-label--running"
          : "status-label status-label--failed";
    $("#compatibility-title").textContent =
      compatibility.safeInstall
        ? "Safe install 준비 완료"
        : "현재 상태에서는 수정할 수 없습니다";
    $("#compatibility-target").textContent = analysis.targetPath;
    $("#apply-framework").textContent = analysis.framework.name;
    $("#apply-css-entry").textContent =
      analysis.css.entry ?? `Unresolved (${analysis.css.confidence})`;
    $("#apply-package-manager").textContent =
      analysis.packageManager.name ?? "None";
    $("#apply-git").textContent = analysis.git.clean
      ? "Clean"
      : `${analysis.git.dirtyEntries.length} changes`;
    $("#apply-tailwind").textContent = analysis.tailwind.detected
      ? `Detected${analysis.tailwind.version ? ` · v${analysis.tailwind.version}` : ""}`
      : "Not detected";
    $("#apply-shadcn").textContent = analysis.shadcn.detected
      ? "Detected"
      : "Not detected";
    fillList("#apply-blockers", compatibility.blockers, "없음");
    fillList("#apply-warnings", compatibility.warnings, "없음");
    fillList(
      "#apply-plan",
      plan.changes.map((change) =>
        change.action === "copy"
          ? `Copy ${change.source} → ${change.target}`
          : `Update imports in ${change.target}`,
      ),
      "적용 계획 없음",
    );
    updateApplyButton();
  }

  function updateApplyButton() {
    const ready =
      Boolean(state.applyAnalysis?.compatibility?.safeInstall) &&
      $("#apply-confirmed").checked &&
      !state.currentApplication;
    $("#start-application").disabled = !ready;
  }

  async function analyzeTarget() {
    if (!state.selectedId) return;
    const target = $("#apply-target");
    const button = $("#analyze-project");
    button.disabled = true;
    button.textContent = "Analyzing…";
    try {
      const bundle = await api(
        `/api/jobs/${encodeURIComponent(state.selectedId)}/applications/analyze`,
        {
          method: "POST",
          body: JSON.stringify({ targetPath: target.value.trim() }),
        },
      );
      target.removeAttribute("aria-invalid");
      renderCompatibility(bundle);
      announceApply(
        bundle.compatibility.safeInstall
          ? "프로젝트 분석과 적용 계획을 완료했습니다."
          : "프로젝트를 수정할 수 없는 blocker가 있습니다.",
      );
    } catch (error) {
      state.applyAnalysis = null;
      target.setAttribute("aria-invalid", "true");
      $("#compatibility-report").hidden = true;
      announceApply(`프로젝트 분석 실패: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = "Analyze";
      updateApplyButton();
    }
  }

  function applicationActive(application) {
    return !["succeeded", "failed", "cancelled"].includes(application?.status);
  }

  function renderApplication(application) {
    const active = applicationActive(application);
    state.currentApplication = active ? application : null;
    $("#application-run").hidden = false;
    $("#application-stage").textContent = application.status;
    $("#application-message").textContent =
      application.error?.message ||
      application.progress?.message ||
      application.status;
    const percent = application.progress?.percent ?? 0;
    $("#application-percent").textContent = `${percent}%`;
    $("#application-progress").setAttribute("aria-valuenow", String(percent));
    $("#application-progress span").style.width = `${percent}%`;
    $("#application-log").textContent =
      application.recentLog || "적용 로그를 기다리는 중입니다.";
    $("#application-log").scrollTop = $("#application-log").scrollHeight;
    $("#cancel-application").hidden = !active;
    $("#start-application").disabled = active ||
      !state.applyAnalysis?.compatibility?.safeInstall ||
      !$("#apply-confirmed").checked;

    const result = application.result;
    $("#application-result").hidden = !result;
    if (result) {
      fillList(
        "#application-files",
        result.changedFiles,
        "Git 변경 파일 없음",
      );
      const commandResults = result.verification?.commands ?? [];
      fillList(
        "#application-verification",
        [
          `Static manifest/import check: ${result.verification?.static?.ok ? "Pass" : "Fail"}`,
          ...commandResults.map(
            (command) => `${command.script}: exit ${command.exitCode}`,
          ),
        ],
        "검증 결과 없음",
      );
    }
    if (!active) {
      state.applyAnalysis = null;
      $("#apply-confirmed").checked = false;
      $("#start-application").disabled = true;
      stopApplicationPolling();
      announceApply(
        application.status === "succeeded"
          ? "디자인 시스템 적용과 검증을 완료했습니다."
          : `적용이 ${application.status} 상태로 종료됐습니다.`,
      );
    }
  }

  function stopApplicationPolling() {
    clearTimeout(state.applicationPollTimer);
    state.applicationPollTimer = null;
  }

  async function pollApplication(id) {
    stopApplicationPolling();
    try {
      const data = await api(`/api/applications/${encodeURIComponent(id)}`);
      if (state.selectedJob?.id !== data.application.jobId) return;
      renderApplication(data.application);
      if (applicationActive(data.application)) {
        state.applicationPollTimer = window.setTimeout(
          () => void pollApplication(id),
          800,
        );
      }
    } catch (error) {
      announceApply(`적용 상태 연결 오류: ${error.message}. 재연결합니다.`);
      state.applicationPollTimer = window.setTimeout(
        () => void pollApplication(id),
        1800,
      );
    }
  }

  async function loadApplications(jobId) {
    if (!state.applyEnabled) return;
    try {
      const data = await api(
        `/api/jobs/${encodeURIComponent(jobId)}/applications`,
      );
      if (state.selectedId !== jobId || !data.applications[0]) return;
      const detail = await api(
        `/api/applications/${encodeURIComponent(data.applications[0].id)}`,
      );
      if (state.selectedId !== jobId) return;
      const latest = detail.application;
      $("#apply-target").value = latest.targetPath ?? "";
      if (latest.analysis && latest.compatibility && latest.plan) {
        renderCompatibility({
          analysis: latest.analysis,
          compatibility: latest.compatibility,
          plan: latest.plan,
        });
      }
      renderApplication(latest);
      if (applicationActive(latest)) void pollApplication(latest.id);
    } catch {
      // The extraction UI remains usable if apply history cannot load.
    }
  }

  async function startApplication(event) {
    event.preventDefault();
    if (!state.selectedId || !state.applyAnalysis) return;
    const mode =
      document.querySelector('input[name="applyMode"]:checked')?.value ?? "safe";
    const button = $("#start-application");
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const data = await api(
        `/api/jobs/${encodeURIComponent(state.selectedId)}/applications`,
        {
          method: "POST",
          body: JSON.stringify({
            targetPath: $("#apply-target").value.trim(),
            mode,
            confirmed: $("#apply-confirmed").checked,
          }),
        },
      );
      renderApplication(data.application);
      announceApply("비동기 적용 작업을 시작했습니다.");
      void pollApplication(data.application.id);
    } catch (error) {
      announceApply(`적용 작업을 시작하지 못했습니다: ${error.message}`);
    } finally {
      button.textContent = "Apply design system";
      updateApplyButton();
    }
  }

  async function cancelApplication() {
    const id = state.currentApplication?.id;
    if (!id) return;
    $("#cancel-application").disabled = true;
    try {
      const data = await api(
        `/api/applications/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      );
      renderApplication(data.application);
      announceApply("적용 취소를 요청했습니다.");
    } catch (error) {
      announceApply(`적용을 취소하지 못했습니다: ${error.message}`);
    } finally {
      $("#cancel-application").disabled = false;
    }
  }

  function appendLog(line) {
    const log = $("#job-log");
    if (
      log.textContent === "No log output yet." ||
      log.textContent === "Loading job details…"
    ) {
      log.textContent = "";
    }
    log.textContent += `${line}\n`;
    if (log.textContent.length > 100000) {
      log.textContent = log.textContent.slice(-80000);
    }
    log.scrollTop = log.scrollHeight;
  }

  function closeEventStream() {
    state.eventSource?.close();
    state.eventSource = null;
    $("#stream-status").textContent = "Idle";
    $("#stream-status").className = "connection-label";
  }

  function connectEventStream(id) {
    closeEventStream();
    const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    state.eventSource = source;
    $("#stream-status").textContent = "Connecting";

    source.onopen = () => {
      $("#stream-status").textContent = "Live";
      $("#stream-status").className = "connection-label connection-label--live";
    };
    source.onerror = () => {
      $("#stream-status").textContent = "Reconnecting";
      $("#stream-status").className = "connection-label connection-label--warn";
    };

    for (const eventName of ["snapshot", "progress", "log"]) {
      source.addEventListener(eventName, (event) => {
        if (state.selectedId !== id) return;
        const payload = JSON.parse(event.data);
        if (payload.job) {
          const recentLog = state.selectedJob?.recentLog;
          state.selectedJob = { ...state.selectedJob, ...payload.job, recentLog };
          if (eventName !== "log") renderSelectedJob();
          upsertListedJob(payload.job);
        }
        if (payload.line) appendLog(payload.line);
        if (payload.job && TERMINAL.has(payload.job.status)) {
          void loadArtifacts(id);
          void loadJobs();
        }
      });
    }
  }

  function upsertListedJob(job) {
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) state.jobs[index] = { ...state.jobs[index], ...job };
    else state.jobs.unshift(job);
    renderJobList();
  }

  async function loadArtifacts(id) {
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(id)}/artifacts`);
      if (state.selectedId !== id) return;
      state.artifacts = data.artifacts;
      renderArtifacts();
      renderUsageGuide();
      if (state.selectedJob) renderLayout(state.selectedJob);
    } catch {
      state.artifacts = [];
      renderArtifacts();
      renderUsageGuide();
    }
  }

  function renderArtifacts() {
    const query = state.artifactFilter.trim().toLowerCase();
    const artifacts = state.artifacts.filter((artifact) => {
      const classification = artifact.classification ?? {};
      const categoryMatch =
        state.artifactCategory === "all" ||
        classification.categories?.includes(state.artifactCategory);
      const searchable = [
        artifact.path,
        artifact.name,
        classification.type,
        classification.purpose,
        ...(classification.audiences ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return categoryMatch && (!query || searchable.includes(query));
    });
    $("#artifact-count").textContent =
      artifacts.length === state.artifacts.length
        ? `${state.artifacts.length} files`
        : `${artifacts.length} of ${state.artifacts.length}`;
    $("#artifact-empty").hidden = state.artifacts.length > 0;
    $("#artifact-browser").hidden = state.artifacts.length === 0;
    $("#artifact-no-results").hidden =
      state.artifacts.length === 0 || artifacts.length > 0;
    const list = $("#artifact-list");
    list.replaceChildren();
    for (const artifact of artifacts) {
      const classification = artifact.classification ?? {};
      const item = element("li");
      const button = element("button", "artifact-item");
      button.type = "button";
      button.append(
        element("strong", "", artifact.name),
        element(
          "span",
          "artifact-item__type",
          `${classification.type ?? artifact.mime} · ${formatBytes(artifact.size)}`,
        ),
        element(
          "p",
          "artifact-item__purpose",
          classification.purpose ?? "생성된 디자인 산출물입니다.",
        ),
        element(
          "span",
          "artifact-item__audience",
          (classification.audiences ?? ["개발자"]).join(" · "),
        ),
        element("code", "", artifact.path),
      );
      button.addEventListener("click", () => void previewArtifact(artifact));
      item.append(button);
      list.append(item);
    }
  }

  function renderLayout(job) {
    const panel = $("#layout-panel");
    const layout = job?.layout;
    const visible =
      job?.status === "succeeded" && layout && layout.status !== "disabled";
    panel.hidden = !visible;
    if (!visible) return;

    $("#layout-status-badge").textContent =
      layout.status === "succeeded" ? "추출 완료" : "추출 실패";

    const bpWrap = $("#layout-breakpoints");
    bpWrap.replaceChildren();
    for (const bp of layout.breakpoints ?? []) {
      const chip = element("span", "layout-chip");
      chip.append(
        element("strong", "", bp.name),
        element("span", "layout-chip__width", `${bp.width}px`),
        element(
          "span",
          "layout-chip__meta",
          `${bp.nodes ?? "—"} nodes · ${bp.scrollHeight ?? "—"}px`,
        ),
      );
      bpWrap.append(chip);
    }

    const find = (suffix) =>
      state.artifacts.find((artifact) => artifact.name.endsWith(suffix));

    const frame = $("#layout-wireframe-frame");
    frame.replaceChildren();
    const wireframe = find("-wireframe.svg");
    if (wireframe) {
      const img = element("img");
      img.src = artifactUrl(wireframe);
      img.alt = "Desktop layout wireframe";
      img.loading = "lazy";
      frame.append(img);
    } else {
      frame.append(
        element(
          "p",
          "empty-inline",
          layout.status === "failed"
            ? layout.error || "레이아웃 추출에 실패했습니다."
            : "와이어프레임을 사용할 수 없습니다.",
        ),
      );
    }

    const files = $("#layout-files");
    files.replaceChildren();
    const defs = [
      ["-layout-skeleton.html", "HTML 스켈레톤", "시맨틱 구조 재현"],
      ["-layout.css", "반응형 CSS", "브레이크포인트별 grid/flex"],
      ["-layout.json", "레이아웃 데이터", "원본 트리(JSON)"],
      ["-wireframe.svg", "와이어프레임 SVG", "벡터 구조도"],
    ];
    for (const [suffix, title, desc] of defs) {
      const artifact = find(suffix);
      const row = element("div", "layout-file");
      row.append(element("strong", "", title), element("span", "", desc));
      const actions = element("span", "layout-file__actions");
      if (artifact) {
        if (artifact.previewable) {
          const preview = element("button", "", "Preview");
          preview.type = "button";
          preview.addEventListener("click", () => {
            void previewArtifact(artifact);
            $("#artifact-panel").scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          });
          actions.append(preview);
        }
        const download = element("a", "", "Download");
        download.href = artifactUrl(artifact, true);
        download.download = "";
        actions.append(download);
      } else {
        actions.append(
          element("span", "availability-badge is-unavailable", "Unavailable"),
        );
      }
      row.append(actions);
      files.append(row);
    }
  }

  function syncArtifactCategoryButtons() {
    for (const button of $("#artifact-categories").querySelectorAll("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.category === state.artifactCategory),
      );
    }
  }

  async function copyArtifactPath() {
    const path = state.selectedJob?.artifactPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      $("#copy-artifact-path").textContent = "Copied";
      announce("산출물 폴더 경로를 복사했습니다.");
    } catch {
      const input = document.createElement("textarea");
      input.value = path;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      $("#copy-artifact-path").textContent = "Copied";
      announce("산출물 폴더 경로를 복사했습니다.");
    }
    window.setTimeout(() => {
      $("#copy-artifact-path").textContent = "Copy path";
    }, 1600);
  }

  function artifactUrl(artifact, download = false) {
    const encodedPath = artifact.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `/api/jobs/${encodeURIComponent(state.selectedId)}/artifacts/${encodedPath}${download ? "?download=1" : ""}`;
  }

  function sanitizeArtifactHtml(source) {
    const document = new DOMParser().parseFromString(source, "text/html");
    document
      .querySelectorAll(
        "script, iframe, frame, object, embed, base, link, form, meta[http-equiv]",
      )
      .forEach((node) => node.remove());

    for (const node of document.querySelectorAll("*")) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name.startsWith("on") || name === "srcdoc") {
          node.removeAttribute(attribute.name);
        } else if (name === "src") {
          if (
            node.tagName !== "IMG" ||
            !/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);/i.test(value)
          ) {
            node.removeAttribute(attribute.name);
          }
        } else if (name === "href" && !value.startsWith("#")) {
          node.removeAttribute(attribute.name);
        } else if (name === "style") {
          node.setAttribute(
            "style",
            value.replace(/url\s*\([^)]*\)/gi, "none"),
          );
        }
      }
    }

    for (const style of document.querySelectorAll("style")) {
      style.textContent = style.textContent
        .replace(/@import[^;]+;?/gi, "")
        .replace(/url\s*\([^)]*\)/gi, "none");
    }

    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    document.head.prepend(policy);
    return `<!doctype html>${document.documentElement.outerHTML}`;
  }

  async function previewArtifact(artifact) {
    const preview = $("#preview-content");
    const url = artifactUrl(artifact);
    $("#preview-name").textContent = artifact.name;
    $("#preview-meta").textContent =
      `${artifact.mime} · ${formatBytes(artifact.size)}`;
    $("#download-artifact").hidden = false;
    $("#download-artifact").href = artifactUrl(artifact, true);
    preview.replaceChildren(element("p", "", "Loading preview…"));

    const extension = artifact.name.split(".").pop()?.toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension)) {
      const image = element("img");
      image.src = url;
      image.alt = `${artifact.name} 미리보기`;
      preview.replaceChildren(image);
      return;
    }
    if (extension === "html") {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const frame = element("iframe");
        frame.title = `${artifact.name} 미리보기`;
        frame.setAttribute("sandbox", "");
        frame.srcdoc = sanitizeArtifactHtml(await response.text());
        preview.replaceChildren(frame);
      } catch (error) {
        preview.replaceChildren(
          element("p", "error-message", `Preview failed: ${error.message}`),
        );
      }
      return;
    }
    if (extension === "pdf") {
      const frame = element("iframe");
      frame.src = url;
      frame.title = `${artifact.name} 미리보기`;
      frame.setAttribute("sandbox", "");
      preview.replaceChildren(frame);
      return;
    }
    if (
      ["md", "json", "css", "js", "mjs", "ts", "tsx", "txt"].includes(extension)
    ) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const text = await response.text();
        const code = element("pre", "", text.slice(0, 200000));
        preview.replaceChildren(code);
      } catch (error) {
        preview.replaceChildren(
          element("p", "error-message", `Preview failed: ${error.message}`),
        );
      }
      return;
    }
    preview.replaceChildren(
      element("p", "", "이 파일 형식은 다운로드로 확인하세요."),
    );
  }

  async function submitJob(event) {
    event.preventDefault();
    const submit = $("#submit-job");
    const input = $("#site-url");
    submit.disabled = true;
    submit.textContent = "Queueing…";
    try {
      const body = {
        url: input.value.trim(),
        options: {
          dark: $("#option-dark").checked,
          screenshots: $("#option-screenshots").checked,
          layout: $("#option-layout").checked,
          depth: Number.parseInt($("#option-depth").value, 10),
          wait: Number.parseInt($("#option-wait").value, 10),
        },
      };
      const data = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      input.removeAttribute("aria-invalid");
      announce(`${new URL(data.job.url).hostname} 작업을 큐에 추가했습니다.`);
      state.jobs.unshift(data.job);
      renderJobList();
      await selectJob(data.job.id);
      document.querySelector("#workspace").scrollIntoView({ behavior: "smooth" });
    } catch (error) {
      if (error.field === "url") {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
      announce(`작업을 만들지 못했습니다: ${error.message}`);
    } finally {
      submit.disabled = false;
      submit.textContent = "Run extraction";
    }
  }

  async function cancelSelected() {
    if (!state.selectedId) return;
    $("#cancel-job").disabled = true;
    try {
      const data = await api(
        `/api/jobs/${encodeURIComponent(state.selectedId)}/cancel`,
        { method: "POST" },
      );
      state.selectedJob = data.job;
      renderSelectedJob();
      announce("취소 요청을 보냈습니다.");
    } catch (error) {
      announce(`취소하지 못했습니다: ${error.message}`);
    } finally {
      $("#cancel-job").disabled = false;
    }
  }

  async function retrySelected() {
    if (!state.selectedId) return;
    $("#retry-job").disabled = true;
    try {
      const data = await api(
        `/api/jobs/${encodeURIComponent(state.selectedId)}/retry`,
        { method: "POST" },
      );
      announce("동일한 옵션으로 새 작업을 만들었습니다.");
      state.jobs.unshift(data.job);
      await selectJob(data.job.id);
    } catch (error) {
      announce(`재시도하지 못했습니다: ${error.message}`);
    } finally {
      $("#retry-job").disabled = false;
    }
  }

  async function deleteSelected() {
    if (!state.selectedId) return;
    const job = state.selectedJob;
    if (!window.confirm(`${job?.url || "이 작업"}의 이력과 산출물을 삭제할까요?`)) {
      return;
    }
    try {
      await api(`/api/jobs/${encodeURIComponent(state.selectedId)}`, {
        method: "DELETE",
      });
      announce("작업 이력을 삭제했습니다.");
      state.jobs = state.jobs.filter((item) => item.id !== state.selectedId);
      clearSelection();
      await loadJobs({ preserveSelection: false });
    } catch (error) {
      announce(`삭제하지 못했습니다: ${error.message}`);
    }
  }

  function setupMobileMenu() {
    const header = $(".site-header");
    const navigation = $(".nav-bar");
    const desktopLinks = $(".nav-bar__links");
    const status = $("#server-status");
    if (!header || !navigation || !desktopLinks) return;

    const toggle = element("button", "button", "Menu");
    toggle.type = "button";
    toggle.dataset.variant = "ghost";
    toggle.dataset.size = "sm";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "mobile-navigation");
    toggle.hidden = true;

    const panel = element("nav", "card shell mobile-navigation");
    panel.id = "mobile-navigation";
    panel.hidden = true;
    panel.setAttribute("aria-label", "모바일 탐색");
    for (const sourceLink of desktopLinks.querySelectorAll("a")) {
      const link = element("a", "", sourceLink.textContent);
      link.href = sourceLink.getAttribute("href");
      panel.append(link);
    }
    navigation.insertBefore(toggle, status);
    header.append(panel);

    const query = window.matchMedia("(max-width: 720px)");
    const close = (focus = false) => {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Menu";
      if (focus) toggle.focus();
    };
    const sync = () => {
      toggle.hidden = !query.matches;
      if (!query.matches) close();
    };
    toggle.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Close" : "Menu";
    });
    panel.addEventListener("click", (event) => {
      if (event.target instanceof HTMLAnchorElement) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) close(true);
    });
    query.addEventListener("change", sync);
    sync();
  }

  function updateDurationTimer() {
    clearInterval(state.durationTimer);
    if (state.selectedJob?.status === "running") {
      state.durationTimer = setInterval(() => {
        $("#meta-duration").textContent = formatDuration(state.selectedJob);
      }, 1000);
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") void loadJobs();
    }, 5000);
  }

  function bindEvents() {
    $("#extract-form").addEventListener("submit", submitJob);
    $("#refresh-jobs").addEventListener("click", () => void loadJobs());
    $("#status-filter").addEventListener("change", () =>
      void loadJobs({ preserveSelection: false }),
    );
    $("#cancel-job").addEventListener("click", cancelSelected);
    $("#retry-job").addEventListener("click", retrySelected);
    $("#delete-job").addEventListener("click", deleteSelected);
    $("#copy-artifact-path").addEventListener("click", () =>
      void copyArtifactPath(),
    );
    $("#analyze-project").addEventListener("click", () => void analyzeTarget());
    $("#apply-form").addEventListener("submit", startApplication);
    $("#apply-confirmed").addEventListener("change", updateApplyButton);
    $("#cancel-application").addEventListener("click", () =>
      void cancelApplication(),
    );
    $("#apply-target").addEventListener("input", () => {
      state.applyAnalysis = null;
      $("#compatibility-report").hidden = true;
      $("#apply-confirmed").checked = false;
      if (!state.currentApplication) {
        $("#application-run").hidden = true;
        $("#application-result").hidden = true;
        $("#application-log").textContent = "적용 로그가 여기에 표시됩니다.";
      }
      updateApplyButton();
    });
    $("#artifact-filter").addEventListener("input", (event) => {
      state.artifactFilter = event.target.value;
      renderArtifacts();
    });
    $("#artifact-categories").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-category]");
      if (!button) return;
      state.artifactCategory = button.dataset.category;
      syncArtifactCategoryButtons();
      renderArtifacts();
    });
    window.addEventListener("beforeunload", () => {
      closeEventStream();
      stopApplicationPolling();
    });
  }

  async function initialize() {
    bindEvents();
    setupMobileMenu();
    startPolling();
    await Promise.all([loadHealth(), loadJobs({ preserveSelection: false })]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void initialize(), {
      once: true,
    });
  } else {
    void initialize();
  }
})();
