/* Pure-logic test suite (no browser, no ASR, no network). Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AuthError, CaptchaError, NoValidTokenError, UnsupportedPlatformError,
  resolvePlatform, videoUrl, type Token, type VideoResult,
} from "./domain/model.js";
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from "./domain/config.js";
import type { ConfigStore, Exporter, Extractor, SyncStore, TokenAuthenticator, TokenStore } from "./domain/ports.js";
import type { SyncRun } from "./domain/sync.js";
import { retry } from "./infrastructure/net.js";
import { RawAnalyzer } from "./infrastructure/raw-analyzer.js";
import { NotionExporter } from "./infrastructure/notion-exporter.js";
import { FileSyncStore } from "./infrastructure/file-sync-store.js";
import { parseList, extractSubtitleTrack, DouyinProvider } from "./infrastructure/providers/douyin.js";
import { TranscribeVideo } from "./application/transcribe-video.js";
import { JobQueue } from "./application/job-queue.js";
import { SyncService } from "./application/sync-service.js";

// ─────────────────────────── fakes ───────────────────────────
const tok = (id: string, status: Token["status"] = "valid"): Token => ({
  id, platform: "douyin", label: id, profileDir: "/tmp/" + id, status, createdAt: "t", failureCount: 0,
});

class FakeStore implements TokenStore {
  constructor(public tokens: Token[]) {}
  private cursor = 0;
  list() { return this.tokens; }
  get(id: string) { return this.tokens.find((t) => t.id === id); }
  add(t: Token) { this.tokens.push(t); }
  update(id: string, patch: Partial<Token>) { const t = this.get(id); if (t) Object.assign(t, patch); return t; }
  remove(id: string) { const i = this.tokens.findIndex((t) => t.id === id); if (i < 0) return false; this.tokens.splice(i, 1); return true; }
  nextValid() {
    const pool = this.tokens.filter((t) => t.status === "valid" || t.status === "unknown");
    if (!pool.length) return undefined;
    const t = pool[this.cursor % pool.length]; this.cursor++; return t;
  }
}

class FakeExporter implements Exporter {
  existing: Set<string>;
  created: string[] = [];
  constructor(existing: string[] = []) { this.existing = new Set(existing); }
  async has(id: string) { return this.existing.has(id); }
  async export(r: VideoResult): Promise<"created" | "skipped"> {
    if (this.existing.has(r.videoId)) return "skipped";
    this.existing.add(r.videoId); this.created.push(r.videoId); return "created";
  }
}

function fakeSyncStore(): SyncStore {
  const exported = new Set<string>();
  return { listRuns: () => [], getRun: () => undefined, saveRun: () => {}, isExported: (id) => exported.has(id), markExported: (id) => { exported.add(id); } };
}

const result = (tokenId: string): VideoResult => ({
  platform: "douyin", videoId: "v", title: "t", desc: "", author: "", transcript: "x", source: "asr", tokenId, cached: false });
const rid = (videoId: string, cached = false): VideoResult => ({
  platform: "douyin", videoId, title: videoId, desc: "", author: "", transcript: "x", source: "asr", tokenId: "A", cached });

function fakeExtractor(over: Partial<Extractor> = {}): Extractor {
  return { peekCache: () => null, extract: async (_u, t) => result(t.id), listCollection: async () => [], ...over };
}
const okAuth: TokenAuthenticator = { validate: async () => ({ valid: true }), login: async () => ({ valid: true }) };

// ─────────────────────────── domain ───────────────────────────
test("resolvePlatform routes by url / bare id / null", () => {
  assert.equal(resolvePlatform("https://www.douyin.com/video/123"), "douyin");
  assert.equal(resolvePlatform("7650129245314316009"), "douyin");
  assert.equal(resolvePlatform("https://www.bilibili.com/video/BV1xx"), "bilibili");
  assert.equal(resolvePlatform("https://example.com/x"), null);
});

test("videoUrl builds canonical url per platform", () => {
  assert.equal(videoUrl("douyin", "9"), "https://www.douyin.com/video/9");
  assert.equal(videoUrl("bilibili", "BV9"), "https://www.bilibili.com/video/BV9");
});

test("mergeConfig keeps untouched groups", () => {
  const m = mergeConfig(DEFAULT_CONFIG, { schedule: { enabled: true, intervalMin: 30, perRun: 5 } });
  assert.equal(m.schedule.perRun, 5);
  assert.equal(m.notion.databaseId, DEFAULT_CONFIG.notion.databaseId);
});

// ─────────────────────────── net ───────────────────────────
test("retry: succeeds after transient, caps attempts, respects terminal", async () => {
  let calls = 0;
  assert.equal(await retry(async () => { if (++calls < 3) throw new Error("t"); return "ok"; }, { delays: [1, 1, 1] }), "ok");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("always"); }, { delays: [1, 1] }));
  assert.equal(calls, 3); // 1 + 2 retries
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new CaptchaError("stop"); }, { delays: [1, 1, 1], retryable: (e) => !(e instanceof CaptchaError) }));
  assert.equal(calls, 1); // terminal → no retry
});

// ─────────────────────────── douyin helpers ───────────────────────────
test("parseList tolerates shape variants", () => {
  const items = parseList({ aweme_list: [
    { aweme_id: "111", desc: "d", author: { nickname: "a" } },
    { aweme_info: { aweme_id: "222" } },
    { nothing: true },
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0].videoId, "111");
  assert.equal(items[0].author, "a");
});

test("extractSubtitleTrack: real cue track yes, post caption no", () => {
  assert.equal(extractSubtitleTrack({ aweme_detail: { video: { caption: [{ text: "一" }, { text: "二" }] } } }), "一\n二");
  assert.equal(extractSubtitleTrack({ aweme_detail: { video: { caption_text: "字幕文本" } } }), "字幕文本");
  // a.caption is the post 文案, NOT a subtitle — must return null
  assert.equal(extractSubtitleTrack({ aweme_detail: { caption: "这是文案", desc: "d", is_subtitled: 0 } }), null);
});

test("DouyinProvider.tryParseId parses video/modal_id/bare; null for short link", () => {
  const dp = new DouyinProvider({} as never, "/tmp");
  assert.equal(dp.tryParseId("7650129245314316009"), "7650129245314316009");
  assert.equal(dp.tryParseId("https://www.douyin.com/video/7650129245314316009?x=1"), "7650129245314316009");
  assert.equal(dp.tryParseId("https://www.douyin.com/user/self?modal_id=7650129245314316009"), "7650129245314316009");
  assert.equal(dp.tryParseId("https://v.douyin.com/AbCd/"), null); // short link needs the network
});

// ─────────────────────────── TranscribeVideo (rotation/failover) ───────────────────────────
test("rotation: two valid tokens used round-robin", async () => {
  const store = new FakeStore([tok("A"), tok("B")]);
  const tv = new TranscribeVideo(store, fakeExtractor(), okAuth);
  assert.equal((await tv.run("https://douyin.com/video/1")).tokenId, "A");
  assert.equal((await tv.run("https://douyin.com/video/1")).tokenId, "B");
});

test("failover: dead token marked invalid, next token used", async () => {
  const store = new FakeStore([tok("A"), tok("B")]);
  const ex = fakeExtractor({ extract: async (_u, t) => { if (t.id === "A") throw new AuthError("dead"); return result(t.id); } });
  const auth: TokenAuthenticator = { validate: async (t) => ({ valid: t.id !== "A" }), login: okAuth.login };
  const r = await new TranscribeVideo(store, ex, auth).run("https://douyin.com/video/1");
  assert.equal(r.tokenId, "B");
  assert.equal(store.get("A")!.status, "invalid");
});

test("cache hit returns without spending a token", async () => {
  const ex = fakeExtractor({ peekCache: () => ({ ...result("cached"), cached: true }) });
  const r = await new TranscribeVideo(new FakeStore([]), ex, okAuth).run("https://douyin.com/video/1");
  assert.equal(r.cached, true);
});

test("no valid token throws NoValidTokenError; unknown platform throws Unsupported", async () => {
  await assert.rejects(new TranscribeVideo(new FakeStore([tok("A", "invalid")]), fakeExtractor(), okAuth).run("https://douyin.com/video/1"), NoValidTokenError);
  await assert.rejects(new TranscribeVideo(new FakeStore([tok("A")]), fakeExtractor(), okAuth).run("https://example.com/x"), UnsupportedPlatformError);
});

test("AuthError but token still valid → rethrow (no failover storm)", async () => {
  const ex = fakeExtractor({ extract: async () => { throw new AuthError("transient"); } });
  await assert.rejects(new TranscribeVideo(new FakeStore([tok("A")]), ex, okAuth).run("https://douyin.com/video/1"), /transient/);
});

// ─────────────────────────── JobQueue ───────────────────────────
test("queue positions while a worker is held", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new JobQueue<string>(async (input) => { await gate; return input; });
  const j1 = q.submit("a"), j2 = q.submit("b"), j3 = q.submit("c");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(q.position(j1.id), { position: 1, ahead: 0 });
  assert.deepEqual(q.position(j2.id), { position: 2, ahead: 1 });
  assert.deepEqual(q.position(j3.id), { position: 3, ahead: 2 });
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.get(j1.id)!.status, "done");
});

test("JobQueue records errorKind via injected classifier", async () => {
  const q = new JobQueue<string>(async () => { throw new NoValidTokenError("x"); }, (e) => (e instanceof NoValidTokenError ? "notoken" : undefined));
  const j = q.submit("u");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.get(j.id)!.status, "error");
  assert.equal(q.get(j.id)!.errorKind, "notoken");
});

// ─────────────────────────── SyncService ───────────────────────────
function mkSync(opts: { items: string[]; perRun: number; existing?: string[]; run: (id: string) => Promise<VideoResult> }) {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, folders: ["https://www.douyin.com/user/self?showTab=favorite_collection"],
    schedule: { enabled: false, intervalMin: 60, perRun: opts.perRun } };
  const config: ConfigStore = { get: () => cfg, update: () => cfg };
  const extractor = fakeExtractor({ listCollection: async () => opts.items.map((id) => ({ videoId: id, desc: "", author: "" })) });
  const exporter = new FakeExporter(opts.existing);
  const transcribe = { run: async (url: string) => opts.run(url.match(/video\/(\d+)/)![1]) } as unknown as TranscribeVideo;
  const svc = new SyncService(config, new FakeStore([tok("A")]), extractor, transcribe, new RawAnalyzer(), exporter, fakeSyncStore());
  return { svc, exporter };
}

test("sync writes new, records per-video, idempotent skip on already-present", async () => {
  const a = mkSync({ items: ["1", "2"], perRun: 10, run: async (id) => rid(id) });
  let r = await a.svc.runOnce();
  assert.equal(r.synced, 2);
  assert.deepEqual(a.exporter.created.sort(), ["1", "2"]);
  assert.equal(r.items.filter((i) => i.status === "exported").length, 2);

  const b = mkSync({ items: ["1", "2"], perRun: 10, existing: ["1"], run: async (id) => rid(id) });
  r = await b.svc.runOnce();
  assert.equal(r.synced, 1);
  assert.deepEqual(b.exporter.created, ["2"]);
});

test("cap stops the round; 100 is the hard ceiling", async () => {
  const c = mkSync({ items: ["1", "2", "3"], perRun: 2, run: async (id) => rid(id) });
  assert.equal((await c.svc.runOnce()).synced, 2);
  assert.equal(mkSync({ items: [], perRun: 500, run: async (id) => rid(id) }).svc.status().cap, 100);
});

test("one failure records + doesn't abort the round", async () => {
  const e = mkSync({ items: ["1", "2"], perRun: 10, run: async (id) => { if (id === "1") throw new Error("boom"); return rid(id); } });
  const r = await e.svc.runOnce();
  assert.equal(r.failed, 1);
  assert.equal(r.synced, 1);
  const failed = r.items.find((i) => i.status === "failed");
  assert.equal(failed?.videoId, "1");
  assert.ok(failed?.reason?.includes("boom"));
});

test("cancel mid-round → status stopped", async () => {
  const holder: { svc?: SyncService } = {};
  const { svc } = mkSync({ items: ["1", "2", "3"], perRun: 10, run: async (id) => { if (id === "1") holder.svc!.cancel(); return rid(id); } });
  holder.svc = svc;
  const r = await svc.runOnce();
  assert.equal(r.status, "stopped");
  assert.equal(r.synced, 1); // "1" finished, "2" never started
});

// ─────────────────────────── NotionExporter (mock fetch) ───────────────────────────
test("NotionExporter: no token → skipped; with token → query then chunked create", async () => {
  let cfg: AppConfig = { ...DEFAULT_CONFIG, notion: { token: "", databaseId: "" } };
  const config: ConfigStore = { get: () => cfg, update: () => cfg };
  const exp = new NotionExporter(config);
  assert.equal(await exp.has("v1"), false);
  assert.equal(await exp.export(rid("v1"), "x", undefined), "skipped");

  cfg = { ...DEFAULT_CONFIG, notion: { token: "ntn_x", databaseId: "db1" } };
  const calls: { url: string; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init && JSON.parse(init.body) });
    if (String(url).includes("/query")) return { ok: true, json: async () => ({ results: [] }) };
    return { ok: true, json: async () => ({ id: "page1" }) };
  }) as unknown as typeof fetch;
  try {
    const long = "字".repeat(5000); // > 2000 → must be chunked across blocks
    const r = { ...rid("v2"), title: "T", desc: "D", author: "A", transcript: long };
    assert.equal(await exp.export(r, long, undefined), "created");
    const create = calls.find((c) => c.url.includes("/pages"))!;
    assert.ok(calls.find((c) => c.url.includes("/query")), "queried for dedup first");
    assert.equal(create.body.properties.videoId.rich_text[0].text.content, "v2");
    assert.equal(create.body.properties.platform.select.name, "douyin");
    const paras = create.body.children.filter((b: any) => b.type === "paragraph");
    assert.ok(paras.length >= 3, "long transcript chunked into multiple blocks");
    assert.ok(paras.every((b: any) => b.paragraph.rich_text[0].text.content.length <= 2000), "each block within Notion's 2000-char limit");
  } finally { globalThis.fetch = orig; }
});

// ─────────────────────────── FileSyncStore ───────────────────────────
test("FileSyncStore: persist + reload, trim to 50, exported dedup", () => {
  const tmp = path.join(os.tmpdir(), `dy-sync-${process.pid}-${process.hrtime.bigint()}.json`);
  const mkRun = (id: string): SyncRun => ({ id, startedAt: "t", status: "done", cap: 100, synced: 0, skipped: 0, failed: 0, items: [] });
  try {
    const s = new FileSyncStore(tmp);
    for (let i = 0; i < 60; i++) s.saveRun(mkRun("r" + i));
    assert.equal(s.listRuns().length, 50);            // trimmed to KEEP
    assert.equal(s.listRuns()[0].id, "r59");           // most recent first
    assert.equal(s.getRun("r0"), undefined);           // oldest dropped
    s.markExported("vid1");
    s.saveRun(mkRun("r60"));                            // persists runs + exported set
    const s2 = new FileSyncStore(tmp);                 // reload from disk
    assert.equal(s2.listRuns().length, 50);
    assert.equal(s2.isExported("vid1"), true);
    assert.equal(s2.getRun("r60")!.cap, 100);
  } finally { fs.rmSync(tmp, { force: true }); }
});

// ─────────────────────────── RawAnalyzer ───────────────────────────
test("RawAnalyzer is a passthrough (no LLM this period)", async () => {
  const a = await new RawAnalyzer().analyze(rid("v"));
  assert.equal(a.cleaned, "x");
  assert.equal(a.summary, undefined);
});
