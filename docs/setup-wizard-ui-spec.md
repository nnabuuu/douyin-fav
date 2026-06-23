# /setup 安装向导界面 — 功能描述(给 Claude Design)

> **先读 `docs/project-overview.md`** —— 产品是什么、用户是谁、整体流程、架构铁律、术语表。下面只写这个界面专属的内容。

后端**已就绪**,`/setup` 已有一个能用的朴素版。本文档让你**重做/美化前端**:一个一步步引导用户装好依赖、登录、连 Notion、开启同步的 onboarding 向导。纯静态页 + 调后端 JSON API,不要自己实现任何检测/安装/抓取逻辑——后端全做好了。

## 项目背景(精简,完整见 project-overview.md)

- **产品**:本地自托管工具,把用户**抖音收藏夹**里的视频转成文字稿、自动同步进 **Notion**(有字幕取字幕,没有用本地 whisper 语音识别)。
- **这个界面在整条流程的哪一步**:**首次上手的第一关**。用户刚 `npm install && npm run serve` 起了本机服务,打开 `/setup`,要被一步步带到「全部就绪、能自动同步」。这是从 0 到能用的关口——**卡在任何一步都会流失**,所以向导体验直接决定成败。
- **架构铁律(直接影响设计)**:网页只是薄壳,**真正干活的是本机服务**。检测/安装依赖、扫码登录、写 Notion 都由服务在宿主机执行。两个后果:① **扫码登录是宿主机弹出的 Chrome 窗口**里完成的,网页只发起 + 轮询,**不在网页里渲染二维码**;② 依赖安装是**分钟级异步任务**,必须有 loading + 失败日志。
- **用户**:在自己电脑(Mac/Win/Linux 桌面)跑,半技术(会跑命令、但想在网页点)。中文界面。
- **隐私是卖点**:登录态、Notion token 全留本机,不上云,可在 UI 体现「本地/私有」。

## 和 token 管理界面的关系

同一个产品,**视觉语言必须一致**(见 `docs/token-admin-ui-spec.md`)。向导里的「② 抖音登录」和那个 token 管理是同一套 token API,可复用组件。两份界面会一起做,统一风格。

## 后端 API(已实现,直接调)

同源。若服务端设了 `TOKEN` 环境变量,所有 `/api/*` 需带 `?token=<秘钥>`(从 URL query 读一次,后续请求都带上)。

### 检测 + 安装

| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/setup/status` | 一次性返回所有检测结果 | 见下 |
| POST | `/api/setup/install/chromium` | 服务端跑 `playwright install chromium`(可能几十秒) | `{ok, log}` |
| POST | `/api/setup/install/whisper` | 服务端尽力 `pip install -U openai-whisper` | `{ok, log}` |

`GET /api/setup/status` 返回:
```ts
{
  node:     { ok: boolean, detail: string, fixHint?: string },
  chromium: { ok: boolean, detail: string, canInstall?: boolean },
  ffmpeg:   { ok: boolean, detail: string, fixHint?: string },   // 给复制命令,不自动装
  whisper:  { ok: boolean, detail: string, canInstall?: boolean, fixHint?: string },
  tokens:   { ok: boolean, detail: string, count: number },
  notion:   { ok: boolean, detail: string },                     // ok=真去查了库,连通才 true
  folders:  string[],
  schedule: { enabled: boolean, intervalMin: number, perRun: number }
}
```
- `ok` → 绿;`canInstall` → 显示「安装」按钮;`fixHint` → 显示可复制的命令。
- 任何动作后都可重新 GET 一次刷新整页。

### 登录 token(复用)
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tokens` | body `{}`,后台弹出浏览器扫码,返回 `{id, status:"logging_in"}` |
| GET | `/api/tokens/:id` | 轮询,`status` 变 `valid`/`invalid` |

### Notion + 收藏夹 + 定时(复用 config / sync)
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 取当前配置(prefill databaseId 用) |
| PUT | `/api/config` | body 只传要改的,如 `{notion:{token,databaseId}}`——**别传空字段,会覆盖** |
| POST | `/api/sync/start` | 开启定时同步 |
| POST | `/api/sync/run` | 立即跑一轮 |
| GET | `/api/sync/status` | 看进度 |

