import { launch } from "./browser.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * PHASE A — discovery (enhanced).
 * Logs every JSON XHR on douyin, and for the high-value 收藏夹 endpoints it also
 * dumps the FULL payload to ~/.douyin-sync/debug/ and drills into the first item
 * so we can locate the caption/subtitle field.
 */

const DEBUG = path.join(os.homedir(), ".douyin-sync", "debug");
fs.mkdirSync(DEBUG, { recursive: true });

// Endpoints worth capturing in full (confirmed from your discover dump):
const CAPTURE = [
  "/aweme/v1/web/collects/list/",        // 收藏夹清单
  "/aweme/v1/web/collects/video/list/",  // 某收藏夹内的视频(我们要迭代的)
  "/aweme/v1/web/aweme/detail",          // 单视频详情(以防字幕只在这里)
];

function dumpFull(route: string, body: unknown): string {
  const safe = route.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const file = path.join(DEBUG, `${Date.now()}-${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf-8");
  return file;
}

async function main(): Promise<void> {
  const ctx = await launch();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/douyin\.com/.test(url)) return;
    const ct = resp.headers()["content-type"] ?? "";
    if (!ct.includes("json")) return;

    let body: any;
    try {
      body = await resp.json();
    } catch {
      return;
    }

    const route = url.split("?")[0];
    const keys = body && typeof body === "object" ? Object.keys(body) : [];
    console.log("\n[XHR]", route);
    if (keys.length) console.log("  keys:", keys.join(", "));

    if (CAPTURE.some((p) => url.includes(p))) {
      const file = dumpFull(route, body);
      console.log("  ★ 完整 payload 已存 →", file);

      const list = body.aweme_list ?? body.collects_list ?? body.aweme_detail;
      const first = Array.isArray(list) ? list[0] : list;
      if (first && typeof first === "object") {
        console.log("  首条 keys:", Object.keys(first).join(", "));
        const video = first.video;
        if (video && typeof video === "object") {
          console.log("  video keys:", Object.keys(video).join(", "));
          const capish = Object.keys(video).filter((k) =>
            /cap|subtit|cla|srt|vtt|gram/i.test(k),
          );
          if (capish.length) console.log("  ⟵ 疑似字幕字段:", capish.join(", "));
        }
      }
    }
  });

  await page.goto("https://www.douyin.com/");
  console.log(
    "\n→ 打开你要同步的那个【收藏夹】,滚到底,再点开其中一个视频。" +
      "\n→ 看控制台里 collects/video/list 那行下面打印的 video keys / 疑似字幕字段。" +
      "\n→ 完整 JSON 已落到 ~/.douyin-sync/debug/,把里面 collects_video_list 那个文件发我即可。" +
      "\n→ 完成后 Ctrl-C。\n",
  );

  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
