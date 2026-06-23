import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from "../domain/config.js";
import type { ConfigStore } from "../domain/ports.js";

const FILE = path.join(os.homedir(), ".douyin-sync", "config.json");

/** JSON-backed config, merged onto defaults so new fields appear automatically. */
export class FileConfigStore implements ConfigStore {
  private config: AppConfig;
  constructor() { this.config = this.load(); }

  private load(): AppConfig {
    try { return mergeConfig(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(FILE, "utf-8"))); }
    catch { return { ...DEFAULT_CONFIG }; }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.config, null, 2), "utf-8");
  }

  get(): AppConfig { return this.config; }
  update(patch: Partial<AppConfig>): AppConfig {
    this.config = mergeConfig(this.config, patch);
    this.save();
    return this.config;
  }
}
