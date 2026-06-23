import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const DIR = path.join(os.homedir(), ".douyin-sync");
fs.mkdirSync(DIR, { recursive: true });

const db = new Database(path.join(DIR, "state.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS processed (
    aweme_id     TEXT PRIMARY KEY,
    title        TEXT,
    author       TEXT,
    share_url    TEXT,
    method       TEXT,
    status       TEXT,   -- 'done' | 'failed'
    error        TEXT,
    processed_at TEXT
  )
`);

/** Only 'done' blocks reprocessing — failed items get retried next run. */
export function isProcessed(awemeId: string): boolean {
  const row = db
    .prepare("SELECT status FROM processed WHERE aweme_id = ?")
    .get(awemeId) as { status: string } | undefined;
  return row?.status === "done";
}

export function markDone(rec: {
  awemeId: string;
  title: string;
  author: string;
  shareUrl: string;
  method: string;
}): void {
  db.prepare(
    `INSERT INTO processed (aweme_id, title, author, share_url, method, status, error, processed_at)
     VALUES (@awemeId, @title, @author, @shareUrl, @method, 'done', NULL, @ts)
     ON CONFLICT(aweme_id) DO UPDATE SET
       title=@title, author=@author, share_url=@shareUrl, method=@method,
       status='done', error=NULL, processed_at=@ts`,
  ).run({ ...rec, ts: new Date().toISOString() });
}

export function markFailed(awemeId: string, error: string): void {
  db.prepare(
    `INSERT INTO processed (aweme_id, status, error, processed_at)
     VALUES (@awemeId, 'failed', @error, @ts)
     ON CONFLICT(aweme_id) DO UPDATE SET
       status='failed', error=@error, processed_at=@ts`,
  ).run({ awemeId, error, ts: new Date().toISOString() });
}
