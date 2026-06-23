import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright";

export interface ToolStatus {
  ok: boolean;
  detail: string;
  fixHint?: string;     // copy-paste command when we can't auto-install
  canInstall?: boolean; // service can install it for you
}

const onPath = (bin: string): boolean => {
  try { return spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0; }
  catch { return false; }
};

/** Run a command async (never blocks the event loop), return ok + tail of output. */
const run = (cmd: string, args: string[]): Promise<{ ok: boolean; log: string }> =>
  new Promise((resolve) => {
    let log = "";
    const p = spawn(cmd, args);
    p.stdout?.on("data", (d) => (log += d));
    p.stderr?.on("data", (d) => (log += d));
    p.on("error", (e) => resolve({ ok: false, log: (log + "\n" + e.message).slice(-4000) }));
    p.on("close", (code) => resolve({ ok: code === 0, log: log.slice(-4000) }));
  });

/** Detects/installs the host-side prerequisites the service needs. */
export class SystemCheck {
  node(): ToolStatus {
    const major = Number(process.versions.node.split(".")[0]);
    return { ok: major >= 18, detail: `Node ${process.versions.node}`, fixHint: major >= 18 ? undefined : "需要 Node ≥ 18" };
  }

  chromium(): ToolStatus {
    try {
      const p = chromium.executablePath();
      const ok = !!p && fs.existsSync(p);
      return { ok, detail: ok ? "已安装" : "未安装", canInstall: !ok };
    } catch { return { ok: false, detail: "未安装", canInstall: true }; }
  }

  ffmpeg(): ToolStatus {
    const ok = onPath("ffmpeg");
    return { ok, detail: ok ? "已安装" : "未找到", fixHint: ok ? undefined : ffmpegHint() };
  }

  whisper(): ToolStatus {
    const bin = process.env.WHISPER_BIN;
    const ok = bin ? fs.existsSync(bin) : onPath("whisper");
    return {
      ok, canInstall: !ok,
      detail: ok ? (bin || "whisper") : "未找到",
      fixHint: ok ? undefined : "pip install -U openai-whisper(或设 WHISPER_BIN 指向已装的 whisper)",
    };
  }

  installChromium() { return run("npx", ["playwright", "install", "chromium"]); }
  installWhisper() { return run(process.platform === "win32" ? "pip" : "pip3", ["install", "-U", "openai-whisper"]); }
}

function ffmpegHint(): string {
  if (process.platform === "darwin") return "brew install ffmpeg";
  if (process.platform === "linux") return "sudo apt install ffmpeg  (或对应包管理器)";
  return "https://ffmpeg.org/download.html";
}
