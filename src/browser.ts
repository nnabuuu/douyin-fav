import { chromium, type BrowserContext } from "playwright";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

/** Persistent session lives here — cookies, localStorage, the whole login. */
export const USER_DATA_DIR = path.join(os.homedir(), ".douyin-sync", "browser");

export async function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // headful: you look like a real return visitor
    viewport: { width: 1280, height: 900 },
    // Mild fingerprint hygiene; not stealth — we rely on being a real session.
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** One-time (and occasional re-)login: open browser, scan QR, save session. */
async function loginFlow(): Promise<void> {
  const ctx = await launch();
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://www.douyin.com/");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("\n在打开的浏览器里扫码登录抖音，完成后回到这里按 Enter 保存会话…\n");
  rl.close();

  await ctx.close();
  console.log("✓ 会话已持久化到", USER_DATA_DIR);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loginFlow().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
