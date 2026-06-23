import path from "node:path";
import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { AuthError, CaptchaError, type Account, type CollectionItem, type VideoResult } from "../../domain/model.js";
import type { BrowserSession, ContentProvider, Transcriber } from "../contracts.js";
import { retry, pace } from "../net.js";

const DETAIL = "/aweme/v1/web/aweme/detail";
// 全部收藏列表接口(进收藏页就会自动打一发)
const ALL_FAVORITES = /aweme\/listcollection/;
// 单个命名收藏夹内的视频列表接口(点开某收藏夹才打)
const FOLDER_VIDEOS = /collects?\/video/;
const MAX_SCROLLS = 40;

export class DouyinProvider implements ContentProvider {
  readonly platform = "douyin" as const;

  constructor(private transcriber: Transcriber, private workspaceRoot: string) {}

  supports(url: string): boolean {
    const s = url.trim();
    return /douyin\.com|v\.douyin\.com|iesdouyin\.com/i.test(s) || /^\d{6,}$/.test(s);
  }

  tryParseId(url: string): string | null {
    const s = url.trim();
    if (/^\d{6,}$/.test(s)) return s;
    try {
      const u = new URL(s);
      const modal = u.searchParams.get("modal_id");
      if (modal && /^\d+$/.test(modal)) return modal;
      const m = u.pathname.match(/\/(?:video|note|share\/video)\/(\d+)/);
      if (m) return m[1];
    } catch { /* not a parseable URL */ }
    return null; // short links resolve via the network in fetch()
  }

  private dir(videoId: string): string {
    return path.join(this.workspaceRoot, this.platform, videoId);
  }

  cached(videoId: string): VideoResult | null {
    const f = path.join(this.dir(videoId), "result.json");
    if (!fs.existsSync(f)) return null;
    try {
      const r = JSON.parse(fs.readFileSync(f, "utf-8"));
      return { author: "", ...r, cached: true }; // author default for pre-existing cache
    } catch { return null; }
  }

  async fetch(session: BrowserSession, url: string, log: (m: string) => void): Promise<VideoResult> {
    const videoId = await this.resolveId(session, url);
    if (!videoId) throw new Error("认不出抖音视频 id。");
    const hit = this.cached(videoId);
    if (hit) return hit;

    const dir = this.dir(videoId);
    fs.mkdirSync(dir, { recursive: true });

    // Empty/blocked responses are an anti-bot signal, not "done" → retry before failing.
    let detail: any;
    try {
      detail = await retry(() => this.fetchDetail(session, videoId, log), {
        retryable: (e) => !(e instanceof AuthError || e instanceof CaptchaError),
        onRetry: (n) => log(`detail 为空,疑似反爬,重试 ${n}…`),
      });
    } catch (e) {
      if (e instanceof AuthError || e instanceof CaptchaError) throw e;
      throw new AuthError("多次没拦到 detail(登录态可能失效)。");
    }

    fs.writeFileSync(path.join(dir, "detail.json"), JSON.stringify(detail, null, 2), "utf-8");
    const a = detail.aweme_detail ?? detail;
    const desc = String(a?.desc ?? a?.caption ?? "").trim();
    const author = String(a?.author?.nickname ?? "").trim();
    const title = desc.split("\n")[0] || videoId;

    let transcript = extractSubtitleTrack(detail);
    let source: VideoResult["source"] = "subtitle";
    if (!transcript) {
      log(`无字幕轨(is_subtitled=${a?.is_subtitled ?? "?"}),下载 + ASR…`);
      const urls = (a?.video?.play_addr?.url_list ?? []).filter((u: any) => typeof u === "string");
      if (!urls.length) throw new Error("detail 里没有 play_addr。");
      const media = path.join(dir, "v.mp4");
      await session.download(urls, media);
      transcript = await this.transcriber.transcribe(media, "Chinese", dir);
      source = "asr";
      fs.rmSync(media, { force: true }); // ponytail: drop the mp4, keep v.txt/transcript — saves ~16MB/video
    }

    const result: VideoResult = {
      platform: "douyin", videoId, title, desc, author, transcript, source, tokenId: session.tokenId, cached: false,
    };
    const md =
      `# ${title}\n\n- videoId: ${videoId}\n- source: ${source}\n- token: ${session.tokenId}\n\n` +
      (desc ? `## 文案\n\n${desc}\n\n` : "") + `## 口播逐字稿\n\n${transcript}\n`;
    fs.writeFileSync(path.join(dir, "transcript.md"), md, "utf-8");
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
    return result;
  }

