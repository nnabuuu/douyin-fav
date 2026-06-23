# Token 管理界面 — 功能描述(给 Claude Design）

> **先读 `docs/project-overview.md`** —— 产品是什么、用户是谁、整体流程、架构铁律、术语表。下面只写这个界面专属的内容。

本地自托管服务的**后端已就绪**。本文档描述要做的**前端界面**:管理抖音(后续含 bilibili)登录态 token 池。前端是纯静态页 + 调后端 JSON API,不需要自己实现任何抓取逻辑。

## 项目背景(精简,完整见 project-overview.md)

- **产品**:本地自托管工具,把用户抖音收藏夹的视频转成文字稿、自动同步进 Notion。抓取需要登录态,这个界面管的就是登录态。
- **这个界面在哪一步**:抓取要用抖音登录态;一个 **token = 一次扫码登录的浏览器档案**(不是 API key)。服务从池里**轮换**用、失效自动**故障转移**。本界面让用户管这个池子。
- **架构铁律(影响设计)**:网页是薄壳,真正干活的是本机服务;**扫码登录在宿主机弹出的 Chrome 窗口里完成,网页不渲染二维码**,只发起 + 轮询 token 状态。
- **用户/语气**:自己电脑上跑、半技术、中文;运维面板,清晰 > 花哨。
- **和 `/setup` 向导同产品**,视觉风格要统一(见 `docs/setup-wizard-ui-spec.md`),两份会一起做。

## 这个界面要做什么(概述)

让用户:看池子里有哪些 token、各自是否有效/属于哪个账号、加新 token(扫码)、手动验证、删除。

## 后端 API(已实现,直接调)

Base URL 同源。若服务端设了 `TOKEN` 环境变量,所有 `/api/*` 需带 `?token=<秘钥>`(界面可在 localStorage 存一次)。

### Token 池

| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/tokens` | 列出全部 token | `Token[]` |
| GET | `/api/tokens/:id` | 单个 token | `Token` 或 404 |
| POST | `/api/tokens` | 新增 token,**后台起扫码登录**。body `{platform?: "douyin", label?: string}` | `Token`(status=`logging_in`) |
| POST | `/api/tokens/:id/validate` | 重新验证(开浏览器探测) | 更新后的 `Token` |
| DELETE | `/api/tokens/:id` | 删除 | `{ok: boolean}` |

### Token 数据结构

```ts
type TokenStatus = "valid" | "invalid" | "unknown" | "logging_in";
interface Token {
  id: string;
  platform: "douyin" | "bilibili";
  label: string;
  status: TokenStatus;
  account?: { nickname?: string; uid?: string }; // 验证/登录成功后才有
  createdAt: string;        // ISO
  lastValidatedAt?: string; // ISO
  lastUsedAt?: string;      // ISO
  failureCount: number;
  profileDir: string;       // 本地路径,可不展示
}
```

### 字幕任务(顺带,界面可选做一个测试框)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/jobs` | body `{url}`,返回 `{id, status}` |
| GET | `/api/jobs/:id` | 轮询;返回 `{status, position?, ahead?, log[], result?, error?}` |

`status`: `queued`(带 `position` 第几位 / `ahead` 前面几个)→ `running` → `done`(带 `result`)/ `error`。`result` 形如 `{platform, videoId, title, desc, transcript, source: "subtitle"|"asr", cached}`。

## 界面要做的

### 1. Token 池列表(主屏)

每个 token 一张卡 / 一行,展示:

- **状态徽标**:`valid` 绿、`invalid` 红、`unknown` 灰、`logging_in` 蓝+转圈。
- **账号**:`account.nickname`(大),`uid`(小灰)。没有账号信息时显示 `—`。
- **平台**:抖音 / bilibili 图标或文字。
- **label**:可点击重命名(前端可暂存,后端暂无改名接口 → 可省略或后续加)。
- **时间**:`lastValidatedAt`(相对时间,如"3 分钟前验证")、`lastUsedAt`。
- **failureCount > 0** 时给个小警告。
- 行内操作:**验证**(POST validate,按钮转圈,完成后刷新该行)、**删除**(确认后 DELETE)。

顶部:**+ 添加 token** 按钮;一个全局"刷新"(重拉 GET /api/tokens)。

### 2. 添加 Token 流程(关键)

点 "+ 添加 token":

1. 选平台(默认抖音),可填 label。
2. 调 `POST /api/tokens` → 拿到一个 `status: "logging_in"` 的 token。
3. 弹窗提示:**"请在本机弹出的 Chrome 窗口里扫码登录"**(扫码发生在跑服务那台机器的浏览器窗口里,不在网页内)。
4. 前端开始**轮询 `GET /api/tokens/:id`**(每 2-3 秒),展示"等待扫码…"。
5. 当 `status` 变 `valid` → 显示成功 + 账号昵称,关弹窗,刷新列表。
   变 `invalid`(超时/失败)→ 提示重试。
6. 登录有 ~3 分钟超时。弹窗里给个"取消"(前端停止轮询即可;token 会留在池里为 invalid,可删)。

### 3. 状态语义(给文案用)

- `valid` — 已登录、可用,正在参与轮换。
- `invalid` — 失效(掉登录/被风控),自动跳过。建议删了重加。
- `unknown` — 还没验证过(如导入的既有登录)。建议点一次"验证"。
- `logging_in` — 正在等扫码。

### 4. 空状态

池子空时:引导"添加第一个 token(扫码登录抖音)"。

## 设计提示

- 这是**自用运维面板**,清晰 > 花哨。卡片式或表格都行,深色模式加分。
- 状态是第一信息,要一眼看清哪些 token 还活着。
- 轮询时有明确 loading,不要让用户以为卡住。
- 中文界面。

## 不在范围

- 不做扫码二维码渲染(扫码在宿主机的 Chrome 窗口,网页只轮询状态)。
- 不做账号密码登录、不碰 cookie 明文(后端只存档案路径,cookie 在本地档案目录里)。
- bilibili 后端是占位,前端把它当作"可选平台"留着即可。
