# douyin-fav

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen.svg) ![CDN: none](https://img.shields.io/badge/CDN-none·可离线-success.svg) ![tests: node:test](https://img.shields.io/badge/tests-node%3Atest-success.svg)

把抖音收藏夹里的视频转成文字稿(有字幕轨用字幕,没有就本地 whisper 转口播),可单条提取、起本地服务给别人用、或定时自动同步到 Notion。Headful Playwright + 持久会话,不逆向签名——浏览器自己算,我们只拦它发出的 JSON。

## 三种用法

```bash
npm install
npm run setup                       # 装 Chromium + 默认配置 + 引导

# 1) 单条
npm run one <抖音链接 | awemeId>     # → workspace/douyin/<id>/transcript.md

# 2) 服务(贴链接拿字幕,自带排队 + 缓存)
npm run serve                       # http://localhost:8787

# 3) 定时同步到 Notion(运行期零 Claude Code)
#    /config 里配 Notion token + 收藏夹,schedule.enabled=true
```

`npm run serve` 后打开 `http://localhost:8787` 是「即见」本地 Web 界面(提取字幕 `/`、自动同步 `/config`、Token 管理 `/tokens`、安装向导 `/setup`),由服务直接发 `design/`。**React 与字体都已 vendor 到本地(`design/vendor/`),无任何 CDN 依赖,可完全离线自托管。**

## 架构(clean architecture,平台按 URL 分发)

```
domain/          纯逻辑,无 IO     model(实体+resolvePlatform+videoUrl) · config · ports
application/     用例,只依赖 ports transcribe-video(轮换+failover) · sync-service(定时) · token-admin · job-queue
infrastructure/  适配器           playwright-gateway · browser-extractor · {file-token,file-config}-store
                                 whisper-transcriber · raw-analyzer · notion-exporter · providers/{douyin,bilibili}
delivery/        HTTP            http(字幕任务 + token + config + sync)
compose.ts       组合根。server.ts / one.ts / preflight.ts / setup.ts 都用它
```

加平台(如 bilibili)= 写一个 `providers/*.ts`(已占位,URL 路由已通),其余层不动。

## 关键端点

| | |
|---|---|
| `POST /api/jobs` · `GET /api/jobs/:id` | 单条字幕任务(带排队位次) |
| `GET/POST/DELETE /api/tokens…` · `/validate` | token 池:扫码加、验证、轮换+故障转移 |
| `GET/PUT /api/config` | 收藏夹 / Notion / 调度配置(`/config` 页可视化) |
| `/api/sync/run`·`cancel`·`start`·`stop` · `GET /api/sync/status` · `/api/sync/runs[/:id]` | 自动同步:触发 / 取消 / 定时,实时状态,历史(逐条视频记录) |

## 转写来源

1. **字幕轨**(`is_subtitled=1`):直接拿。
2. **ASR**(无字幕):下视频 → 本地 `whisper`(默认 turbo)→ 转完删 mp4。需要 `ffmpeg` + `whisper`(或设 `WHISPER_BIN`)。

## Notion 自动同步

服务自带调度器:每轮扫收藏夹 → 对 Notion 里没有的 `videoId`(幂等)转写 → 写一页。配置/部署见 **`docs/deploy.md`**。本期不接 LLM,存原始稿;`Analyzer` 已留 seam,接 Claude API 即可清洗+摘要。

## 检查

```bash
npm test                 # node:test 套件:路由/轮换/failover/队列/config/字幕轨/Notion 导出(mock)/同步上限·取消·记录/FileSyncStore 等
npx tsc --noEmit         # 类型
npm run preflight        # 真实:验证 token + 扫一次收藏夹
```

## 边界

- 串行、一次一条(单浏览器 + 单 CPU/ASR)。多 token 多 worker 是后续。
- 会话过期 → 拦到 0 条会**大声失败**;token 池全失效则安静停同步,`/api/sync/status` 可见。
- 自动化访问踩抖音 ToS;低频自用风险低但非零。给别人/公网请加 `TOKEN=` 门禁。
- 旧的批量脚本 `src/{sync,discover}.ts`(SQLite 去重)仍保留,已被服务化流程取代。

## License

[MIT](LICENSE) © 2026 Xiaochen Nie

> ⚠️ 自动化访问抖音踩其 ToS;本工具仅供个人低频自用,风险自负。登录态、Notion token 等都只存本机,不上云。
