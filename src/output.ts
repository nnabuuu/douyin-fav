import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { TranscriptResult } from "./types.js";

export const OUTPUT_ROOT = path.join(os.homedir(), "douyin-transcripts");

/** Keep CJK, strip filesystem-hostile chars, cap length. */
function slugify(s: string): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|\n\r\t]/g, "")
    .replace(/\s+/g, "-")
    .trim();
  return cleaned.slice(0, 40) || "untitled";
}

/** Organized by PROCESSING date (matches resume-digest habit), not publish date. */
export function writeTranscript(r: TranscriptResult): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish; see note below)
  const dir = path.join(OUTPUT_ROOT, day);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${r.awemeId}-${slugify(r.title)}.md`);
  const frontmatter =
    "---\n" +
    `aweme_id: ${r.awemeId}\n` +
    `title: ${JSON.stringify(r.title)}\n` +
    `author: ${JSON.stringify(r.author)}\n` +
    `url: ${r.shareUrl}\n` +
    `method: ${r.method}\n` +
    `fetched_at: ${new Date().toISOString()}\n` +
    "---\n\n";

  fs.writeFileSync(file, frontmatter + r.text.trim() + "\n", "utf-8");
  return file;
}
