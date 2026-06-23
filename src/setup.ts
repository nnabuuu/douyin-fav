/* First-run onboarding: npm run setup. Non-interactive — checks, installs, guides. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./domain/config.js";

const major = Number(process.versions.node.split(".")[0]);
console.log(`Node ${process.versions.node}`);
if (major < 18) {
  console.error("需要 Node ≥ 18(内置 fetch)。请升级后重试。");
  process.exit(1);
}

console.log("\n[1/3] 安装 Chromium(Playwright)…");
const r = spawnSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit" });
if (r.status !== 0) console.warn("⚠ Chromium 安装可能失败,稍后手动:npx playwright install chromium");

console.log("\n[2/3] 写入默认配置…");
const dir = path.join(os.homedir(), ".douyin-sync");
fs.mkdirSync(dir, { recursive: true });
const cfgPath = path.join(dir, "config.json");
if (!fs.existsSync(cfgPath)) {
  fs.writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  console.log("  写入 " + cfgPath);
} else {
  console.log("  已存在,跳过 " + cfgPath);
}

console.log(`
[3/3] 下一步(手动):
  1) 启动服务:    npm run serve
  2) 加抖音 token:打开 http://localhost:8787 → 扫码登录(POST /api/tokens,或用单独的 token 管理 UI)
                  也可走 CLI:npm run login
  3) 连 Notion:
     · https://www.notion.so/my-integrations 新建 integration,复制 Internal Secret
     · 打开目标数据库 → 右上 ··· → Connections → 添加该 integration(把库共享给它)
     · http://localhost:8787/config 填 notion.token 和 notion.databaseId
  4) 配收藏夹:     /config 的 folders 加你的收藏夹 URL(可多个)
  5) 开启定时:     /config 把 schedule.enabled 设 true(或点“开启定时”)

完成后,服务每 ${DEFAULT_CONFIG.schedule.intervalMin} 分钟自动:扫收藏夹 → 转写新视频 → 写入 Notion。
详见 docs/deploy.md。`);
