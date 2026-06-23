# BUILD_PLAN — 通宵自主开发(a + b)

> 这是给自主循环(/loop 或 /goal)的执行契约。每次被唤起:读本文件 → 做**下一个未勾选项** → 勾选 → 跑 `npm test` + `npx tsc --noEmit` 保持绿 → 在 `OVERNIGHT_REPORT.md` 追一行进度。做完所有项就停。

## 规则(每次都遵守)
- **不要问用户任何问题。** 决定已在下方锁定。遇到需要用户的硬阻塞(缺 token/缺凭证/语义歧义)→ **跳过该项,继续做能做的**,把阻塞记到 `OVERNIGHT_REPORT.md` 的「卡住等你」。
- 不 ping、不推送。用户在睡觉。所有结果留早上看。
- 每完成一项:更新本文件的 checkbox + `OVERNIGHT_REPORT.md`。小步、可回退。
- 保持 clean architecture 分层(domain 不依赖 infra)和平台 seam。新东西照样走 ports & adapters。
- 每个非平凡逻辑留一个 `npm test` 能跑的断言(沿用 `src/selftest.ts` 风格,无框架)。

## 锁定的决定
- **运行期同步 = 服务自带调度器**,零 Claude Code 依赖。绝不靠 /loop 或 MCP 跑运行期。
- **不接 LLM 分析**(本期)。`Analyzer` port + `RawAnalyzer`(原样透传)。`AnthropicAnalyzer` 只留 TODO 注释做未来 drop-in,**不实现、不调 Claude API**。
- **Notion**:服务用**可配 integration token + Notion REST API** 写,按 `videoId` 幂等(写前查重)。**不走 MCP**。目标库 id 见下方 `NOTION_DB_ID`(建好后回填)。
- 调度默认 `intervalMin=60`、`perRun=10`,可配。ASR=turbo。转写成功后删 `v.mp4`。
- 收藏夹:默认主 `favorite_collection`;多个由 `/config` 配。

## 变量(建好回填)
- `NOTION_DB_ID`: `c3be64840d2f435ebe8f90ff137a9830`
- `NOTION_DB_URL`: https://app.notion.com/p/c3be64840d2f435ebe8f90ff137a9830
- `NOTION_DATASOURCE`: `collection://a1b2850c-441f-454e-a3dd-80ba046becc5`(REST 用 data source / database id)
- Notion 属性名(给 exporter 用):标题=`Name`、`videoId`(text)、`author`(text)、url 列内部名=`userDefined:url`(显示名 url)、`platform`(select)、`source`(select)、日期=`date`(写 `date:date:start`)

## 任务清单(按序)
- [x] 1. ✅ 已建「抖音收藏字幕」数据库 + 写入 1 条真实测试页验证 schema。变量已回填上方。
- [x] 2. ✅ config:`domain/config.ts`(AppConfig+DEFAULT+mergeConfig);`FileConfigStore`;`GET/PUT /api/config`;localhost `/config` 编辑+同步控制页。
- [x] 3. ✅ `Analyzer` port + `RawAnalyzer`(passthrough)。AnthropicAnalyzer 留 TODO 注释。
- [x] 4. ✅ `Exporter` port + `NotionExporter`(Notion REST,运行时读 config 的 token+dbId,按 videoId 查重幂等;无 token 则 no-op skipped)。
- [x] 5. ✅ `ContentProvider.listCollection`(douyin:滚动+拦 listcollection);`parseList` 导出可测;`extractor.listCollection`。(注:用 SyncService 驱动,未单独加 `/api/folders/sync` 端点——sync 已覆盖)
- [x] 6. ✅ `SyncService`:scan→transcribe(轮换/failover)→RawAnalyzer→Exporter(幂等);自调度 timer(运行时读 intervalMin);`/api/sync/run|status|start|stop`。单测:幂等/预算/缓存免费/单条失败不中断。
- [x] 7. ✅ ASR 成功后删 `v.mp4`。
- [x] 8. ✅ Pre-flight:真实扫主收藏夹成功(**47 条**,token valid,account 拿到);pipeline 逻辑由 selftest 覆盖,Notion schema 由项1 MCP 测试页证明。
- [x] 9. ✅ onboarding:`src/setup.ts` + `npm run setup`(node 检查 → playwright install → 写默认 config → 打印连 Notion/加 token/配收藏夹的分步指引)。
- [x] 10. ✅ `.claude/skills/douyin-notion-sync/SKILL.md` + `docs/deploy.md` 自部署文档。
- [x] 11. ✅ 扩 `src/selftest.ts`:config merge / parseList / SyncService 幂等+预算+缓存+失败。`npm test` + `tsc` 全绿。
- [x] 12. ✅ 更新 `README.md`(新架构+服务自动同步+自部署);`OVERNIGHT_REPORT.md` 最终总结。

## ✅ 全部 12 项完成。a(服务自动同步)+ b(自部署+onboarding+skill)均已落地,tsc + npm test 全绿。
