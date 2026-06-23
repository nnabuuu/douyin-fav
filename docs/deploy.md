# 自部署:抖音收藏 → Notion 自动同步

本地常驻一个服务,每隔一段时间扫描你的抖音收藏夹、转写新视频的字幕/口播、写入你的 Notion 数据库。**运行期不依赖 Claude Code**——服务自己跑。

## 前置

- Node ≥ 18(内置 `fetch`)、`git`
- 本机能跑浏览器(macOS/Windows/Linux 桌面)。无字幕的视频走本地 ASR,需要 `ffmpeg` + `whisper`(openai-whisper CLI):
  - `brew install ffmpeg`(或对应系统包管理器)
  - `pip install -U openai-whisper`(或设 `WHISPER_BIN` 指向你的 whisper)

## 一次性安装

```bash
npm install
npm run setup          # 装 Chromium + 写默认配置 + 打印后续步骤
```

## 1. 启动服务

```bash
npm run serve          # http://localhost:8787 , 配置页 /config
```
> 让它常驻。要后台长跑用 `pm2`/`launchd`/`systemd`;macOS 防睡眠可 `caffeinate -dimsu npm run serve`。
>
> 端口/绑定/门禁都用环境变量改:`PORT=9000`(默认 8787)、`HOST=127.0.0.1`(默认 `0.0.0.0` 同网段可达;设 `127.0.0.1` 只本机)、`TOKEN=随便一串`(设了 `/api/*` 都要带 `?token=…`)。例:`PORT=9000 TOKEN=abc npm run serve`。

## 2. 加抖音 token(扫码登录)

token = 一个独立扫码登录的浏览器档案,池子可放多个(轮换 + 失效自动转移)。

- 新增:`curl -X POST localhost:8787/api/tokens`(返回一个 `logging_in` 的 token)→ 在弹出的 Chrome 窗口扫码 → 轮询 `GET /api/tokens/<id>` 直到 `valid`。
- 或 CLI 旧法:`npm run login`。
- 查看池子:`GET /api/tokens`。

## 3. 连 Notion

1. 去 https://www.notion.so/my-integrations 新建一个 **internal integration**,复制 **Internal Integration Secret**(即 token)。
2. 打开你的目标数据库页面 → 右上 `···` → **Connections** → 添加该 integration(等于把库共享给它,否则 API 无权写)。
3. 数据库需要这些属性(`npm run setup` 提到的库已自带):
   `Name`(标题)、`videoId`(文本)、`author`(文本)、`url`(URL)、`platform`(单选)、`source`(单选)、`date`(日期)。
4. 打开 http://localhost:8787/config,填:
   - `notion.token`:上面的 secret
   - `notion.databaseId`:目标库 id(库 URL 里那段 32 位十六进制)
   - 保存。

> 不填 token 也能跑:服务照常转写+本地缓存,只是不写 Notion(`skipped`)。

## 4. 配收藏夹 + 开启定时

在 `/config`:
- `folders`:收藏夹 URL 列表(默认主收藏夹,可加多个)
- `schedule.intervalMin`:间隔分钟(默认 60)
- `schedule.perRun`:每轮最多新转写几条(默认 10,控风控)
- `schedule.enabled`:设 `true` 开启定时(或点页面“开启定时”)

手动跑一轮:`POST /api/sync/run`;看状态:`GET /api/sync/status`。

## 工作方式

每轮:对每个收藏夹用一个 valid token 扫列表 → 对 Notion 里还没有的 `videoId`(幂等)→ 有字幕轨用字幕、没有就下视频本地 whisper 转写 → 写一页到 Notion。失败的单条跳过不影响整轮;token 失效自动换池里下一个。

## 已知边界

- 串行、一次一条(单浏览器 + 单 CPU/ASR)。要快就多 token 多 worker——后续。
- 本期**不做 LLM 清洗**:存原始逐字稿(ASR 可能有错字)。`Analyzer` 已留 seam,接 Claude API 即可清洗+摘要。
- 自动化访问踩抖音 ToS;低频自用风险低但非零。token 全失效会安静停同步,`/api/sync/status` 可见。
- `bilibili` 适配器是占位(URL 路由已就绪)。
