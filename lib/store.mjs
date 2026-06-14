import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export class JobStore {
  constructor(jobsDir) {
    this.jobsDir = jobsDir;
  }

  async initialize() {
    await mkdir(this.jobsDir, { recursive: true });
  }

  jobDir(id) {
    return join(this.jobsDir, id);
  }

  artifactDir(id) {
    return join(this.jobDir(id), "artifacts");
  }

  jobFile(id) {
    return join(this.jobDir(id), "job.json");
  }

  logFile(id) {
    return join(this.jobDir(id), "job.log");
  }

  async create(job) {
    await mkdir(this.artifactDir(job.id), { recursive: true });
    await this.save(job);
    await writeFile(this.logFile(job.id), "", { flag: "a", mode: 0o600 });
  }

  async save(job) {
    const directory = this.jobDir(job.id);
    await mkdir(directory, { recursive: true });
    const target = this.jobFile(job.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async appendLog(id, line) {
    await appendFile(this.logFile(id), `${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async readLogTail(id, maxBytes = 64 * 1024) {
    try {
      const buffer = await readFile(this.logFile(id));
      return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  async loadAll() {
    await this.initialize();
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const job = JSON.parse(await readFile(this.jobFile(entry.name), "utf8"));
        jobs.push(job);
      } catch {
        // Ignore incomplete or manually damaged entries; their files remain on disk.
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async remove(id) {
    await rm(this.jobDir(id), { recursive: true, force: true });
  }
}
