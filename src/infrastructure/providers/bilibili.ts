import type { BrowserContext } from "playwright";
import type { Account, CollectionItem, VideoResult } from "../../domain/model.js";
import type { BrowserSession, ContentProvider } from "../contracts.js";

/**
 * Placeholder adapter — proves the differ-by-URL seam. Implement fetch/probe when
 * bilibili lands (subtitle source differs: bilibili exposes player.so / ai_subtitle JSON).
 */
export class BilibiliProvider implements ContentProvider {
  readonly platform = "bilibili" as const;

  supports(url: string): boolean { return /bilibili\.com|b23\.tv/i.test(url); }

  tryParseId(url: string): string | null {
    const m = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  }

  cached(): VideoResult | null { return null; }

  async fetch(_session: BrowserSession, _url: string): Promise<VideoResult> {
    throw new Error("bilibili 适配器未实现(占位)。URL 路由已就绪,补上 fetch/probe 即可上线。");
  }

  async listCollection(_session: BrowserSession, _folderUrl: string): Promise<CollectionItem[]> {
    throw new Error("bilibili listCollection 未实现(占位)。");
  }

  loginUrl(): string { return "https://passport.bilibili.com/login"; }

  async probe(_ctx: BrowserContext): Promise<{ valid: boolean; account?: Account }> {
    return { valid: false };
  }
}
