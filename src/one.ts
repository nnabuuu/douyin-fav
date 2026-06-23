import { compose } from "./compose.js";

// CLI: npx tsx src/one.ts <url | awemeId>
const input = process.argv[2];
if (!input) {
  console.error("用法: npx tsx src/one.ts <url | awemeId>");
  process.exit(1);
}

const { transcribe, gateway } = compose();
try {
  const r = await transcribe.run(input, (m) => console.error(m));
  if (r.desc) console.log(`\n--- 文案 ---\n${r.desc}`);
  console.log(`\n--- 口播逐字稿 (${r.source}${r.cached ? ", 缓存" : ""}) ---\n${r.transcript}\n`);
  console.log(`→ workspace/${r.platform}/${r.videoId}/transcript.md`);
} catch (e) {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  await gateway.closeAll();
}
