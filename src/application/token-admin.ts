import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Token, Platform } from "../domain/model.js";
import type { TokenAuthenticator, TokenStore } from "../domain/ports.js";

const PROFILES_DIR = path.join(os.homedir(), ".douyin-sync", "profiles");
const now = () => new Date().toISOString();

/** Use cases for managing the token pool. */
export class TokenAdmin {
  constructor(private store: TokenStore, private auth: TokenAuthenticator) {}

  list(): Token[] { return this.store.list(); }
  get(id: string): Token | undefined { return this.store.get(id); }
  remove(id: string): boolean { return this.store.remove(id); }

  /**
   * Create a token in `logging_in` state and drive the QR login in the background
   * (a human must scan in the Chrome window on the host). UI polls token status.
   */
  beginAdd(platform: Platform, label?: string): Token {
    const id = crypto.randomUUID().slice(0, 8);
    const token: Token = {
      id,
      platform,
      label: label?.trim() || `${platform}-${id}`,
      profileDir: path.join(PROFILES_DIR, id),
      status: "logging_in",
      createdAt: now(),
      failureCount: 0,
    };
    this.store.add(token);
    void this.auth
      .login(token, () => {})
      .then((r) => this.store.update(id, {
        status: r.valid ? "valid" : "invalid",
        account: r.account,
        lastValidatedAt: now(),
      }))
      .catch(() => this.store.update(id, { status: "invalid" }));
    return token;
  }

  async validate(id: string): Promise<Token | undefined> {
    const t = this.store.get(id);
    if (!t) return undefined;
    const v = await this.auth.validate(t);
    return this.store.update(id, {
      status: v.valid ? "valid" : "invalid",
      account: v.account ?? t.account,
      lastValidatedAt: now(),
    });
  }
}
