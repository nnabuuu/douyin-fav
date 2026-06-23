/* Sync run records — one round of auto-sync, with per-video item records. */

export type SyncItemStatus = "transcribing" | "exported" | "skipped" | "failed";

export interface SyncItem {
  videoId: string;
  title: string;
  status: SyncItemStatus;
  step?: string;   // latest progress line while transcribing (e.g. "下载 + ASR…")
  reason?: string; // failure reason
  at: string;
}

export type SyncRunStatus = "running" | "done" | "stopped" | "error";

export interface SyncRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: SyncRunStatus;
  cap: number;            // max new syncs this round
  synced: number;         // newly written to Notion
  skipped: number;        // already present (Notion or local index)
  failed: number;
  current?: string;       // videoId being processed right now
  items: SyncItem[];      // one per video touched this round
  error?: string;
}

/** Hard ceiling on new syncs per round, regardless of configured perRun. */
export const MAX_SYNC_PER_RUN = 100;
