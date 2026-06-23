import {
  AuthError,
  NoValidTokenError,
  UnsupportedPlatformError,
  resolvePlatform,
  type VideoResult,
} from "../domain/model.js";
import type { Extractor, TokenAuthenticator, TokenStore } from "../domain/ports.js";

const now = () => new Date().toISOString();

/**
 * Use case: url → transcript, with pool ROTATION + FAILOVER.
 * Each attempt takes the next valid token; on an auth fault we re-validate,
 * mark dead tokens invalid, and fail over to the next one.
 */
export class TranscribeVideo {
  constructor(
    private store: TokenStore,
    private extractor: Extractor,
    private auth: TokenAuthenticator,
  ) {}

  async run(url: string, log: (m: string) => void = () => {}): Promise<VideoResult> {
    const platform = resolvePlatform(url);
    if (!platform) throw new UnsupportedPlatformError(`不支持的链接(暂只支持抖音;bilibili 待接入):${url}`);

    const cached = this.extractor.peekCache(url);
    if (cached) { log("命中缓存"); return cached; }

    const tried = new Set<string>();
    for (;;) {
      const token = this.store.nextValid(platform);
      if (!token || tried.has(token.id)) {
        throw new NoValidTokenError(`${platform} 没有可用 token(都失效了?去后台扫码加一个)。`);
      }
      tried.add(token.id);
      log(`使用 token「${token.label}」(${token.account?.nickname ?? token.id})`);
      try {
        const result = await this.extractor.extract(url, token, log);
        this.store.update(token.id, { lastUsedAt: now(), failureCount: 0, status: "valid" });
        return result;
      } catch (e) {
        if (e instanceof AuthError) {
          log(`token「${token.label}」疑似失效,验证中…`);
          const v = await this.auth.validate(token);
          this.store.update(token.id, {
            status: v.valid ? "valid" : "invalid",
            account: v.account ?? token.account,
            lastValidatedAt: now(),
          });
          if (!v.valid) { log(`token「${token.label}」已失效,故障转移。`); continue; }
        }
        this.store.update(token.id, { failureCount: token.failureCount + 1 });
        throw e; // genuine error (video private/gone, ASR failed, …) — not a pool problem
      }
    }
  }
}