  /** One attempt to intercept the detail payload. Throws AuthError(login)/CaptchaError/retryable Error. */
  private async fetchDetail(session: BrowserSession, videoId: string, log: (m: string) => void): Promise<any> {
    const page = await session.newPage();
    let detail: any = null;
    page.on("response", async (r) => {
      if (r.url().includes(DETAIL)) { try { detail = await r.json(); } catch { /* not json */ } }
    });
    try {
      await pace(300, 600); // gentle human-ish spacing between requests
      await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: "domcontentloaded" });
      for (let w = 0; w < 20 && detail === null; w++) await page.waitForTimeout(500);
      if (!detail && (await captchaPresent(page))) {
        log("出现验证码——在弹出的浏览器窗口里手动过一下(最多等 30s)…");
        for (let i = 0; i < 10 && !detail; i++) await page.waitForTimeout(3000);
        if (!detail) throw new CaptchaError("验证码未通过,跳过本条。");
      }
      if (detail) return detail;
      if (/login|passport/i.test(page.url())) throw new AuthError("被重定向到登录页。");
      throw new Error("没拦到 detail(空响应,疑似反爬)。"); // retryable
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async resolveId(session: BrowserSession, url: string): Promise<string | null> {
    const direct = this.tryParseId(url);
    if (direct) return direct;
    if (/v\.douyin\.com/i.test(url)) {
      const p = await session.newPage();
      try {
        await p.goto(url.match(/https?:\/\/v\.douyin\.com\/\S+/)?.[0] ?? url, { waitUntil: "domcontentloaded" });
        const m = p.url().match(/\/(?:video|note)\/(\d+)/) || p.url().match(/modal_id=(\d+)/);
        return m ? m[1] : null;
      } finally {
        await p.close().catch(() => {});
      }
    }
    return null;
  }

  async listCollection(session: BrowserSession, folderUrl: string, log: (m: string) => void): Promise<CollectionItem[]> {
    try {
      // 0 items is an anti-bot signal too → one gentle re-scan before concluding.
      return await retry(() => this.scanCollection(session, folderUrl, log), {
        delays: [3000],
        retryable: (e) => !(e instanceof CaptchaError || e instanceof AuthError),
        onRetry: () => log("收藏夹 0 条,疑似反爬,再扫一次…"),
      });
    } catch (e) {
      if (e instanceof CaptchaError || e instanceof AuthError) throw e; // 验证码 / 收藏夹名对不上:原样抛,别重试
      throw new AuthError("收藏夹多次拦到 0 条(登录态失效,或收藏夹 URL 变了)。");
    }
  }

