---
name: douyin-notion-sync
description: Set up and operate the local douyin→Notion transcript sync service. Use when the user wants to install, configure, start, or troubleshoot syncing their Douyin favorites to Notion, add a login token (QR), connect Notion, or check sync status.
---

# douyin → Notion 同步

本地常驻服务:定时扫抖音收藏夹 → 转写字幕/口播 → 写入 Notion。运行期不依赖 Claude Code。完整文档见 `docs/deploy.md`。

## 首次安装
1. `npm install`
2. `npm run setup` — 装 Chromium、写默认 config、打印后续步骤。
3. 确认本机有 `ffmpeg` 和 `whisper`(无字幕视频要本地 ASR)。缺失时引导用户安装(见 deploy.md 前置)。

## 启动 / 操作(都走 HTTP,默认 http://localhost:8787)
- 启动:`npm run serve`(常驻;防睡眠 `caffeinate -dimsu npm run serve`)。
- 加 token(扫码):`POST /api/tokens` → 用户在弹出窗口扫码 → 轮询 `GET /api/tokens/<id>` 到 `valid`。
- 连 Notion:引导用户在 notion.so/my-integrations 建 integration、把目标库 Connections 加上它、把 token+databaseId 填到 `/config`。
- 配收藏夹 / 节奏:编辑 `/config`(`folders`、`schedule.intervalMin`、`schedule.perRun`、`schedule.enabled`)。
- 手动同步:`POST /api/sync/run`;状态:`GET /api/sync/status`。

## 排障
- 同步 0 条 / token `invalid`:让用户重新扫码加 token(掉登录或风控)。
- Notion `skipped` 一直不写:多半没填 `notion.token` 或没把库共享给 integration。
- 无字幕视频不转写:检查 `whisper`/`ffmpeg` 是否在 PATH(或设 `WHISPER_BIN`)。

## 重要
- 不要替用户把服务暴露公网裸跑;要外网用加 `TOKEN=` 门禁 + 隧道。
- 自动化访问踩抖音 ToS,提醒用户低频自用、风险自负。
