/* Pure-logic self-check (no browser, no ASR). Run: npx tsx src/selftest.ts */
import assert from "node:assert";
import { AuthError, CaptchaError, NoValidTokenError, resolvePlatform, type Token, type VideoResult } from "./domain/model.js";
import { retry } from "./infrastructure/net.js";
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from "./domain/config.js";
import type { ConfigStore, Exporter, Extractor, TokenAuthenticator, TokenStore } from "./domain/ports.js";
import { TranscribeVideo } from "./application/transcribe-video.js";
import { JobQueue } from "./application/job-queue.js";
import { SyncService } from "./application/sync-service.js";
import { RawAnalyzer } from "./infrastructure/raw-analyzer.js";
import { parseList } from "./infrastructure/providers/douyin.js";

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
  async export(r: VideoResult, _cleaned: string, _summary: string | undefined): Promise<"created" | "skipped"> {
    if (this.existing.has(r.videoId)) return "skipped";
    this.existing.add(r.videoId);
    this.created.push(r.videoId);
    return "created";
  }
}

const result = (tokenId: string): VideoResult => ({
  platform: "douyin", videoId: "v", title: "t", desc: "", author: "", transcript: "x", source: "asr", tokenId, cached: false,
});

function fakeExtractor(over: Partial<Extractor> = {}): Extractor {
  return { peekCache: () => null, extract: async (_u, t) => result(t.id), listCollection: async () => [], ...over };
}
const okAuth: TokenAuthenticator = { validate: async () => ({ valid: true }), login: async () => ({ valid: true }) };

