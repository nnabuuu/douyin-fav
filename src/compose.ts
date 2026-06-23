import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, CaptchaError, NoValidTokenError, UnsupportedPlatformError, type VideoResult } from "./domain/model.js";
import { TranscribeVideo } from "./application/transcribe-video.js";
import { TokenAdmin } from "./application/token-admin.js";
import { JobQueue } from "./application/job-queue.js";
import { SyncService } from "./application/sync-service.js";
import { FileTokenStore } from "./infrastructure/file-token-store.js";
import { FileConfigStore } from "./infrastructure/file-config-store.js";
import { WhisperTranscriber } from "./infrastructure/whisper-transcriber.js";
import { RawAnalyzer } from "./infrastructure/raw-analyzer.js";
import { NotionExporter } from "./infrastructure/notion-exporter.js";
import { PlaywrightGateway } from "./infrastructure/playwright-gateway.js";
import { BrowserExtractor } from "./infrastructure/browser-extractor.js";
import { SystemCheck } from "./infrastructure/system-check.js";
import { DouyinProvider } from "./infrastructure/providers/douyin.js";
import { BilibiliProvider } from "./infrastructure/providers/bilibili.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.join(ROOT, "workspace");

/** Map domain errors → UI buckets so the Transcribe page can route them (notoken → 去登录, etc.). */
function classifyError(e: unknown): string | undefined {
  if (e instanceof NoValidTokenError) return "notoken";
  if (e instanceof CaptchaError) return "captcha";
  if (e instanceof UnsupportedPlatformError) return "unsupported";
  if (e instanceof AuthError) return "auth";
  return undefined;
}

/** Composition root: build the object graph, wire ports → adapters. */
export function compose() {
  const store = new FileTokenStore();
  const config = new FileConfigStore();
  const transcriber = new WhisperTranscriber();
  const providers = [new DouyinProvider(transcriber, WORKSPACE), new BilibiliProvider()];
  const gateway = new PlaywrightGateway(providers);
  const extractor = new BrowserExtractor(gateway, providers);
  const transcribe = new TranscribeVideo(store, extractor, gateway);
  const admin = new TokenAdmin(store, gateway);
  const analyzer = new RawAnalyzer();
  const exporter = new NotionExporter(config);
  const sync = new SyncService(config, store, extractor, transcribe, analyzer, exporter);
  const jobs = new JobQueue<VideoResult>((url, log) => transcribe.run(url, log), classifyError);
  const systemCheck = new SystemCheck();
  return { store, config, gateway, extractor, transcribe, admin, analyzer, exporter, sync, jobs, systemCheck };
}
