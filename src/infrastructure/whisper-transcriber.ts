import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { Transcriber } from "./contracts.js";

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "turbo";

/** Local whisper CLI. async spawn — spawnSync would freeze the HTTP event loop. */
export class WhisperTranscriber implements Transcriber {
  async transcribe(mediaPath: string, lang: string, outDir: string): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        WHISPER_BIN,
        [mediaPath, "--model", WHISPER_MODEL, "--language", lang,
         "--output_format", "txt", "--output_dir", outDir, "--fp16", "False", "--verbose", "False"],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      p.on("error", (e) => reject(new Error(`whisper 起不来(没装/不在 PATH?设 WHISPER_BIN):${e.message}`)));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`whisper 退出码 ${code}。`))));
    });
    const base = path.basename(mediaPath).replace(/\.[^.]+$/, "");
    const txt = path.join(outDir, base + ".txt");
    if (!fs.existsSync(txt)) throw new Error("whisper 没产出 txt。");
    return fs.readFileSync(txt, "utf-8").trim();
  }
}
