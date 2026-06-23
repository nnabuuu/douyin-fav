import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { launch } from "./browser.js";
import { isProcessed, markDone, markFailed } from "./db.js";
import { writeTranscript } from "./output.js";
import type { AwemeListItem } from "./types.js";

/* ───────────────────────────────────────────────────────────────────────────
 * CONFIG — confirm every value below with `npm run discover` before trusting it.
 * These are the ONLY parts that break when抖音 changes its web API. Everything
 * else (session, interception, dedup, output) is structural and stable.
 * ─────────────────────────────────────────────────────────────────────────── */

/** Page that shows your collection folder. Confirm the exact URL/tab in discover. */
const COLLECTION_URL = "https://www.douyin.com/user/self?showTab=favorite_collection";

/** URL substring that identifies the LIST endpoint (grows as you scroll). */
const LIST_ENDPOINT_MATCH = "/aweme/v1/web/aweme/listcollection";

/** URL substring that identifies a single-video DETAIL endpoint. */
const DETAIL_ENDPOINT_MATCH = "/aweme/v1/web/aweme/detail";

const MAX_SCROLLS = 40;
const SCROLL_PAUSE_MS = 1500;

/* ─────────────────────────── defensive parsers ──────────────────────────── */

/** Pull aweme items out of a list payload without assuming one fixed shape. */
function parseListResponse(body: any): AwemeListItem[] {
  const arr =
    body?.aweme_list ??
    body?.aweme_collects ??
    body?.collects ??
    body?.data?.aweme_list ??
    [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((entry: any): AwemeListItem => {
      const a = entry?.aweme_info ?? entry?.aweme ?? entry;
      return {
        awemeId: String(a?.aweme_id ?? a?.awemeId ?? ""),
        desc: String(a?.desc ?? ""),
        author: String(a?.author?.nickname ?? ""),
      };
    })
    .filter((x) => x.awemeId);
}

/**
 * Try to extract caption/subtitle text from a video detail payload.
 * Returns the joined transcript, or null if no recognizable caption is present
 * (in which case sync dumps the payload so you can map the field once).
 */
function extractCaption(body: any): string | null {
  const a = body?.aweme_detail ?? body?.aweme_info ?? body?.aweme ?? body;

  // Case 1: an array of subtitle cues with text already inline.
  const cueArrays = [
    a?.video?.caption,
    a?.video?.cla_info?.caption_infos,
    a?.caption_infos,
  ];
  for (const cues of cueArrays) {
    if (Array.isArray(cues) && cues.length) {
      const text = cues
        .map((c: any) => c?.text ?? c?.content ?? c?.utterance ?? "")
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }

  // Case 2: a single caption string.
  const flat = a?.caption ?? a?.video?.caption_text;
  if (typeof flat === "string" && flat.trim()) return flat;

  // Case 3: only a subtitle-track URL exists (webvtt/json). Parsing that is the
  // next seam — left intentionally for after you confirm the field in discover.
  return null;
}

/* ──────────────────────────────── pipeline ──────────────────────────────── */

async function main(): Promise<void> {
  const ctx = await launch();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Buffers populated by interception.
  const listItems = new Map<string, AwemeListItem>();
  let latestDetail: any = null;

  // Register listeners BEFORE navigating so we never miss the first responses.
  page.on("response", async (resp) => {
    const url = resp.url();
    try {
      if (url.includes(LIST_ENDPOINT_MATCH)) {
        const body = await resp.json();
        for (const item of parseListResponse(body)) {
          listItems.set(item.awemeId, item);
        }
      } else if (url.includes(DETAIL_ENDPOINT_MATCH)) {
        latestDetail = await resp.json();
      }
    } catch {
      /* body not JSON / already consumed */
    }
  });

  // 1) Load the collection and scroll until the list stops growing.
  await page.goto(COLLECTION_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SCROLL_PAUSE_MS);

  let stable = 0;
  for (let i = 0; i < MAX_SCROLLS && stable < 3; i++) {
    const before = listItems.size;
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(SCROLL_PAUSE_MS);
    stable = listItems.size === before ? stable + 1 : 0;
  }

  // 2) Health check — zero items almost always means logged out or endpoint changed.
  if (listItems.size === 0) {
    await ctx.close();
    throw new Error(
      "拦截到 0 条收藏。可能的原因：\n" +
        "  · 会话过期 → 跑 `npm run login` 重新扫码\n" +
        "  · 接口路径/收藏夹 URL 变了 → 跑 `npm run discover` 重新确认 CONFIG\n" +
        "（这是故意的大声失败：不静默产出空结果。）",
    );
  }

  console.log(`发现 ${listItems.size} 条收藏，开始处理新增项…`);

  // 3) Process only un-done items.
  let done = 0;
  let failed = 0;
  for (const item of listItems.values()) {
    if (isProcessed(item.awemeId)) continue;

    const shareUrl = `https://www.douyin.com/video/${item.awemeId}`;
    const title = item.desc || item.awemeId;

    try {
      latestDetail = null;
      await page.goto(shareUrl, { waitUntil: "domcontentloaded" });
      // Give the detail XHR time to fire and be intercepted.
      for (let w = 0; w < 12 && latestDetail === null; w++) {
        await page.waitForTimeout(500);
      }

      const text = latestDetail ? extractCaption(latestDetail) : null;
      if (!text) {
        // Dump payload so the caption field can be mapped once, then retried.
        if (latestDetail) dumpDebug(item.awemeId, latestDetail);
        markFailed(item.awemeId, "no caption found (needs field mapping or ASR fallback)");
        failed++;
        console.log(`  ✗ ${item.awemeId} 无字幕（已存调试样本）`);
        continue;
      }

      const file = writeTranscript({
        awemeId: item.awemeId,
        title,
        author: item.author,
        shareUrl,
        text,
        method: "caption",
      });
      markDone({ awemeId: item.awemeId, title, author: item.author, shareUrl, method: "caption" });
      done++;
      console.log(`  ✓ ${path.basename(file)}`);
    } catch (err) {
      markFailed(item.awemeId, String(err));
      failed++;
      console.log(`  ✗ ${item.awemeId} ${String(err)}`);
    }
  }

  await ctx.close();
  console.log(`\n完成：新增逐字稿 ${done} 条，失败/待处理 ${failed} 条。`);
}

function dumpDebug(awemeId: string, payload: unknown): void {
  const dir = path.join(os.homedir(), ".douyin-sync", "debug");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${awemeId}.json`),
    JSON.stringify(payload, null, 2),
    "utf-8",
  );
}

main().catch((err) => {
  console.error("\n" + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
