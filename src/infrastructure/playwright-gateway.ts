import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import type { Account, Token, Platform } from "../domain/model.js";
import type { TokenAuthenticator } from "../domain/ports.js";
import type { BrowserGateway, BrowserSession, ContentProvider } from "./contracts.js";

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];
const REFERER: Record<Platform, string> = {
  douyin: "https://www.douyin.com/",
  bilibili: "https://www.bilibili.com/",
};

/**
 * Owns one persistent Chrome context per profile dir (a token = a profile).
 * Contexts are cached and reused — the same user-data-dir can't be opened twice.
 * ponytail: cached contexts stay open (one headful window per used token); close-on-idle
 * is the upgrade path if too many windows pile up.
 */
export class PlaywrightGateway implements BrowserGateway, TokenAuthenticator {
  private contexts = new Map<string, BrowserContext>();

  constructor(private providers: ContentProvider[]) {}

  private provider(platform: Platform): ContentProvider {
    const p = this.providers.find((x) => x.platform === platform);
    if (!p) throw new Error(`没有 ${platform} 的 provider。`);
    return p;
  }

  private async context(profileDir: string): Promise<BrowserContext> {
    let c = this.contexts.get(profileDir);
    if (c) return c;
    fs.mkdirSync(profileDir, { recursive: true });
    c = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: LAUNCH_ARGS,
    });
    this.contexts.set(profileDir, c);
    return c;
  }

  async open(token: Token): Promise<BrowserSession> {
    const ctx = await this.context(token.profileDir);
    const referer = REFERER[token.platform];
    return {
      tokenId: token.id,
      newPage: () => ctx.newPage(),
      download: async (urls, dest) => {
        for (const url of urls) {
          try {
            const resp = await ctx.request.get(url, { headers: { referer }, timeout: 60_000 });
            if (!resp.ok()) continue;
            const buf = await resp.body();
            if (buf.length < 1024) continue;
            fs.writeFileSync(dest, buf);
            return;
          } catch { /* try next mirror */ }
        }
        throw new Error("所有镜像都下不动(CDN 链接可能过期)。");
      },
    };
  }

  async validate(token: Token): Promise<{ valid: boolean; account?: Account }> {
    const ctx = await this.context(token.profileDir);
    return this.provider(token.platform).probe(ctx);
  }

  async login(token: Token, onProgress: (m: string) => void): Promise<{ valid: boolean; account?: Account }> {
    const provider = this.provider(token.platform);
    const ctx = await this.context(token.profileDir);
    const page = await ctx.newPage();
    let result: { valid: boolean; account?: Account } = { valid: false };
    try {
      await page.goto(provider.loginUrl(), { waitUntil: "domcontentloaded" });
      onProgress("请在弹出的浏览器窗口扫码登录…");
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        // poll the auth cookie only — no extra page/tab churn while the user scans
        if (await provider.isLoggedIn(ctx)) {
          onProgress("检测到登录,读取账号…");
          const r = await provider.probe(ctx).catch(() => ({ valid: true as const, account: undefined }));
          result = { valid: true, account: r.account };
          onProgress(`登录成功:${r.account?.nickname ?? ""}`);
          break;
        }
        await page.waitForTimeout(2500);
      }
    } finally {
      await page.close().catch(() => {});
    }
    if (!result.valid) await this.evict(token.profileDir); // close the dead window on timeout/cancel
    return result;
  }

  /** Close + drop a profile's context (e.g. a failed login) so its window doesn't linger. */
  private async evict(profileDir: string): Promise<void> {
    const c = this.contexts.get(profileDir);
    if (c) { await c.close().catch(() => {}); this.contexts.delete(profileDir); }
  }

  async closeAll(): Promise<void> {
    for (const c of this.contexts.values()) await c.close().catch(() => {});
    this.contexts.clear();
  }
}
