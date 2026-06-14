import { constants, createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { listArtifacts } from "./artifacts.mjs";

const BLOCK_SIZE = 512;

function archiveError(message, code = "ARCHIVE_ERROR") {
  return Object.assign(new Error(message), { code, statusCode: 500 });
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const split = separators[index];
    const prefix = path.slice(0, split);
    const name = path.slice(split + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw archiveError(`Artifact path is too long for tar: ${path}`, "ARCHIVE_PATH_TOO_LONG");
}

function writeString(buffer, value, offset, length) {
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer, value, offset, length) {
  const octal = Math.max(0, value).toString(8);
  const encoded = `${octal.padStart(length - 1, "0")}\0`;
  writeString(buffer, encoded.slice(-(length)), offset, length);
}

function tarHeader(path, size, modifiedAt) {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.floor(modifiedAt.getTime() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, "ustar\0", 257, 6);
  writeString(header, "00", 263, 2);
  writeString(header, "design-extract", 265, 32);
  writeString(header, "design-extract", 297, 32);
  writeString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, checksumText, 148, 8);
  return header;
}

export async function collectArchiveEntries(root) {
  const rootPath = await realpath(root);
  const artifacts = await listArtifacts(rootPath);
  const entries = [];
  for (const artifact of artifacts) {
    const path = artifact.path.replaceAll("\\", "/");
    if (
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\0")
    ) {
      continue;
    }
    const candidate = resolve(rootPath, path);
    if (!candidate.startsWith(`${rootPath}${sep}`)) continue;
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const actual = await realpath(candidate);
    if (!actual.startsWith(`${rootPath}${sep}`)) continue;
    splitUstarPath(path);
    entries.push({
      path,
      absolutePath: actual,
      size: info.size,
      modifiedAt: info.mtime,
    });
  }
  return entries;
}

export async function createArtifactBundle(root) {
  const entries = await collectArchiveEntries(root);
  async function* tarStream() {
    for (const entry of entries) {
      yield tarHeader(entry.path, entry.size, entry.modifiedAt);
      for await (const chunk of createReadStream(entry.absolutePath, {
        flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      })) {
        yield chunk;
      }
      const padding = (BLOCK_SIZE - (entry.size % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(BLOCK_SIZE * 2);
  }
  return {
    entries,
    stream: Readable.from(tarStream()).pipe(createGzip({ level: 6 })),
  };
}
