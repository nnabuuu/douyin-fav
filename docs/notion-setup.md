# 配置 Notion(token + 数据库)

自动同步要往你的 Notion 数据库写页面,需要两样东西填进 `/config`(或 `/setup`):

- **Integration token**(集成密钥,形如 `ntn_xxx` 或 `secret_xxx`)
- **Database ID**(目标数据库 id,一段 32 位十六进制)

下面一步步来。⚠️ 第 3 步最容易漏。

---

## 1. 建 Notion integration,拿 token

1. 打开 https://www.notion.so/my-integrations
2. **+ New integration** → 起个名(如 `douyin-fav`)→ 选你的 workspace → 提交
3. 在 integration 页找到 **Internal Integration Secret** → **复制**。这就是 token。

> 这是密钥:别外发、别提交进公开仓库。本工具只把它存在你本机 `~/.douyin-sync/config.json`,不上云。

## 2. 准备数据库 + 拿 Database ID

可以用现成的库(比如 `npm run setup` 阶段帮你建的「抖音收藏字幕」),或自己新建一个 Notion **数据库(database,整页表格)**。

**数据库需要这些属性(列),名字要一致**:

| 属性名 | 类型 |
|---|---|
| `Name` | 标题 Title |
| `videoId` | 文本 Text |
| `author` | 文本 Text |
| `url` | URL |
| `platform` | 单选 Select |
| `source` | 单选 Select |
| `date` | 日期 Date |

**Database ID 怎么找**:把这个数据库当作整页打开,看地址栏——

```
https://www.notion.so/<workspace>/<32位十六进制>?v=<视图id>
                                  └──── 这段就是 Database ID ────┘
```

例:`…/me/c3be64840d2f435ebe8f90ff137a9830?v=abc` → id 是 `c3be64840d2f435ebe8f90ff137a9830`(带不带连字符都可)。

## 3. 把数据库共享给 integration(最容易漏!)

token 对、id 对,但**没共享**也写不进去——会报 `object_not_found / 找不到库`。

1. 打开目标数据库页面
2. 右上角 **···** → **Connections / 连接**
3. 搜你刚建的 integration(如 `douyin-fav`)→ 加上

刚建的数据库默认**不**对任何 integration 开放,必须手动加这一步。

## 4. 填进去测试

打开 `http://localhost:8787/config`(或 `/setup` 的 Notion 区):

- **Notion token** 填第 1 步的 secret
- **Database ID** 填第 2 步的 id
- 点 **保存并测试** → 变「已连接 ✓」就成了。

## 排错

| 现象 | 原因 / 解法 |
|---|---|
| 测试失败,detail 含 `object_not_found` / `找不到库` / `shared with your integration` | **第 3 步没做**:去把库 `···` → Connections 加上 integration |
| `unauthorized` / 401 | token 错或失效:回 my-integrations 重新复制 |
| 写入报缺属性 | 数据库少了上表某个属性,补上(名字要一致) |
| 一直 `skipped`、库里不增 | token 或 databaseId 没填(`/config` 里确认非空) |

> 不填 Notion 也能用:同步照常转写、存本机缓存,只是不写 Notion。
