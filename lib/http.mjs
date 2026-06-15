import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import {
  isInlinePreviewable,
  mimeTypeFor,
  resolveArtifactPath,
} from "./artifacts.mjs";
import { createArtifactBundle } from "./archive.mjs";
import {
  validateAnalyzeInput,
  validateApplicationId,
  validateApplicationInput,
  validateJobId,
  validateJobInput,
} from "./validation.mjs";

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.css", "app.css"],
  ["/app.js", "app.js"],
]);

function securityHeaders(api = false) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(api ? { "Cache-Control": "no-store" } : {}),
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    ...securityHeaders(true),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(data)}\n`);
}

function errorResponse(response, error) {
  const statusCode = error.statusCode ?? 500;
  sendJson(response, statusCode, {
    error: {
      code: error.code ?? (statusCode === 404 ? "NOT_FOUND" : "INTERNAL_ERROR"),
      message:
        statusCode >= 500 ? "Internal server error" : String(error.message),
      ...(error.field ? { field: error.field } : {}),
    },
  });
}

async function readJsonBody(request, limit) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("Content-Type must be application/json"), {
      code: "JSON_CONTENT_TYPE_REQUIRED",
      statusCode: 415,
    });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error("Request body is too large"), {
        code: "BODY_TOO_LARGE",
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), {
      code: "INVALID_JSON",
      statusCode: 400,
    });
  }
}

async function streamFile(request, response, path, options = {}) {
  const info = await stat(path);
  const headers = {
    ...securityHeaders(false),
    "Content-Type": mimeTypeFor(path),
    "Content-Length": info.size,
    "Cache-Control": options.noStore ? "no-store" : "no-cache",
  };
  if (options.download) {
    headers["Content-Disposition"] =
      `attachment; filename="${basename(path).replaceAll('"', "")}"`;
  } else if (options.sandbox) {
    headers["X-Frame-Options"] = "SAMEORIGIN";
    headers["Content-Security-Policy"] =
      "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:";
  } else if (options.appShell) {
    headers["Content-Security-Policy"] =
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'";
  }
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path).pipe(response);
}

async function safeStaticPath(root, relativePath) {
  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, relativePath);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  }
  const info = await stat(candidate);
  if (!info.isFile()) {
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  }
  const actual = await realpath(candidate);
  if (!actual.startsWith(`${rootPath}${sep}`)) {
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  }
  return actual;
}

function sseWrite(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function isLoopbackBind(host) {
  const normalized = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function assertTrustedMutation(request) {
  const host = String(request.headers.host ?? "");
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw Object.assign(new Error("A loopback Host header is required"), {
      code: "LOCAL_ORIGIN_REQUIRED",
      statusCode: 403,
    });
  }
  if (!isLoopbackBind(hostUrl.hostname)) {
    throw Object.assign(new Error("State-changing requests are localhost-only"), {
      code: "LOCAL_ORIGIN_REQUIRED",
      statusCode: 403,
    });
  }

  const origin = request.headers.origin;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      originUrl = null;
    }
    if (
      !originUrl ||
      !isLoopbackBind(originUrl.hostname) ||
      originUrl.host !== hostUrl.host
    ) {
      throw Object.assign(new Error("Cross-origin state changes are not allowed"), {
        code: "LOCAL_ORIGIN_REQUIRED",
        statusCode: 403,
      });
    }
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw Object.assign(new Error("Cross-origin state changes are not allowed"), {
      code: "LOCAL_ORIGIN_REQUIRED",
      statusCode: 403,
    });
  }
}

