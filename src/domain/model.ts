/* Domain entities + pure routing. No IO, no playwright, no node-specific frameworks. */

export type Platform = "douyin" | "bilibili";
export type TokenStatus = "valid" | "invalid" | "unknown" | "logging_in";
export type TranscriptSource = "subtitle" | "asr";

export interface Account {
  nickname?: string;
  uid?: string;
}

/** A pool credential. The SECRET (cookies) lives in `profileDir` on disk; this is just metadata. */
export interface Token {
  id: string;
  platform: Platform;
  label: string;
  profileDir: string;
  status: TokenStatus;
  account?: Account;
  createdAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  failureCount: number;
}

export interface VideoResult {
  platform: Platform;
  videoId: string;
  title: string;
  desc: string;
  author: string;
  transcript: string;
  source: TranscriptSource;
  tokenId: string;
  cached: boolean;
}

/** Canonical watch URL for a video. */
export function videoUrl(platform: Platform, videoId: string): string {
  return platform === "bilibili"
    ? `https://www.bilibili.com/video/${videoId}`
    : `https://www.douyin.com/video/${videoId}`;
}

/** One entry scraped from a favorites/collection folder. */
export interface CollectionItem {
  videoId: string;
  desc: string;
  author: string;
}

/** Token is at fault (logged out / blocked) — triggers pool failover. */
export class AuthError extends Error {}
/** A captcha/verification wall — NOT a bad token, so it must NOT trigger failover. */
export class CaptchaError extends Error {}
/** No provider handles this URL. */
export class UnsupportedPlatformError extends Error {}
/** Pool has no usable token for the platform. */
export class NoValidTokenError extends Error {}

const PLATFORM_PATTERNS: Array<[Platform, RegExp]> = [
  ["douyin", /douyin\.com|v\.douyin\.com|iesdouyin\.com|^\d{6,}$/i],
  ["bilibili", /bilibili\.com|b23\.tv/i],
];

/** Pure URL → platform routing. The seam that lets new platforms differ by URL. */
export function resolvePlatform(url: string): Platform | null {
  const s = url.trim();
  for (const [p, re] of PLATFORM_PATTERNS) if (re.test(s)) return p;
  return null;
}
