/* Ports: interfaces the application depends on. Implemented by infrastructure adapters. */
import type { Token, Platform, VideoResult, Account, CollectionItem } from "./model.js";
import type { AppConfig } from "./config.js";

export interface TokenStore {
  list(): Token[];
  get(id: string): Token | undefined;
  add(t: Token): void;
  update(id: string, patch: Partial<Token>): Token | undefined;
  remove(id: string): boolean;
  /** Round-robin over usable tokens of a platform; advances an internal cursor. */
  nextValid(platform: Platform): Token | undefined;
}

export interface Extractor {
  /** Return a finished result without spending a token, if already cached. */
  peekCache(url: string): VideoResult | null;
  /** Scrape + transcribe one url using one token. Throws AuthError when the token is at fault. */
  extract(url: string, token: Token, log: (m: string) => void): Promise<VideoResult>;
  /** List the videos in a favorites/collection folder using one token. */
  listCollection(folderUrl: string, token: Token, log: (m: string) => void): Promise<CollectionItem[]>;
}

export interface TokenAuthenticator {
  validate(token: Token): Promise<{ valid: boolean; account?: Account }>;
  /** Drive an interactive QR login into the token's profile; resolves once detected or it times out. */
  login(token: Token, onProgress: (m: string) => void): Promise<{ valid: boolean; account?: Account }>;
}

export interface ConfigStore {
  get(): AppConfig;
  update(patch: Partial<AppConfig>): AppConfig;
}

/** Post-processing of a transcript before export. RawAnalyzer = passthrough; LLM = future drop-in. */
export interface Analyzer {
  analyze(result: VideoResult): Promise<{ cleaned: string; summary?: string }>;
}

/** Idempotent sink for finished transcripts (e.g. Notion). */
export interface Exporter {
  has(videoId: string): Promise<boolean>;
  /** Returns "created" or "skipped" (already present / not configured). */
  export(result: VideoResult, cleaned: string, summary: string | undefined): Promise<"created" | "skipped">;
}
