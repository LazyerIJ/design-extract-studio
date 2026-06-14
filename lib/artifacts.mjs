import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { classifyArtifact } from "./artifact-classification.mjs";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".ts", "text/plain; charset=utf-8"],
  [".tsx", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

export function mimeTypeFor(path) {
  return MIME_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

export function isInlinePreviewable(path) {
  return new Set([
    ".html",
    ".md",
    ".json",
    ".css",
    ".js",
    ".mjs",
    ".ts",
    ".tsx",
    ".txt",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".pdf",
  ]).has(extname(path).toLowerCase());
}

export async function resolveArtifactPath(root, requestedPath) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw Object.assign(new Error("Invalid artifact path"), {
      code: "INVALID_ARTIFACT_PATH",
      statusCode: 400,
    });
  }
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw Object.assign(new Error("Artifact path is not valid URL encoding"), {
      code: "INVALID_ARTIFACT_PATH",
      statusCode: 400,
    });
  }
  if (
    decoded.startsWith("/") ||
    decoded.startsWith("\\") ||
    decoded.split(/[\\/]+/).includes("..")
  ) {
    throw Object.assign(new Error("Artifact path traversal is not allowed"), {
      code: "INVALID_ARTIFACT_PATH",
      statusCode: 400,
    });
  }

  let rootPath;
  try {
    rootPath = await realpath(root);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("Artifact not found"), {
        code: "ARTIFACT_NOT_FOUND",
        statusCode: 404,
      });
    }
    throw error;
  }
  const candidate = resolve(rootPath, decoded);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    throw Object.assign(new Error("Artifact path traversal is not allowed"), {
      code: "INVALID_ARTIFACT_PATH",
      statusCode: 400,
    });
  }
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw Object.assign(new Error("Artifact not found"), {
        code: "ARTIFACT_NOT_FOUND",
        statusCode: 404,
      });
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Object.assign(new Error("Artifact not found"), {
      code: "ARTIFACT_NOT_FOUND",
      statusCode: 404,
    });
  }
  const actual = await realpath(candidate);
  if (!actual.startsWith(`${rootPath}${sep}`)) {
    throw Object.assign(new Error("Artifact path traversal is not allowed"), {
      code: "INVALID_ARTIFACT_PATH",
      statusCode: 400,
    });
  }
  return actual;
}

export async function listArtifacts(root) {
  const output = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        const path = relative(root, absolute).split(sep).join("/");
        output.push({
          path,
          name: entry.name,
          size: info.size,
          mime: mimeTypeFor(path),
          previewable: isInlinePreviewable(path),
          modifiedAt: info.mtime.toISOString(),
          classification: classifyArtifact(path),
        });
      }
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return output;
}

function validPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(signature) &&
    buffer.toString("ascii", 12, 16) === "IHDR" &&
    buffer.readUInt32BE(16) > 0 &&
    buffer.readUInt32BE(20) > 0
  );
}

function validSvg(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 4096));
  return /<svg[\s>]/i.test(text);
}

export async function validateArtifacts(root) {
  const files = await listArtifacts(root);
  const result = {
    ok: files.length > 0,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    emptyFiles: [],
    json: { count: 0, valid: 0, invalid: [] },
    images: {
      pngCount: 0,
      invalidPng: [],
      svgCount: 0,
      invalidSvg: [],
    },
  };

  for (const file of files) {
    if (file.size === 0) result.emptyFiles.push(file.path);
    const extension = extname(file.path).toLowerCase();
    if (![".json", ".png", ".svg"].includes(extension)) continue;
    const buffer = await readFile(resolve(root, file.path));
    if (extension === ".json") {
      result.json.count += 1;
      try {
        JSON.parse(buffer.toString("utf8"));
        result.json.valid += 1;
      } catch (error) {
        result.json.invalid.push({ path: file.path, error: error.message });
      }
    } else if (extension === ".png") {
      result.images.pngCount += 1;
      if (!validPng(buffer)) result.images.invalidPng.push(file.path);
    } else if (extension === ".svg") {
      result.images.svgCount += 1;
      if (!validSvg(buffer)) result.images.invalidSvg.push(file.path);
    }
  }

  result.ok =
    result.fileCount > 0 &&
    result.emptyFiles.length === 0 &&
    result.json.invalid.length === 0 &&
    result.images.invalidPng.length === 0 &&
    result.images.invalidSvg.length === 0;
  return result;
}
