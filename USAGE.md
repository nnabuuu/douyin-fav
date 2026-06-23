# 使用说明

抖音视频转文字稿。三种用法,按需挑。给别人自部署看 `docs/deploy.md`;这份是给你自己用的。

---

## 0. 一次性准备

```bash
npm install
npm run setup          # 装 Chromium + 写默认配置 + 打印指引
```
无字幕的视频要本地转写,需要 `ffmpeg` 和 `whisper`:
- `ffmpeg`:`brew install ffmpeg`
- `whisper`:你已装在 `~/miniconda3/bin/whisper`。若命令跑起来报「whisper 起不来」,在命令前加 `WHISPER_BIN=~/miniconda3/bin/whisper`,或把 miniconda 加进 PATH。

---

## 1. 单条:拿一个视频的字幕

```bash
npm run one "https://www.douyin.com/video/7650129245314316009"
# 链接随便哪种都行:/video/、?modal_id=、v.douyin.com 短链、或纯数字 id
```
结果存到 `workspace/douyin/<id>/`:
- `transcript.md` — 文案 + 口播逐字稿(最终)
- `detail.json` / `v.txt` — 中间产物
有字幕轨直接取;没有就下视频本地 whisper 转(几分钟),转完自动删 mp4。**转过的再跑秒回**(缓存)。

---

## 2. 服务:网页里贴链接拿字幕(也能给别人用)

```bash
npm run serve          # → http://localhost:8787
```
浏览器打开 `http://localhost:8787`,是「即见」本地界面(提取字幕 / `/config` 自动同步 / `/tokens` Token 管理 / `/setup` 安装向导)。贴链接、回车,转过的秒回,新视频排队转(页面显示「第几位」)。

> 前端 React + 字体都 vendor 在本地(`frontend/vendor/`),**无 CDN 依赖、可完全离线**。

- 同网段别人也能用你这台:`http://<你的IP>:8787`。
- 想加门禁:`TOKEN=随便一串 npm run serve`,别人用 `http://...:8787/?token=随便一串`。
- 换端口:`PORT=9000 npm run serve`。

---

## 3. 自动同步:收藏夹 → Notion(每小时自动)

服务自带定时器,不需要开着 Claude。先做一次性 Notion 接线(**2 分钟,只有你能做**):

1. 去 https://www.notion.so/my-integrations → 新建 integration → 复制 **Internal Integration Secret**。
2. 打开你的库 → 右上 `···` → **Connections** → 加上刚建的 integration(把库共享给它,否则没权限写)。
   你的库已建好:https://app.notion.com/p/c3be64840d2f435ebe8f90ff137a9830
3. 打开 `http://localhost:8787/config`:
   - `notion.token` 填那个 Secret
   - `notion.databaseId` 已预填好(就是上面那个库)
   - `folders` 默认是你的主收藏夹,可加多个
   - `schedule.enabled` 设 `true`
   - 点**保存**

然后:
- 点**「立即同步一轮」**先验证(或 `curl -X POST localhost:8787/api/sync/run`)
- 点**「查看状态」**看进度(`GET /api/sync/status`)
- 开了 `enabled` 后,服务每 `intervalMin`(默认 60)分钟自动跑,每轮最多 `perRun`(默认 10)条新视频。

> 没填 Notion token 也能用:照常转写存本地,只是不写 Notion。

**想让它整夜/长期跑**:让服务常驻 + 别让 Mac 睡:
```bash
caffeinate -dimsu npm run serve
```

---

## 4. token 池(登录态)

抓取要登录态。一个 token = 一次扫码登录的浏览器档案,池子可放多个(自动轮换,失效自动跳过)。你现有的登录已作为 `legacy` token 在池里。

- 看池子:`curl localhost:8787/api/tokens`
- 加一个(扫码):`curl -X POST localhost:8787/api/tokens` → 在弹出的 Chrome 窗口扫码 → 轮询 `curl localhost:8787/api/tokens/<id>` 到 `valid`
- 重新验证某个:`curl -X POST localhost:8787/api/tokens/<id>/validate`
- 删除:`curl -X DELETE localhost:8787/api/tokens/<id>`

(一个好看的 token 管理界面在 `docs/token-admin-ui-spec.md`,可丢给 Claude Design 做。)

---

## 5. 检查 / 排障

```bash
npm test               # 纯逻辑自测(秒级,不碰网络)
npm run preflight      # 真实:验证 token + 扫一次收藏夹
```

| 症状 | 多半是 | 解决 |
|---|---|---|
| 同步 0 条 / token `invalid` | 掉登录或风控 | 重新扫码加 token(第 4 节) |
| Notion 一直 `skipped` 不写 | 没填 token 或没把库共享给 integration | 检查第 3 节第 1–2 步 |
| 「whisper 起不来」 | 不在 PATH | `WHISPER_BIN=~/miniconda3/bin/whisper npm run …` |
| 想看库链接/配置 | — | `http://localhost:8787/config` |

---

## 常用环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` / `HOST` | 服务端口 / 绑定 | 8787 / 0.0.0.0 |
| `TOKEN` | 给 `/api/*` 加门禁 | 无 |
| `WHISPER_MODEL` | whisper 模型 | turbo(嫌慢用 small) |
| `WHISPER_BIN` | whisper 可执行路径 | whisper(取 PATH) |
