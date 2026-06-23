import { resolvePlatform, videoUrl } from "../domain/model.js";
import type { Analyzer, ConfigStore, Exporter, Extractor, TokenStore } from "../domain/ports.js";
import type { TranscribeVideo } from "./transcribe-video.js";

export interface SyncError {
  id?: string;   // videoId when the failure is about a specific video
  reason: string;
}

export interface SyncSummary {
  at: string;
  synced: number;   // newly written to the exporter
  skipped: number;  // already present / cached
  failed: number;
  errors: SyncError[];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The runtime auto-sync: each round scans the configured folders, transcribes new
 * videos (rotation/failover via TranscribeVideo), analyzes (raw for now), and exports
 * to Notion (idempotent). Runs on its own timer — zero Claude Code dependency.
 */
export class SyncService {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: SyncSummary | null = null;

  constructor(
    private config: ConfigStore,
    private store: TokenStore,
    private extractor: Extractor,
    private transcribe: TranscribeVideo,
    private analyzer: Analyzer,
    private exporter: Exporter,
  ) {}

  status() {
    const { enabled, intervalMin, perRun } = this.config.get().schedule;
    return { running: this.running, scheduled: this.timer !== null, enabled, intervalMin, perRun, last: this.last };
  }

  async runOnce(log: (m: string) => void = () => {}): Promise<SyncSummary> {
    if (this.running) throw new Error("上一轮还在跑。");
    this.running = true;
    const summary: SyncSummary = { at: new Date().toISOString(), synced: 0, skipped: 0, failed: 0, errors: [] };
    try {
      const cfg = this.config.get();
      let budget = cfg.schedule.perRun; // counts only NEW transcriptions (cache hits are free)
      for (const folder of cfg.folders) {
        const platform = resolvePlatform(folder);
        if (!platform) { summary.errors.push({ reason: `跳过未知平台: ${folder}` }); continue; }
        const token = this.store.nextValid(platform);
        if (!token) { summary.errors.push({ reason: `${platform} 无可用 token` }); continue; }

        let items;
        try { items = await this.extractor.listCollection(folder, token, log); }
        catch (e) { summary.errors.push({ reason: `扫描失败 ${folder}: ${msg(e)}` }); continue; }

        for (const it of items) {
          if (budget <= 0) { log("到达本轮上限"); break; }
          try {
            if (await this.exporter.has(it.videoId)) { summary.skipped++; continue; }
            const result = await this.transcribe.run(videoUrl(platform, it.videoId), log);
            const { cleaned, summary: sum } = await this.analyzer.analyze(result);
            const r = await this.exporter.export(result, cleaned, sum);
            if (r === "created") summary.synced++; else summary.skipped++;
            if (!result.cached) budget--; // only fresh ASR/scrape costs budget
          } catch (e) {
            summary.failed++;
            summary.errors.push({ id: it.videoId, reason: msg(e) }); // single failure never aborts the round
          }
        }
      }
    } finally {
      this.running = false;
      this.last = summary;
    }
    return summary;
  }

  /** Self-rescheduling timer; re-reads intervalMin each loop so /config edits take effect. */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      try { await this.runOnce(); } catch { /* captured in summary */ }
      this.timer = setTimeout(tick, this.intervalMs());
    };
    this.timer = setTimeout(tick, this.intervalMs());
  }
  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private intervalMs(): number { return Math.max(1, this.config.get().schedule.intervalMin) * 60_000; }
}