export function createAppServer({ config, manager, applicationManager = null }) {
  const exposeArtifactPath = isLoopbackBind(config.host);
  const applyEnabled = exposeArtifactPath && Boolean(applicationManager);
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const method = request.method ?? "GET";

    try {
      if (method === "POST" || method === "DELETE") {
        assertTrustedMutation(request);
      }
      if (method === "GET" && url.pathname === "/api/health") {
        const jobs = await manager.list();
        sendJson(response, 200, {
          ok: true,
          version: "1.0.0",
          uptimeSeconds: Math.round(process.uptime()),
          queue: {
            queued: jobs.filter((job) => job.status === "queued").length,
            running: jobs.filter((job) => job.status === "running").length,
            concurrency: config.maxConcurrentJobs,
          },
          codexAnalysis: config.enableCodexAnalysis,
          applyEnabled,
        });
        return;
      }

      const applicationRoute = url.pathname.match(/^\/api\/applications\/([^/]+)(.*)$/);
      if (applicationRoute) {
        if (!applyEnabled) {
          throw Object.assign(new Error("Project application is localhost-only"), {
            code: "APPLY_LOCALHOST_ONLY",
            statusCode: 403,
          });
        }
        const id = validateApplicationId(applicationRoute[1]);
        const suffix = applicationRoute[2] || "";
        const application = await applicationManager.get(id);
        if (!application) {
          throw Object.assign(new Error("Application not found"), {
            code: "APPLICATION_NOT_FOUND",
            statusCode: 404,
          });
        }
        if (method === "GET" && suffix === "") {
          sendJson(response, 200, { application });
          return;
        }
        if (method === "POST" && suffix === "/cancel") {
          sendJson(response, 200, {
            application: await applicationManager.cancel(id),
          });
          return;
        }
        if (method === "GET" && suffix === "/events") {
          response.writeHead(200, {
            ...securityHeaders(true),
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
          });
          response.write("retry: 2000\n\n");
          sseWrite(response, "snapshot", { type: "snapshot", application });
          const unsubscribe = applicationManager.subscribe(id, (event) =>
            sseWrite(response, event.type, event),
          );
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
          heartbeat.unref();
          request.on("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
          });
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/jobs") {
        const input = validateJobInput(
          await readJsonBody(request, config.bodyLimitBytes),
        );
        sendJson(response, 202, { job: await manager.create(input) });
        return;
      }

      if (method === "GET" && url.pathname === "/api/jobs") {
        const status = url.searchParams.get("status") || undefined;
        sendJson(response, 200, { jobs: await manager.list({ status }) });
        return;
      }

      const jobRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)(.*)$/);
      if (jobRoute) {
        const id = validateJobId(jobRoute[1]);
        const suffix = jobRoute[2] || "";
        const job = await manager.get(id);
        if (!job) {
          throw Object.assign(new Error("Job not found"), {
            code: "JOB_NOT_FOUND",
            statusCode: 404,
          });
        }

        if (method === "GET" && suffix === "") {
          sendJson(response, 200, {
            job: {
              ...job,
              ...(exposeArtifactPath && job.status === "succeeded"
                ? { artifactPath: manager.store.artifactDir(id) }
                : {}),
            },
          });
          return;
        }
        if (suffix === "/applications/analyze" && method === "POST") {
          if (!applyEnabled) {
            throw Object.assign(new Error("Project application is localhost-only"), {
              code: "APPLY_LOCALHOST_ONLY",
              statusCode: 403,
            });
          }
          if (job.status !== "succeeded") {
            throw Object.assign(new Error("A succeeded extraction job is required"), {
              code: "EXTRACTION_NOT_READY",
              statusCode: 409,
            });
          }
          const input = validateAnalyzeInput(
            await readJsonBody(request, config.bodyLimitBytes),
          );
          sendJson(response, 200, await applicationManager.analyze(id, input.targetPath));
          return;
        }
        if (suffix === "/applications" && method === "POST") {
          if (!applyEnabled) {
            throw Object.assign(new Error("Project application is localhost-only"), {
              code: "APPLY_LOCALHOST_ONLY",
              statusCode: 403,
            });
          }
          const input = validateApplicationInput(
            await readJsonBody(request, config.bodyLimitBytes),
          );
          sendJson(response, 202, {
            application: await applicationManager.create(id, input),
          });
          return;
        }
        if (suffix === "/applications" && method === "GET") {
          if (!applyEnabled) {
            throw Object.assign(new Error("Project application is localhost-only"), {
              code: "APPLY_LOCALHOST_ONLY",
              statusCode: 403,
            });
          }
          sendJson(response, 200, {
            applications: await applicationManager.list({ jobId: id }),
          });
          return;
        }
        if (method === "POST" && suffix === "/cancel") {
          sendJson(response, 200, { job: await manager.cancel(id) });
          return;
        }
        if (method === "POST" && suffix === "/retry") {
          sendJson(response, 202, { job: await manager.retry(id) });
          return;
        }
        if (method === "DELETE" && suffix === "") {
          await manager.remove(id);
          response.writeHead(204, securityHeaders(true));
          response.end();
          return;
        }
        if (method === "GET" && suffix === "/events") {
          response.writeHead(200, {
            ...securityHeaders(true),
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
          });
          response.write("retry: 2000\n\n");
          sseWrite(response, "snapshot", { type: "snapshot", job });
          const unsubscribe = manager.subscribe(id, (event) =>
            sseWrite(response, event.type, event),
          );
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
          heartbeat.unref();
          request.on("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
          });
          return;
        }
        if (method === "GET" && suffix === "/artifacts") {
          sendJson(response, 200, { artifacts: await manager.artifacts(id) });
          return;
        }
        if (
          (method === "GET" || method === "HEAD") &&
          suffix === "/artifacts-download"
        ) {
          if (job.status !== "succeeded") {
            throw Object.assign(new Error("Only succeeded jobs can be downloaded"), {
              code: "ARTIFACTS_NOT_READY",
              statusCode: 409,
            });
          }
          const filename = `designlang-${id}-artifacts.tar.gz`;
          const bundle = await createArtifactBundle(manager.store.artifactDir(id));
          if (bundle.entries.length === 0) {
            throw Object.assign(new Error("No artifacts available"), {
              code: "ARTIFACTS_EMPTY",
              statusCode: 404,
            });
          }
          response.writeHead(200, {
            ...securityHeaders(true),
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="${filename}"`,
          });
          if (method === "HEAD") {
            bundle.stream.destroy();
            response.end();
            return;
          }
          bundle.stream.on("error", () => response.destroy());
          bundle.stream.pipe(response);
          return;
        }
        if (
          (method === "GET" || method === "HEAD") &&
          suffix.startsWith("/artifacts/")
        ) {
          const requestedPath = suffix.slice("/artifacts/".length);
          const path = await resolveArtifactPath(
            manager.store.artifactDir(id),
            requestedPath,
          );
          await streamFile(request, response, path, {
            download: url.searchParams.get("download") === "1",
            noStore: true,
            sandbox:
              url.searchParams.get("download") !== "1" &&
              [".html", ".svg"].includes(extname(path).toLowerCase()),
          });
          return;
        }
      }

      if ((method === "GET" || method === "HEAD") && url.pathname.startsWith("/source-assets/")) {
        const requested = url.pathname.slice("/source-assets/".length);
        const path = await safeStaticPath(config.sourceAssetsDir, requested);
        await streamFile(request, response, path);
        return;
      }

      if ((method === "GET" || method === "HEAD") && STATIC_FILES.has(url.pathname)) {
        const path = join(config.projectDir, STATIC_FILES.get(url.pathname));
        await streamFile(request, response, path, {
          appShell: extname(path).toLowerCase() === ".html",
        });
        return;
      }

      throw Object.assign(new Error("Not found"), {
        code: "NOT_FOUND",
        statusCode: 404,
      });
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error);
      else response.destroy();
    }
  });
}
