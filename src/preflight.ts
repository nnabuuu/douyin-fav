/* Real preflight: validate a token + scan the configured favorites folder once. */
import { compose } from "./compose.js";

const { store, config, admin, extractor, gateway } = compose();
try {
  const token = store.list().find((t) => t.platform === "douyin");
  if (!token) throw new Error("池里没有 douyin token");

  const v = await admin.validate(token.id);
  console.log(`token「${token.label}」→ ${v?.status} · 账号: ${v?.account?.nickname ?? "—"}`);
  if (v?.status !== "valid") throw new Error("token 未验证通过,跳过扫描");

  const folder = config.get().folders[0];
  console.log(`扫描收藏夹: ${folder}`);
  const items = await extractor.listCollection(folder, store.get(token.id)!, (m) => console.log("  " + m));
  console.log(`\n✓ 扫描到 ${items.length} 条。样例:`);
  for (const it of items.slice(0, 5)) console.log(`  - ${it.videoId}  ${(it.desc || "").slice(0, 28)}  @${it.author}`);
} catch (e) {
  console.error("✗ preflight: " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  await gateway.closeAll();
}