## 界面要做的(5 步,清单式,可任意顺序但有逻辑先后)

顶部:**进度感**(如「4 / 6 就绪」环形或进度条);全绿时一条成功横幅 +「立即同步一轮」主按钮。

### ① 环境依赖
四行:Node / Chromium / ffmpeg / whisper,每行一个状态徽标 + detail。
- **Chromium**:`canInstall` 时显示 **[安装]**;点了 → POST install,**按钮转圈 + 进度提示**(请求可能跑几十秒,期间别让用户以为卡死),完成后刷新该行;失败展示 `{log}`(可折叠的终端样式)。
- **whisper**:同上 [尝试安装];另外始终显示 `fixHint`(pip 命令)兜底。
- **ffmpeg**:不自动装,显示 `fixHint` 命令(**一键复制**)+ [重新检测]。
- 每行都该有 [重新检测](重新 GET status)。

### ② 抖音登录(扫码)
显示 `tokens.detail`(如「1 个有效」)。**[+ 扫码加 token]** → POST `/api/tokens` → 提示「请在本机弹出的 Chrome 窗口里扫码」(扫码发生在宿主机窗口,**不在网页内**)→ 轮询 `GET /api/tokens/:id`(每 2–3s)直到 `valid`/`invalid`/超时(~4 分钟),成功刷新整页。

### ③ Notion
显示 `notion.detail`。两个输入:`token`(password)、`databaseId`(从 `/api/config` 预填)。**[保存并测试]** → PUT `/api/config`(只传非空字段)→ 测连通(`POST /api/notion/test` 或刷新 status 读 `notion.ok`;后端真去查库,绿了才算连上)。

**引导要做成可勾选的 3 步,别压成一行——第 ② 步是最高频踩坑点:**
1. 在 [notion.so/my-integrations](https://www.notion.so/my-integrations) 新建 integration,复制 Internal Secret。
2. **打开目标库 → 右上 `···` → Connections → 把该 integration 加上(= 把库共享给它)。** 这步最容易漏。
3. 把 secret 和库 ID 填上、保存并测试。

**失败态文案要点准坑**:测试若 `notion.ok=false` 且 detail 含「找不到库 / object_not_found / shared with your integration」,**几乎一定是第 ② 步没做**(刚建的库默认没共享给任何 integration,token 再对也 404)。UI 应直接提示「去把库共享给 integration」并高亮第 ② 步,而不是只说「连接失败」。

### ④ 收藏夹与定时
显示 `folders`(列表)和 `schedule`(开/关 · 每 N 分钟 · 每轮 M 条)。**[开启定时]** → POST `/api/sync/start`。收藏夹/节奏的细编辑跳去 `/config`(可只放个链接)。

### ⑤ 完成
**[立即同步一轮]** → POST `/api/sync/run`,提示「已触发,去 /config 看状态」。全绿时这步最突出。

## 状态语义(给文案)
- ✅ ok=true:这项就绪。
- ❌/⚠️ ok=false:`canInstall` → 能一键装;`fixHint` → 给命令自己装;都没有(如 notion)→ 去对应步骤填。
- 安装是**异步长任务**:务必有明确 loading,别让用户误以为卡住;失败把 `log` 给出来。

## 设计提示
- 这是**首次上手向导**,要有「在推进」的成就感:进度指示、逐项变绿、完成庆祝。
- 卡片/清单式;每步一个清晰主按钮。命令用等宽 + 一键复制。
- 实时:任何操作后重拉 status,UI 跟着变。
- 中文界面。深色模式加分。可参考 Pinokio / Stability Matrix / 典型 SaaS onboarding checklist。

## 不在范围
- 不在网页里渲染二维码(扫码在宿主机 Chrome 窗口,网页只轮询状态)。
- 不碰系统命令/文件——全走后端 API。
- 开场的 `npm install && npm run serve` 是命令行做的(没服务就没这页),向导不需要处理「服务未安装」。
