import { UnsupportedPlatformError, type CollectionItem, type Token, type VideoResult } from "../domain/model.js";
import type { Extractor } from "../domain/ports.js";
import type { BrowserGateway, ContentProvider } from "./contracts.js";

/** Implements the application's Extractor port by composing gateway + providers. */
export class BrowserExtractor implements Extractor {
  constructor(private gateway: BrowserGateway, private providers: ContentProvider[]) {}

  private pick(url: string): ContentProvider {
    const p = this.providers.find((x) => x.supports(url));
    if (!p) throw new UnsupportedPlatformError(`不支持的链接:${url}`);
    return p;
  }

  peekCache(url: string): VideoResult | null {
    try {
      const p = this.pick(url);
      const id = p.tryParseId(url);
      return id ? p.cached(id) : null;
    } catch {
      return null;
    }
  }

  async extract(url: string, token: Token, log: (m: string) => void): Promise<VideoResult> {
    const provider = this.pick(url);
    const session = await this.gateway.open(token);
    return provider.fetch(session, url, log);
  }

  async listCollection(folderUrl: string, token: Token, log: (m: string) => void): Promise<CollectionItem[]> {
    const provider = this.pick(folderUrl);
    const session = await this.gateway.open(token);
    return provider.listCollection(session, folderUrl, log);
  }
}
