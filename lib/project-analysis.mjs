import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { listArtifacts } from "./artifacts.mjs";
import { runProcess } from "./process-utils.mjs";

const SUPPORTED_FRAMEWORKS = new Set([
  "next",
  "vite-react",
  "vite-vue",
  "vite-svelte",
  "vite",
  "react",
  "vue",
  "svelte",
  "html",
]);

function analysisError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function regularFile(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!isInside(root, absolute)) return false;
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const actual = await realpath(absolute);
    return isInside(root, actual);
  } catch {
    return false;
  }
}

async function readTextIfFile(root, relativePath, limit = 1024 * 1024) {
  if (!(await regularFile(root, relativePath))) return null;
  const buffer = await readFile(resolve(root, relativePath));
  if (buffer.length > limit) return null;
  return buffer.toString("utf8");
}

async function readJsonIfFile(root, relativePath) {
  const text = await readTextIfFile(root, relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dependencyMap(packageJson) {
  return {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.peerDependencies ?? {}),
  };
}

function detectFramework(packageJson, files) {
  const dependencies = dependencyMap(packageJson);
  const evidence = [];
  const has = (name) => {
    if (dependencies[name]) evidence.push(`package:${name}`);
    return Boolean(dependencies[name]);
  };
  const next = has("next");
  const react = has("react");
  const vue = has("vue");
  const svelte = has("svelte") || has("@sveltejs/kit");
  const vite = has("vite") || files.some((file) => /^vite\.config\./.test(file));

  let name = "unknown";
  if (next) name = "next";
  else if (vite && react) name = "vite-react";
  else if (vite && vue) name = "vite-vue";
  else if (vite && svelte) name = "vite-svelte";
  else if (vite) name = "vite";
  else if (react) name = "react";
  else if (vue) name = "vue";
  else if (svelte) name = "svelte";
  else if (files.includes("index.html")) {
    name = "html";
    evidence.push("file:index.html");
  }
  return { name, evidence };
}

function cssImports(source) {
  if (!source) return [];
  const output = [];
  for (const match of source.matchAll(
    /(?:import\s+(?:[^'"]+\s+from\s+)?|import\s*\()\s*['"]([^'"]+\.css)['"]/g,
  )) {
    output.push(match[1]);
  }
  return output;
}

async function importedCssCandidates(root) {
  const entries = [
    "src/main.tsx",
    "src/main.jsx",
    "src/main.ts",
    "src/main.js",
    "src/index.tsx",
    "src/index.jsx",
    "src/index.ts",
    "src/index.js",
    "pages/_app.tsx",
    "pages/_app.jsx",
    "pages/_app.ts",
    "pages/_app.js",
    "src/pages/_app.tsx",
    "src/pages/_app.jsx",
  ];
  const candidates = [];
  for (const entry of entries) {
    const source = await readTextIfFile(root, entry);
    if (!source) continue;
    for (const imported of cssImports(source)) {
      if (!imported.startsWith(".")) continue;
      const resolved = relative(root, resolve(root, dirname(entry), imported)).split(sep).join("/");
      if (await regularFile(root, resolved)) {
        candidates.push({ path: resolved, evidence: `import:${entry}` });
      }
    }
  }
  return candidates;
}

async function htmlCssCandidates(root) {
  const source = await readTextIfFile(root, "index.html");
  if (!source) return [];
  const candidates = [];
  for (const match of source.matchAll(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"'?#]+)["'][^>]*>/gi,
  )) {
    const href = match[1];
    if (/^(?:https?:|\/\/|data:)/i.test(href)) continue;
    const path = href.replace(/^\.\//, "").replace(/^\//, "");
    if (await regularFile(root, path)) {
      candidates.push({ path, evidence: "link:index.html" });
    }
  }
  return candidates;
}

async function detectCssEntry(root, framework) {
  const imported = await importedCssCandidates(root);
  if (framework === "html") imported.push(...(await htmlCssCandidates(root)));
  const commonByFramework = {
    next: [
      "app/globals.css",
      "src/app/globals.css",
      "styles/globals.css",
      "src/styles/globals.css",
    ],
    "vite-react": ["src/index.css", "src/main.css", "src/App.css"],
    "vite-vue": ["src/assets/main.css", "src/style.css", "src/main.css"],
    "vite-svelte": ["src/app.css", "src/style.css"],
    vite: ["src/style.css", "src/index.css", "src/main.css"],
    react: ["src/index.css", "src/App.css"],
    vue: ["src/assets/main.css", "src/style.css"],
    svelte: ["src/app.css", "src/style.css"],
    html: ["styles.css", "style.css", "css/styles.css"],
  };
  const common = [];
  for (const path of commonByFramework[framework] ?? []) {
    if (await regularFile(root, path)) {
      common.push({ path, evidence: `convention:${framework}` });
    }
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of [...imported, ...common]) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    unique.push(candidate);
  }
  const importedUnique = unique.filter((item) => item.evidence.startsWith("import:") || item.evidence.startsWith("link:"));
  const selected =
    importedUnique.length === 1
      ? importedUnique[0]
      : importedUnique.length === 0 && common.length === 1
        ? common[0]
        : null;
  return {
    entry: selected?.path ?? null,
    confidence: selected ? "high" : unique.length ? "ambiguous" : "none",
    evidence: selected?.evidence ?? null,
    candidates: unique,
  };
}

function detectPackageManager(files, packageJson) {
  const choices = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
    ["bun", "bun.lockb"],
    ["bun", "bun.lock"],
  ];
  for (const [name, lockfile] of choices) {
    if (files.includes(lockfile)) return { name, lockfile };
  }
  const declared = String(packageJson?.packageManager ?? "").split("@")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) {
    return { name: declared, lockfile: null };
  }
  return packageJson ? { name: "npm", lockfile: null } : { name: null, lockfile: null };
}

function detectTailwind(packageJson, cssSource, files) {
  const dependencies = dependencyMap(packageJson);
  const versionText = dependencies.tailwindcss ?? null;
  const versionMatch = String(versionText ?? "").match(/(\d+)/);
  const version = versionMatch ? Number.parseInt(versionMatch[1], 10) : null;
  const directives = /@tailwind\s|@import\s+["']tailwindcss["']/.test(cssSource ?? "");
  const config = files.find((file) => /^tailwind\.config\./.test(file)) ?? null;
  return {
    detected: Boolean(versionText || directives || config),
    version: version ?? (/@import\s+["']tailwindcss["']/.test(cssSource ?? "") ? 4 : null),
    config,
    directives,
  };
}

export async function resolveProjectTarget(targetInput, options = {}) {
  if (typeof targetInput !== "string" || !isAbsolute(targetInput)) {
    throw analysisError("Target must be an absolute path", "TARGET_NOT_ABSOLUTE");
  }
  const inputInfo = await lstat(targetInput).catch(() => null);
  if (!inputInfo || !inputInfo.isDirectory() || inputInfo.isSymbolicLink()) {
    throw analysisError("Target must be an existing real directory", "TARGET_INVALID");
  }
  const targetPath = await realpath(targetInput);
  const rootPath = await realpath(resolve("/"));
  const homePath = await realpath(options.homeDir ?? homedir());
  const studioPath = await realpath(options.studioRoot);
  if (targetPath === rootPath) {
    throw analysisError("Filesystem root cannot be a target", "TARGET_FORBIDDEN");
  }
  if (targetPath === homePath) {
    throw analysisError("Home directory itself cannot be a target", "TARGET_FORBIDDEN");
  }
  if (isInside(studioPath, targetPath) || isInside(targetPath, studioPath)) {
    throw analysisError(
      "Design Extract Studio or a directory containing it cannot be a target",
      "TARGET_FORBIDDEN",
    );
  }

  const gitResult = await runProcess("git", ["rev-parse", "--show-toplevel"], {
    cwd: targetPath,
    timeoutMs: 10000,
  }).catch(() => null);
  if (!gitResult || gitResult.exitCode !== 0) {
    throw analysisError("Target must be inside a Git repository", "GIT_REQUIRED");
  }
  const gitRoot = await realpath(gitResult.stdout.trim());
  if (!isInside(gitRoot, targetPath)) {
    throw analysisError("Target is outside its resolved Git root", "TARGET_INVALID");
  }
  return { targetPath, gitRoot };
}

export async function analyzeProject(targetInput, options) {
  const { targetPath, gitRoot } = await resolveProjectTarget(targetInput, options);
  const entries = await readdir(targetPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const packageJson = await readJsonIfFile(targetPath, "package.json");
  const framework = detectFramework(packageJson, files);
  const css = await detectCssEntry(targetPath, framework.name);
  const cssSource = css.entry ? await readTextIfFile(targetPath, css.entry) : null;
  if (css.entry && cssSource !== null) css.sha256 = sha256(cssSource);
  const packageManager = detectPackageManager(files, packageJson);
  const statusResult = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: gitRoot,
    timeoutMs: 10000,
  });
  const dirtyEntries = statusResult.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const scripts = {};
  for (const name of ["build", "lint", "test"]) {
    if (typeof packageJson?.scripts?.[name] === "string") scripts[name] = name;
  }
  const tailwind = detectTailwind(packageJson, cssSource, files);
  const shadcn = {
    detected: await regularFile(targetPath, "components.json"),
    config: (await regularFile(targetPath, "components.json")) ? "components.json" : null,
  };

  return {
    schemaVersion: 1,
    targetPath,
    git: { root: gitRoot, clean: dirtyEntries.length === 0, dirtyEntries },
    packageManager,
    packageJson: packageJson
      ? { name: packageJson.name ?? null, private: packageJson.private === true }
      : null,
    framework,
    css,
    tailwind,
    shadcn,
    scripts,
  };
}

function artifactMatch(path, suffixes, predicate = null) {
  const normalized = path.toLowerCase();
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`-${suffix}`)) &&
    (!predicate || predicate(normalized));
}

export async function selectApplyArtifacts(artifactRoot) {
  const root = await realpath(artifactRoot);
  const files = await listArtifacts(root);
  const roles = [
    ["reset.css", ["reset.css"]],
    ["variables.css", ["variables.css"]],
    ["theme.css", ["shadcn-theme.css", "theme.css"]],
    ["motion.css", ["motion.css"], (path) => !path.includes(".motion.")],
    ["design-tokens.json", ["design-tokens.json", "tokens.json"], (path) => !path.includes("motion")],
    ["design-language.md", ["design-language.md"]],
  ];
  const selected = [];
  for (const [role, suffixes, predicate] of roles) {
    const matches = files.filter((file) => artifactMatch(file.path, suffixes, predicate));
    if (matches.length > 0) {
      const file = matches.sort((a, b) => a.path.localeCompare(b.path))[0];
      selected.push({
        role,
        sourcePath: file.path,
        absoluteSourcePath: resolve(root, file.path),
        targetPath: `.design-system/artifacts/${role}`,
        size: file.size,
      });
    }
  }
  return selected;
}

export function evaluateCompatibility(analysis, artifacts) {
  const blockers = [];
  const warnings = [];
  if (!SUPPORTED_FRAMEWORKS.has(analysis.framework.name)) {
    blockers.push("지원되는 웹 프레임워크를 확인할 수 없습니다.");
  }
  if (!analysis.css.entry || analysis.css.confidence !== "high") {
    blockers.push("수정할 CSS entry를 하나로 확정할 수 없습니다.");
  }
  if (!artifacts.some((artifact) => artifact.role === "variables.css")) {
    blockers.push("variables.css 산출물이 없습니다.");
  }
  if (!analysis.git.clean) {
    blockers.push("Git worktree가 clean 상태가 아닙니다.");
  }
  if (analysis.tailwind.detected) {
    warnings.push(`Tailwind${analysis.tailwind.version ? ` v${analysis.tailwind.version}` : ""} 프로젝트입니다. 토큰 설치 후 유틸리티 매핑을 검토하세요.`);
  }
  if (analysis.shadcn.detected) {
    warnings.push("shadcn/ui가 감지되었습니다. 컴포넌트 적응은 AI assisted가 필요할 수 있습니다.");
  }
  const technicalPartial = analysis.tailwind.detected || analysis.shadcn.detected;
  return {
    status: blockers.length ? "unsupported" : technicalPartial ? "partial" : "supported",
    safeInstall: blockers.length === 0,
    aiAssisted: blockers.length === 0,
    blockers,
    warnings,
  };
}

export function createApplyPlan(analysis, artifacts, compatibility) {
  const cssArtifacts = artifacts.filter((artifact) => artifact.role.endsWith(".css"));
  return {
    schemaVersion: 1,
    managedDirectory: ".design-system",
    cssEntry: analysis.css.entry,
    artifacts,
    changes: [
      ...artifacts.map((artifact) => ({
        action: "copy",
        source: artifact.sourcePath,
        target: artifact.targetPath,
      })),
      ...(compatibility.safeInstall
        ? [{
            action: "update-imports",
            target: analysis.css.entry,
            imports: cssArtifacts.map((artifact) => artifact.targetPath),
          }]
        : []),
    ],
  };
}

export async function analyzeApplyRequest({ targetPath, artifactRoot, studioRoot, homeDir }) {
  const analysis = await analyzeProject(targetPath, { studioRoot, homeDir });
  const artifacts = await selectApplyArtifacts(artifactRoot);
  const compatibility = evaluateCompatibility(analysis, artifacts);
  const plan = createApplyPlan(analysis, artifacts, compatibility);
  return { analysis, compatibility, plan };
}
