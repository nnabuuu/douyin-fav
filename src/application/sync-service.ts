import crypto from "node:crypto";
import { resolvePlatform, videoUrl } from "../domain/model.js";
import { MAX_SYNC_PER_RUN, type SyncItem, type SyncRun } from "../domain/sync.js";
import type { Analyzer, ConfigStore, Exporter, Extractor, SyncStore, TokenStore } from "../domain/ports.js";
import type { TranscribeVideo } from "./transcribe-video.js";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => new Date().toISOString();

/**
 * Runtime auto-sync. Each round = scan folders → transcribe new videos (rotation/
 * failover) → export to Notion. Tracked as a SyncRun: live current item, per-video
 * records, cancellable, capped at MAX_SYNC_PER_RUN. History persists via SyncStore.
 */
export class SyncService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentRun: SyncRun | null = null;
  private cancelled = false;

  constructor(
    private config: ConfigStore,
    private store: TokenStore,
    private extractor: Extractor,
    private transcribe: TranscribeVideo,
    private analyzer: Analyzer,
    private exporter: Exporter,
    private syncStore: SyncStore,
  ) {}

  status() {
    const { enabled, intervalMin, perRun } = this.config.get().schedule;
    return {
      running: this.currentRun?.status === "running",
      scheduled: this.timer !== null,
      enabled, intervalMin, perRun, cap: Math.min(perRun, MAX_SYNC_PER_RUN),
      current: this.currentRun,                 // live run (current videoId + items so far)
      last: this.syncStore.listRuns(1)[0] ?? null,
    };
  }

  history(limit?: number): SyncRun[] { return this.syncStore.listRuns(limit); }
  getRun(id: string): SyncRun | undefined { return this.syncStore.getRun(id); }
  /** Cancel the in-progress round (finishes the current video, then stops). */
  cancel(): void { this.cancelled = true; }

  async runOnce(): Promise<SyncRun> {
    if (this.currentRun?.status === "running") throw new Error("上一轮还在跑。");
    const cfg = this.config.get();
    const cap = Math.min(cfg.schedule.perRun || 10, MAX_SYNC_PER_RUN);
    const run: SyncRun = {
      id: crypto.randomUUID().slice(0, 8), startedAt: now(), status: "running",
      cap, synced: 0, skipped: 0, failed: 0, items: [],
    };
    this.currentRun = run;
    this.cancelled = false;
    try {
      for (const folder of cfg.folders) {
        if (this.cancelled || run.synced >= cap) break;
        const platform = resolvePlatform(folder);
        if (!platform) { this.recordFail(run, "-", folder, "跳过未知平台"); continue; }
        const token = this.store.nextValid(platform);
        if (!token) { this.recordFail(run, "-", folder, `${platform} 无可用 token`); continue; }

        let items;
        try { items = await this.extractor.listCollection(folder, token, () => {}); }
        catch (e) { this.recordFail(run, "-", folder, `扫描失败: ${msg(e)}`); continue; }

        for (const it of items) {
          if (this.cancelled || run.synced >= cap) break;
          if (this.syncStore.isExported(it.videoId)) { run.skipped++; continue; } // fast local dedup

          const rec: SyncItem = { videoId: it.videoId, title: (it.desc || "").split("\n")[0] || it.videoId, status: "transcribing", at: now() };
          run.items.push(rec);
          run.current = it.videoId;
          try {
            if (await this.exporter.has(it.videoId)) { this.syncStore.markExported(it.videoId); rec.status = "skipped"; run.skipped++; continue; }
            const result = await this.transcribe.run(videoUrl(platform, it.videoId), (m) => { rec.step = m; });
            if (!rec.title || rec.title === it.videoId) rec.title = result.title || rec.title;
            const { cleaned, summary } = await this.analyzer.analyze(result);
            const outcome = await this.exporter.export(result, cleaned, summary);
            if (outcome === "created") { this.syncStore.markExported(it.videoId); rec.status = "exported"; run.synced++; }
            else { rec.status = "skipped"; run.skipped++; } // "skipped" w/o has() = Notion not configured → don't mark done
          } catch (e) {
            rec.status = "failed"; rec.reason = msg(e); run.failed++; // one failure never aborts the round
          }
        }
      }
      run.status = this.cancelled ? "stopped" : "done";
    } catch (e) {
      run.status = "error"; run.error = msg(e);
    } finally {
      run.current = undefined;
      run.finishedAt = now();
      this.syncStore.saveRun(run);
    }
    return run;
  }

  private recordFail(run: SyncRun, videoId: string, title: string, reason: string): void {
    run.items.push({ videoId, title, status: "failed", reason, at: now() });
    run.failed++;
  }

  /** Self-rescheduling timer; re-reads intervalMin each loop so /config edits take effect. */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      try { await this.runOnce(); } catch { /* captured in the run record */ }
      this.timer = setTimeout(tick, this.intervalMs());
    };
    this.timer = setTimeout(tick, this.intervalMs());
  }
  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private intervalMs(): number { return Math.max(1, this.config.get().schedule.intervalMin) * 60_000; }
}
