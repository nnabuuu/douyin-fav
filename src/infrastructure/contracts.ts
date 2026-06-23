/* Infra-internal contracts — adapters wire to each other through these. Playwright is allowed here. */
import type { BrowserContext, Page } from "playwright";
import type { Account, CollectionItem, Platform, Token, VideoResult } from "../domain/model.js";

/** A browser session bound to one token's profile. */
export interface BrowserSession {
  readonly tokenId: string;
  newPage(): Promise<Page>;
  /** Download the first working mirror to `dest` (uses the session's cookies/headers). */
  download(urls: string[], dest: string): Promise<void>;
}

export interface Transcriber {
  transcribe(mediaPath: string, lang: string, outDir: string): Promise<string>;
}

/** Everything platform-specific lives behind this. Add a platform = add a provider. */
export interface ContentProvider {
  readonly platform: Platform;
  supports(url: string): boolean;
  /** Pure id parse (no network); null if it needs the network (e.g. short links). */
  tryParseId(url: string): string | null;
  /** Cached result for an id, or null. */
  cached(videoId: string): VideoResult | null;
  fetch(session: BrowserSession, url: string, log: (m: string) => void): Promise<VideoResult>;
  /** List videos in a favorites/collection folder. */
  listCollection(session: BrowserSession, folderUrl: string, log: (m: string) => void): Promise<CollectionItem[]>;
  /** Auth surface for this platform. */
  loginUrl(): string;
  probe(ctx: BrowserContext): Promise<{ valid: boolean; account?: Account }>;
}

export interface BrowserGateway {
  open(token: Token): Promise<BrowserSession>;
  closeAll(): Promise<void>;
}
