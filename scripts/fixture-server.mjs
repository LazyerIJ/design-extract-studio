import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixture");
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const server = createServer(async (request, response) => {
  const [file, type] = files.get(new URL(request.url, "http://localhost").pathname) ?? [];
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }
  const path = join(root, file);
  const info = await stat(path);
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "no-store",
  });
  createReadStream(path).pipe(response);
});

server.listen(4220, "127.0.0.1", () => {
  console.log("Fixture listening on http://127.0.0.1:4220");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