  private async scanCollection(session: BrowserSession, folderUrl: string, log: (m: string) => void): Promise<CollectionItem[]> {
    const items = new Map<string, CollectionItem>();
    // `#收藏夹名` 后缀 = 只同步这个命名收藏夹;裸 URL = 全部收藏。
    let folderName = "", navUrl = folderUrl;
    try { const u = new URL(folderUrl); folderName = decodeURIComponent(u.hash.replace(/^#/, "")).trim(); u.hash = ""; navUrl = u.toString(); } catch { /* not a URL */ }
    const wantFolder = !!folderName;
    if (wantFolder) navUrl = withFolderSubtab(navUrl); // 切到「收藏夹」子页,卡片才渲染

    // 关键:点了名收藏夹就只收 collects/video/list;进页面自动打的那发「全部收藏」
    // listcollection 必须忽略,否则会把整个收藏都同步进来(用户踩的就是这个坑)。
    const wanted = wantFolder ? FOLDER_VIDEOS : ALL_FAVORITES;
    const page = await session.newPage();
    page.on("response", async (r) => {
      if (!wanted.test(r.url())) return;
      try { for (const it of parseList(await r.json())) items.set(it.videoId, it); } catch { /* not json */ }
    });
    try {
      await page.goto(navUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      if (wantFolder) {
        log(`打开收藏夹「${folderName}」…`);
        if (!(await openFolderByName(page, folderName))) {
          // 名字对不上就明确报错——绝不退化成「抓当前页 = 全部收藏」。
          throw new AuthError(`没找到名为「${folderName}」的收藏夹(确认名字完全一致,或把收藏夹名留空=同步全部收藏)。`);
        }
        await page.waitForTimeout(2000); // 等 collects/video/list 打出来
      }
      let stable = 0;
      for (let i = 0; i < MAX_SCROLLS && stable < 3; i++) {
        const before = items.size;
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1500);
        stable = items.size === before ? stable + 1 : 0;
      }
      if (items.size === 0) {
        if (await captchaPresent(page)) throw new CaptchaError("收藏夹出现验证码。");
        throw new Error("收藏夹拦到 0 条(疑似反爬,可重试)。"); // retryable
      }
    } finally {
      await page.close().catch(() => {});
    }
    log(`${wantFolder ? `收藏夹「${folderName}」` : "全部收藏"}发现 ${items.size} 条`);
    return [...items.values()];
  }

  loginUrl(): string {
    return "https://www.douyin.com/";
  }

  /** Logged in iff the auth cookie is present. sessionid is HttpOnly but lives in the context jar. */
  async isLoggedIn(ctx: BrowserContext): Promise<boolean> {
    try {
      const cookies = await ctx.cookies("https://www.douyin.com");
      return cookies.some((c) => /^(sessionid|sessionid_ss|sid_guard)$/.test(c.name) && !!c.value && c.value.length > 4);
    } catch { return false; }
  }

  async probe(ctx: BrowserContext): Promise<{ valid: boolean; account?: Account }> {
    if (!(await this.isLoggedIn(ctx))) return { valid: false };
    // Logged in (cookie). Best-effort nickname/uid — valid regardless of whether we can read it.
    let account: Account | undefined;
    const page = await ctx.newPage();
    page.on("response", async (r) => {
      if (!/aweme\/v1\/web\//.test(r.url())) return;
      try { const acc = findAccount(await r.json()); if (acc) account = acc; } catch { /* not json */ }
    });
    try {
      await page.goto("https://www.douyin.com/user/self", { waitUntil: "domcontentloaded" });
      for (let i = 0; i < 12 && !account; i++) await page.waitForTimeout(500);
    } catch { /* keep valid even if the account read fails */ }
    finally {
      await page.close().catch(() => {});
    }
    return { valid: true, account };
  }
}

/** Anti-bot wall? Their `if "验证码" in title` idea — check the page title for verify markers. */
async function captchaPresent(page: Page): Promise<boolean> {
  try { return /验证|verify|captcha|滑块|slider/i.test(await page.title()); } catch { return false; }
}

/** Force the 收藏页→收藏夹 子标签,这样命名收藏夹的卡片会渲染出来(而不是默认的「全部收藏」)。 */
function withFolderSubtab(u: string): string {
  try {
    const url = new URL(u);
    url.searchParams.set("showTab", "favorite_collection");
    url.searchParams.set("showSubTab", "favorite_folder");
    return url.toString();
  } catch { return u; }
}

/** Click the named-folder card. exact 优先(避免命中标题里含同名字样的视频),不行再退到包含匹配。 */
async function openFolderByName(page: Page, name: string): Promise<boolean> {
  for (const exact of [true, false]) {
    try {
      const el = page.getByText(name, { exact }).first();
      await el.waitFor({ state: "visible", timeout: 6000 });
      await el.click();
      return true;
    } catch { /* try the looser match, then give up */ }
  }
  return false;
}

/** Pull aweme items out of a listcollection payload without assuming one fixed shape. */
export function parseList(body: any): CollectionItem[] {
  const arr = body?.aweme_list ?? body?.aweme_collects ?? body?.collects ?? body?.data?.aweme_list ?? [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((entry: any): CollectionItem => {
      const a = entry?.aweme_info ?? entry?.aweme ?? entry;
      return {
        videoId: String(a?.aweme_id ?? a?.awemeId ?? ""),
        desc: String(a?.desc ?? ""),
        author: String(a?.author?.nickname ?? ""),
      };
    })
    .filter((x) => x.videoId);
}

/** REAL spoken-subtitle track only — NOT a.caption (that's the post 文案). */
export function extractSubtitleTrack(detail: any): string | null {
  const a = detail?.aweme_detail ?? detail?.aweme_info ?? detail?.aweme ?? detail;
  const cueArrays = [a?.video?.caption, a?.video?.cla_info?.caption_infos, a?.caption_infos];
  for (const cues of cueArrays) {
    if (Array.isArray(cues) && cues.length) {
      const text = cues.map((c: any) => c?.text ?? c?.content ?? c?.utterance ?? "").filter(Boolean).join("\n");
      if (text.trim()) return text;
    }
  }
  const ct = a?.video?.caption_text;
  return typeof ct === "string" && ct.trim() ? ct : null;
}

/** Recursively find a logged-in account (nickname + uid/sec_uid) in a douyin web payload. */
// ponytail: net-scan rather than a fixed path — same as discover, the exact field drifts.
function findAccount(obj: any, depth = 0): Account | undefined {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  if (typeof obj.nickname === "string" && obj.nickname && (obj.uid || obj.sec_uid || obj.uid_str)) {
    return { nickname: obj.nickname, uid: String(obj.uid ?? obj.uid_str ?? obj.sec_uid) };
  }
  for (const v of Object.values(obj)) {
    const found = findAccount(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}
