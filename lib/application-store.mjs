import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export class ApplicationStore {
  constructor(root) {
    this.root = root;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
  }

  directory(id) {
    return join(this.root, id);
  }

  file(id, name) {
    return join(this.directory(id), name);
  }

  async create(application) {
    await mkdir(this.directory(application.id), { recursive: true });
    await this.save(application);
    await writeFile(this.file(application.id, "application.log"), "", {
      flag: "a",
      mode: 0o600,
    });
  }

  async save(application) {
    await mkdir(this.directory(application.id), { recursive: true });
    const target = this.file(application.id, "application.json");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(application, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async writeData(id, name, value) {
    const target = this.file(id, name);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async appendLog(id, line) {
    await appendFile(this.file(id, "application.log"), `${line}\n`, {
      mode: 0o600,
    });
  }

  async readLogTail(id, maxBytes = 64 * 1024) {
    try {
      const buffer = await readFile(this.file(id, "application.log"));
      return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  async loadAll() {
    await this.initialize();
    const entries = await readdir(this.root, { withFileTypes: true });
    const applications = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        applications.push(
          JSON.parse(await readFile(this.file(entry.name, "application.json"), "utf8")),
        );
      } catch {
        // Preserve damaged entries for manual inspection.
      }
    }
    return applications.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
