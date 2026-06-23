import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Platform, Token } from "../domain/model.js";
import type { TokenStore } from "../domain/ports.js";

const FILE = path.join(os.homedir(), ".douyin-sync", "tokens.json");
const LEGACY_PROFILE = path.join(os.homedir(), ".douyin-sync", "browser");

/**
 * JSON-backed token pool. Stores only metadata — the actual login (cookies) lives
 * in each token's profile dir on disk, never in this file.
 */
export class FileTokenStore implements TokenStore {
  private tokens: Token[] = [];
  private cursor = new Map<Platform, number>();

  constructor() {
    this.load();
    this.seedLegacy();
  }

  private load(): void {
    try { this.tokens = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch { this.tokens = []; }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.tokens, null, 2), "utf-8");
  }

  /** Adopt the pre-existing single login (~/.douyin-sync/browser) as the first token. */
  private seedLegacy(): void {
    if (this.tokens.length === 0 && fs.existsSync(LEGACY_PROFILE)) {
      this.tokens.push({
        id: "legacy",
        platform: "douyin",
        label: "既有登录(legacy)",
        profileDir: LEGACY_PROFILE,
        status: "unknown",
        createdAt: new Date().toISOString(),
        failureCount: 0,
      });
      this.save();
    }
  }

  list(): Token[] { return this.tokens; }
  get(id: string): Token | undefined { return this.tokens.find((t) => t.id === id); }
  add(t: Token): void { this.tokens.push(t); this.save(); }
  update(id: string, patch: Partial<Token>): Token | undefined {
    const t = this.get(id);
    if (!t) return undefined;
    Object.assign(t, patch);
    this.save();
    return t;
  }
  remove(id: string): boolean {
    const i = this.tokens.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.tokens.splice(i, 1);
    this.save();
    return true;
  }

  /** Round-robin over valid tokens; falls back to 'unknown' so a fresh legacy token gets a shot. */
  nextValid(platform: Platform): Token | undefined {
    let pool = this.tokens.filter((t) => t.platform === platform && t.status === "valid");
    if (!pool.length) pool = this.tokens.filter((t) => t.platform === platform && t.status === "unknown");
    if (!pool.length) return undefined;
    const i = (this.cursor.get(platform) ?? 0) % pool.length;
    this.cursor.set(platform, i + 1);
    return pool[i];
  }
}
