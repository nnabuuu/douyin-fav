# /config 配置界面 — 功能描述(给 Claude Design)

> **先读 `docs/project-overview.md`** —— 产品是什么、用户是谁、整体流程、架构铁律、术语表。下面只写这个界面专属的内容。

后端**已就绪**,`/config` 目前是个**朴素的 JSON 文本框 + 几个按钮**。本文档让你**重做成像样的设置页**:分组表单 + 一个同步控制/状态面板。纯静态页 + 调后端 JSON API。

## 项目背景(精简,完整见 project-overview.md)

- **产品**:本地自托管工具,把用户**抖音收藏夹**的视频转成文字稿、自动同步进 **Notion**。
- **这个界面在哪一步**:装好、登录、连上之后的**日常设置中枢**。用户在这里:配要监控的收藏夹、填/改 Notion、调同步节奏(多久一次、每轮几条)、开关自动同步、手动触发一轮、看上一轮结果。
- **架构铁律(影响设计)**:网页是薄壳,**服务自带定时器在后台跑同步**(不依赖网页开着)。所以这页是「改配置 + 看/控同步」,真正的同步在服务里发生;改完配置即时生效(服务下一轮读新值)。
- **用户/语气**:自己电脑上跑、半技术、中文;运维设置面板,清晰 > 花哨。
- **同产品**:和 `/setup`、token 管理同一套视觉(见对应 spec),`/setup` 里也有「Notion」「收藏夹与定时」的简化版,组件可共用。

## 后端 API(已实现,直接调)

同源。若服务端设了 `TOKEN` 环境变量,所有 `/api/*` 需带 `?token=<秘钥>`。

### 配置读写
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 取当前完整配置 |
| PUT | `/api/config` | body 传**要改的部分**,返回合并后的完整配置 |

配置结构(`GET` 返回 / `PUT` 接受其子集):
```ts
{
  folders: string[],                 // 要监控的收藏夹 URL,可多个
  notion: { token: string, databaseId: string },
  schedule: { enabled: boolean, intervalMin: number, perRun: number },
  asr: { model: string }             // whisper 模型,如 "turbo" / "small" / "medium"
}
```
**合并规则(重要)**:`notion` / `schedule` / `asr` 是**按字段浅合并**——只传 `{schedule:{intervalMin:30}}` 不会动 `enabled`/`perRun`。`folders` 是**整数组替换**——传了就整体覆盖。所以**别传空字段**(尤其 `notion.token`,空字符串会清掉已存的)。

### 同步控制 + 状态
| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/sync/status` | 当前状态 + 上一轮结果 | 见下 |
| POST | `/api/sync/run` | 立即跑一轮(后台异步) | `{started:true}` |
| POST | `/api/sync/start` | 开启定时器(立即生效) | status |
| POST | `/api/sync/stop` | 停止定时器 | status |

`GET /api/sync/status` 返回:
```ts
{
  running: boolean,        // 正在跑一轮
  scheduled: boolean,      // 定时器开着(内存态)
  enabled: boolean,        // 配置里的开关(持久,重启后是否自动开)
  intervalMin: number, perRun: number,
  last: null | { at: string, synced: number, skipped: number, failed: number, errors: string[] }
}
```

## 界面要做的

分组卡片;每组可独立保存(或全局保存 + 脏标记)。建议从上到下:

### 1. 同步控制面板(放最上,最常看)
- **自动同步主开关**:一个醒目的 toggle。开/关时**同时**:`PUT /api/config {schedule:{enabled}}` **且** `POST /api/sync/start`(或 `stop`)。(后端 `enabled`=持久、`start/stop`=当前内存,要一起动 UI 才直观。)
- **状态**:`running`(转圈)、`scheduled`、下次大致时间(`enabled?` 每 `intervalMin` 分钟)。
- **[立即同步一轮]** → `POST /api/sync/run`;之后轮询 `GET /api/sync/status` 显示进度。
- **上一轮结果**(`last`):时间、`synced` 新增 / `skipped` 跳过 / `failed` 失败的计数;`errors[]` 用可折叠列表展示(每条是一个 videoId+原因)。空(`null`)时显示「还没跑过」。

### 2. 收藏夹(folders)
- 一个**列表编辑器**:每行一个收藏夹 URL,可增、删、改。
- 校验像抖音 URL(含 `douyin.com`);默认有主收藏夹那条。
- 提示:可加多个收藏夹;改完下一轮生效。

### 3. Notion
- `token`(password 输入)+ `databaseId`。**从 `GET /api/config` 预填**(回填后保存即幂等,不会清空)。
- [保存并测试]:先 `PUT /api/config`(只传非空字段),再 **`POST /api/notion/test`** → `{ok, detail}` 直接显示连通结果(绿 ✓ / 红 + detail)。
- 引导文案做成 3 步,**第 ② 步最容易漏**:① notion.so/my-integrations 建 integration、复制 secret;② **目标库 ··· → Connections → 把该 integration 加上(共享给它)**;③ 填 token + 库 ID。
- **失败态点准坑**:`notion/test` 返回的 detail 含「找不到库 / object_not_found / shared with your integration」时,几乎一定是第 ② 步没做(刚建的库默认不共享,token 再对也 404)。直接提示「去把库共享给 integration」。
- **提示**:不填 Notion token,同步照常转写存本地,只是**不写 Notion**。

### 4. 调度细项
- `intervalMin`:数字,分钟(≥1)。
- `perRun`:数字(≥1)。**语义**:每轮最多**新转写**几条(已转过的命中缓存不算,不耗预算)——给个 tooltip,别让用户以为是「每轮只同步 N 条」。
- (主开关在面板 1,这里只放两个数值。)

### 5. ASR
- `asr.model`:下拉(`tiny` / `base` / `small` / `medium` / `large` / `turbo`)。说明:越大越准越慢;默认 `turbo`。
- 备注:`whisper` 可执行路径和 `WHISPER_MODEL` 可用环境变量覆盖,不在本页(只读提示即可)。

## 行为 / 边界
- **改完即时生效**:服务下一轮读最新 config,无需重启。
- **别用空值覆盖**:保存时只发用户实际填的字段(或把 GET 回来的值整体回填再发)。
- **脏状态**:有未保存改动时提示;保存成功用 PUT 返回的合并结果回填,确认一致。
- **轮询节制**:在本页时每 2–3s 拉一次 `sync/status` 即可,离开停掉。
- `?token=` 门禁:URL 带了就所有请求都带上。

## 状态语义
- `enabled` vs `scheduled`:前者是「重启后是否自动开」(持久),后者是「现在定时器开着吗」(内存)。正常两者一致;主开关应让它们一致。
- `running`:正在跑一轮,此时再点「立即同步」后端会拒绝(上一轮没结束),UI 应禁用按钮。

## 设计提示
- 这是**设置 + 运维面板**:信息密度可以高一点,但分组清晰、主操作明确。
- 同步面板要有「活着在跑」的实时感(状态、上一轮、错误)。
- 和 `/setup`、token 管理统一视觉;Notion/收藏夹 区块可复用 setup 的组件。
- 中文界面,深色加分。

## 不在范围
- 不实现任何同步/转写/写 Notion 逻辑——全在后端,本页只读写 config + 控制/观察 sync。
- 不在网页里渲染二维码、不碰文件/命令(见 project-overview 架构铁律)。
- 收藏夹「扫码登录态」属于 token 管理界面,不在本页。