async function run() {
  // 1) URL routing
  assert.equal(resolvePlatform("https://www.douyin.com/video/123"), "douyin");
  assert.equal(resolvePlatform("7650129245314316009"), "douyin");
  assert.equal(resolvePlatform("https://www.bilibili.com/video/BV1xx"), "bilibili");
  assert.equal(resolvePlatform("https://example.com/x"), null);

  // 2) rotation: two valid tokens used round-robin
  const store = new FakeStore([tok("A"), tok("B")]);
  const tv = new TranscribeVideo(store, fakeExtractor(), okAuth);
  assert.equal((await tv.run("https://douyin.com/video/1")).tokenId, "A");
  assert.equal((await tv.run("https://douyin.com/video/1")).tokenId, "B");

  // 3) failover: A throws AuthError + validates invalid → marks A invalid, uses B
  const s3 = new FakeStore([tok("A"), tok("B")]);
  const ex3 = fakeExtractor({ extract: async (_u, t) => { if (t.id === "A") throw new AuthError("dead"); return result(t.id); } });
  const auth3: TokenAuthenticator = { validate: async (t) => ({ valid: t.id !== "A" }), login: okAuth.login };
  const r3 = await new TranscribeVideo(s3, ex3, auth3).run("https://douyin.com/video/1");
  assert.equal(r3.tokenId, "B");
  assert.equal(s3.get("A")!.status, "invalid");

  // 4) cache hit: no token spent
  const s4 = new FakeStore([]);
  const ex4 = fakeExtractor({ peekCache: () => ({ ...result("cached"), cached: true }) });
  const r4 = await new TranscribeVideo(s4, ex4, okAuth).run("https://douyin.com/video/1");
  assert.equal(r4.cached, true);

  // 5) no valid token → NoValidTokenError
  const s5 = new FakeStore([tok("A", "invalid")]);
  await assert.rejects(new TranscribeVideo(s5, fakeExtractor(), okAuth).run("https://douyin.com/video/1"), NoValidTokenError);

  // 6) AuthError but token still valid → rethrows (no failover storm)
  const s6 = new FakeStore([tok("A")]);
  const ex6 = fakeExtractor({ extract: async () => { throw new AuthError("transient"); } });
  await assert.rejects(new TranscribeVideo(s6, ex6, okAuth).run("https://douyin.com/video/1"), /transient/);

  // 7) queue positions while worker is held
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new JobQueue<string>(async (input) => { await gate; return input; });
  const j1 = q.submit("a"), j2 = q.submit("b"), j3 = q.submit("c");
  await new Promise((r) => setTimeout(r, 10)); // let worker pick up j1
  assert.deepEqual(q.position(j1.id), { position: 1, ahead: 0 });
  assert.deepEqual(q.position(j2.id), { position: 2, ahead: 1 });
  assert.deepEqual(q.position(j3.id), { position: 3, ahead: 2 });
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.get(j1.id)!.status, "done");

  // 8) config merge keeps untouched groups
  const merged = mergeConfig(DEFAULT_CONFIG, { schedule: { enabled: true, intervalMin: 30, perRun: 5 } });
  assert.equal(merged.schedule.perRun, 5);
  assert.equal(merged.notion.databaseId, DEFAULT_CONFIG.notion.databaseId);

  // 9) listcollection parsing tolerates shape variants
  const parsed = parseList({ aweme_list: [
    { aweme_id: "111", desc: "d", author: { nickname: "a" } },
    { aweme_info: { aweme_id: "222" } },
    { nothing: true },
  ] });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].videoId, "111");
  assert.equal(parsed[0].author, "a");

  // 10) SyncService: idempotent dedup, budget caps NEW work, cache is free, failures don't abort
  const sync = (opts: {
    items: string[]; perRun: number; existing?: string[];
    run: (id: string) => Promise<VideoResult>;
  }) => {
    const cfg: AppConfig = { ...DEFAULT_CONFIG, folders: ["https://www.douyin.com/user/self?showTab=favorite_collection"],
      schedule: { enabled: false, intervalMin: 60, perRun: opts.perRun } };
    const config: ConfigStore = { get: () => cfg, update: () => cfg };
    const store = new FakeStore([tok("A")]);
    const extractor = fakeExtractor({ listCollection: async () => opts.items.map((id) => ({ videoId: id, desc: "", author: "" })) });
    const exporter = new FakeExporter(opts.existing);
    const transcribe = { run: async (url: string) => opts.run(url.match(/video\/(\d+)/)![1]) } as unknown as TranscribeVideo;
    return { svc: new SyncService(config, store, extractor, transcribe, new RawAnalyzer(), exporter), exporter };
  };
  const rid = (videoId: string, cached = false): VideoResult => ({
    platform: "douyin", videoId, title: videoId, desc: "", author: "", transcript: "x", source: "asr", tokenId: "A", cached });

  const a = sync({ items: ["1", "2"], perRun: 10, run: async (id) => rid(id) });
  let sum = await a.svc.runOnce();
  assert.equal(sum.synced, 2);
  assert.deepEqual(a.exporter.created.sort(), ["1", "2"]);

  const b = sync({ items: ["1", "2"], perRun: 10, existing: ["1"], run: async (id) => rid(id) });
  sum = await b.svc.runOnce();
  assert.equal(sum.synced, 1); // "1" already present → skipped, only "2" written
  assert.deepEqual(b.exporter.created, ["2"]);

  const c = sync({ items: ["1", "2"], perRun: 1, run: async (id) => rid(id) });
  sum = await c.svc.runOnce();
  assert.equal(sum.synced, 1); // perRun budget caps NEW transcriptions

  const d = sync({ items: ["1", "2"], perRun: 1, run: async (id) => rid(id, id === "1") });
  sum = await d.svc.runOnce();
  assert.equal(sum.synced, 2); // "1" cached (free), so "2" still fits the budget

  const e = sync({ items: ["1", "2"], perRun: 10, run: async (id) => { if (id === "1") throw new Error("boom"); return rid(id); } });
  sum = await e.svc.runOnce();
  assert.equal(sum.failed, 1);
  assert.equal(sum.synced, 1); // one failure doesn't abort the round
  assert.deepEqual(sum.errors, [{ id: "1", reason: "boom" }]); // P2: structured {id, reason}

  // P1: per-video export building blocks — analyze (passthrough) → idempotent export
  const exp = new FakeExporter();
  const an = await new RawAnalyzer().analyze(rid("xyz"));
  assert.equal(an.cleaned, "x"); // raw analyzer = transcript passthrough
  assert.equal(await exp.export(rid("xyz"), an.cleaned, an.summary), "created");
  assert.equal(await exp.export(rid("xyz"), an.cleaned, an.summary), "skipped"); // idempotent by videoId

  // 11) retry: succeeds after transient failures, caps attempts, respects terminal predicate
  let calls = 0;
  const ok = await retry(async () => { if (++calls < 3) throw new Error("transient"); return "ok"; }, { delays: [1, 1, 1] });
  assert.equal(ok, "ok");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("always"); }, { delays: [1, 1] }));
  assert.equal(calls, 3); // 1 initial + 2 retries

  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new CaptchaError("stop"); },
    { delays: [1, 1, 1], retryable: (e) => !(e instanceof CaptchaError) }));
  assert.equal(calls, 1); // terminal error → no retry

  console.log("✓ all self-checks passed");
}

run().catch((e) => { console.error("✗", e); process.exit(1); });
