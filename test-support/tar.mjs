import { gunzipSync } from "node:zlib";

export function parseTarEntries(gzipBuffer) {
  const tar = gunzipSync(gzipBuffer);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const contentStart = offset + 512;
    entries.push({
      path,
      content: tar.subarray(contentStart, contentStart + size),
    });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
