import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncStore } from "../domain/ports.js";
import type { SyncRun } from "../domain/sync.js";

const DEFAULT_FILE = path.join(os.homedir(), ".douyin-sync", "sync-runs.json");
const KEEP = 50; // ponytail: keep last 50 runs; bump if you want deeper history

/** JSON-backed sync history + a set of already-exported videoIds (local dedup). */
export class FileSyncStore implements SyncStore {
  private runs: SyncRun[] = [];   // most recent first
  private exported = new Set<string>();

  constructor(private file = DEFAULT_FILE) { // file injectable for tests
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      this.runs = Array.isArray(d.runs) ? d.runs : [];
      this.exported = new Set(Array.isArray(d.exported) ? d.exported : []);
    } catch { /* first run */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ runs: this.runs.slice(0, KEEP), exported: [...this.exported] }, null, 2), "utf-8");
  }

  listRuns(limit = KEEP): SyncRun[] { return this.runs.slice(0, limit); }
  getRun(id: string): SyncRun | undefined { return this.runs.find((r) => r.id === id); }

  saveRun(run: SyncRun): void {
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.runs[i] = run; else this.runs.unshift(run);
    if (this.runs.length > KEEP) this.runs = this.runs.slice(0, KEEP);
    this.save();
  }

  isExported(videoId: string): boolean { return this.exported.has(videoId); }
  markExported(videoId: string): void { this.exported.add(videoId); } // persisted on next saveRun
}
