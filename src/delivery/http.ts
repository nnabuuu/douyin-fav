import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobQueue } from "../application/job-queue.js";
import type { TokenAdmin } from "../application/token-admin.js";
import type { SyncService } from "../application/sync-service.js";
import type { Analyzer, ConfigStore, Exporter } from "../domain/ports.js";
import type { VideoResult, Platform } from "../domain/model.js";
import type { SystemCheck } from "../infrastructure/system-check.js";

const TOKEN = process.env.TOKEN || ""; // if set, gate /api/* with ?token=
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Deps {
  jobs: JobQueue<VideoResult>;
  admin: TokenAdmin;
  config: ConfigStore;
  sync: SyncService;
  analyzer: Analyzer;
  exporter: Exporter;
  systemCheck: SystemCheck;
}

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type + "; charset=utf-8" });
  res.end(type.includes("json") ? JSON.stringify(body) : (body as string));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

// ── serve the Claude Design frontend (design/*.dc.html + support.js + assets) ──
const DESIGN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "design");
const PAGE_FILES: Record<string, string> = {
  "/": "Transcribe.dc.html",
  "/config": "Config.dc.html",
  "/setup": "Setup Wizard.dc.html",
  "/tokens": "Tokens.dc.html",
};
const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".svg": "image/svg+xml",
  ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2",
};
/** Serve a design file for nice routes (/, /config…) or by raw name (support.js, *.dc.html, assets/*). */
function serveDesign(pathname: string, res: http.ServerResponse): boolean {
  const rel = PAGE_FILES[pathname] ?? decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel) return false;
  const file = path.join(DESIGN_DIR, rel);
  if (!file.startsWith(DESIGN_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ct = CONTENT_TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": ct + "; charset=utf-8" });
  res.end(fs.readFileSync(file));
  return true;
}

export function createHttp(deps: Deps): http.Server {
  const { jobs, admin, config, sync, analyzer, exporter, systemCheck: sys } = deps;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const { pathname } = url;
    const method = req.method || "GET";

    if (method === "GET" && serveDesign(pathname, res)) return;

    if (pathname.startsWith("/api/")) {
      if (TOKEN && url.searchParams.get("token") !== TOKEN) return send(res, 401, { error: "bad token" });

      // ── setup wizard ──
      if (method === "GET" && pathname === "/api/setup/status") {
        const cfg = config.get();
        const valid = admin.list().filter((t) => t.status === "valid");
        let notion: { ok: boolean; detail: string };
        if (!cfg.notion.token || !cfg.notion.databaseId) {
          notion = { ok: false, detail: "未配置 token / 库" };
        } else {
          try { await exporter.has("__setup_probe__"); notion = { ok: true, detail: "已连接" }; }
          catch (e) { notion = { ok: false, detail: "连接失败: " + msg(e) }; }
        }
        return send(res, 200, {
          node: sys.node(), chromium: sys.chromium(), ffmpeg: sys.ffmpeg(), whisper: sys.whisper(),
          tokens: { ok: valid.length > 0, detail: valid.length ? `${valid.length} 个有效` : "无有效 token", count: valid.length },
          notion,
          folders: cfg.folders, schedule: cfg.schedule,
        });
      }
      if (method === "POST" && pathname === "/api/setup/install/chromium") return send(res, 200, await sys.installChromium());
      if (method === "POST" && pathname === "/api/setup/install/whisper") return send(res, 200, await sys.installWhisper());

      // ── config ──
      if (method === "GET" && pathname === "/api/config") return send(res, 200, config.get());
      if (method === "PUT" && pathname === "/api/config") {
        const patch = await readJson(req);
        return send(res, 200, config.update(patch));
      }
      // Notion connectivity test (the "保存并测试" buttons)
      if (method === "POST" && pathname === "/api/notion/test") {
        const { token, databaseId } = config.get().notion;
        if (!token || !databaseId) return send(res, 200, { ok: false, detail: "未配置 token / 库" });
        try { await exporter.has("__notion_test__"); return send(res, 200, { ok: true, detail: "已连接" }); }
        catch (e) { return send(res, 200, { ok: false, detail: "连接失败: " + msg(e) }); }
      }

      // ── auto-sync ──
      if (method === "POST" && pathname === "/api/sync/run") {
        sync.runOnce().catch(() => {}); // fire-and-forget; watch via /api/sync/status
        return send(res, 200, { started: true });
      }
      if (method === "GET" && pathname === "/api/sync/status") return send(res, 200, sync.status());
      if (method === "POST" && pathname === "/api/sync/start") { sync.start(); return send(res, 200, sync.status()); }
      if (method === "POST" && pathname === "/api/sync/stop") { sync.stop(); return send(res, 200, sync.status()); }

      // ── transcription jobs ──
      if (method === "POST" && pathname === "/api/jobs") {
        const body = await readJson(req);
        const input = String(body.url || "").trim();
        if (!input) return send(res, 400, { error: "missing url" });
        const job = jobs.submit(input);
        return send(res, 200, { id: job.id, status: job.status });
      }
      const jm = pathname.match(/^\/api\/jobs\/(\w+)$/);
      if (method === "GET" && jm) {
        const job = jobs.get(jm[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        return send(res, 200, {
          status: job.status, ...jobs.position(job.id),
          log: job.log, result: job.result, error: job.error, errorKind: job.errorKind,
        });
      }
      // per-video manual export to Notion (the Transcribe page's "同步到 Notion" button)
      const em = pathname.match(/^\/api\/jobs\/(\w+)\/export-notion$/);
      if (method === "POST" && em) {
        const job = jobs.get(em[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        if (job.status !== "done" || !job.result) return send(res, 400, { error: "job 未完成" });
        try {
          const { cleaned, summary } = await analyzer.analyze(job.result);
          const outcome = await exporter.export(job.result, cleaned, summary); // "created" | "skipped"
          return send(res, 200, { outcome });
        } catch (e) {
          return send(res, 200, { outcome: "error", detail: msg(e) }); // bad/expired Notion token, etc.
        }
      }

      // ── token pool ──
      if (method === "GET" && pathname === "/api/tokens") return send(res, 200, admin.list());
      if (method === "POST" && pathname === "/api/tokens") {
        const body = await readJson(req);
        const platform = (body.platform || "douyin") as Platform;
        const token = admin.beginAdd(platform, body.label);
        return send(res, 200, token); // status: logging_in — poll the token to watch login
      }
      const tm = pathname.match(/^\/api\/tokens\/(\w+)$/);
      if (tm) {
        if (method === "GET") {
          const t = admin.get(tm[1]);
          return t ? send(res, 200, t) : send(res, 404, { error: "no such token" });
        }
        if (method === "DELETE") {
          return send(res, 200, { ok: admin.remove(tm[1]) });
        }
      }
      const vm = pathname.match(/^\/api\/tokens\/(\w+)\/validate$/);
      if (method === "POST" && vm) {
        const t = await admin.validate(vm[1]);
        return t ? send(res, 200, t) : send(res, 404, { error: "no such token" });
      }
    }

    send(res, 404, { error: "not found" });
  });
}
