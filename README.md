# 此一时，彼一时

## 项目状态

**此一时，彼一时**是一款时间型知识阅读工具。它基于一个判断：问题的答案不是固定的，同一个问题在不同时空会得到不同解答。用户输入一个问题，系统先规划待验证的认知阶段，再为每个阶段发现检索线索，通过知乎官方接口定位帖子，最终生成可追溯的认知变化时间线。

当前链路：

```text
query
→ DeepSeek 规划 3—4 个待验证阶段
→ 本地轻量爬虫提取候选标题与 query hint
→ 知乎官方接口分阶段精准检索
→ 按 ContentID 去重、按热度辅助排序
→ DeepSeek 依据已验证帖子整理阶段变化
→ 前端展示时间线、帖子和局限
```

必须明确：当前知乎搜索单次最多返回 **10 条**，因此结果是 `sampled`，不能称为完整历史。

## 目录

```text
知乎黑客松2026/
├── .env.example        # 环境变量模板，无真实密钥
├── .env.local          # 本机密钥，不得提交或外传
├── .cache/             # 生成结果与热搜的本地缓存，运行时生成，不提交
├── .gitignore
├── core.mjs            # DS、爬虫、知乎检索、校验、总流程
├── server.mjs          # HTTP 服务和路由
├── index.html          # 输入、等待态、时间线和帖子页面
├── curation.html       # 策展交互原型（硬编码案例，待绑定原帖）
├── zhihu-logo.png      # 粒子背景采样用的知乎 logo
├── package.json
├── README.md           # 运行、接口和验证说明
└── 产品与技术方案.md    # 产品定义、架构和研发边界
```

## 环境配置

### 1. 准备运行环境

**Node.js 20.6 或更高版本**即可运行。项目只使用 Node.js 标准库，**不需要 `npm install`**。

```powershell
node --version
git --version
```

### 2. 克隆并创建本地配置

```powershell
git clone https://github.com/Guyue2203/zhihu2026.git
Set-Location zhihu2026
Copy-Item .env.example .env.local
```

**`.env.local` 只保存在本机**，已被 `.gitignore` 忽略，不得提交或发到群聊。

### 3. 填写 `.env.local`

| 变量 | 必填 | 作用 | 建议值或来源 |
|---|---:|---|---|
| `PORT` | 否 | 本地服务端口 | 默认 `3000` |
| `ZHIHU_ACCESS_SECRET` | Live 必填 | 知乎开放平台 Bearer 凭证 | [知乎开放平台个人中心](https://developer.zhihu.com/profile) |
| `ZHIHU_API_BASE_URL` | 是 | 知乎 API 根地址 | `https://developer.zhihu.com` |
| `ZHIHU_SEARCH_COUNT` | 否 | 每次知乎搜索数量 | `10`，官方接口上限为 10 |
| `ZHIHU_TIMEOUT_MS` | 否 | 知乎请求超时 | `30000` |
| `JOURNEY_CACHE_TTL_MS` | 否 | Live 生成结果本地缓存有效期 | `604800000`（7 天）；设为 `0` 停用缓存 |
| `DEEPSEEK_API_KEY` | Live 必填 | 时间线规划与总结 | DeepSeek 或队伍获得的兼容服务密钥 |
| `DEEPSEEK_BASE_URL` | 是 | Chat Completions 根地址 | 官方为 `https://api.deepseek.com`；补贴网关按提供方说明填写 |
| `DEEPSEEK_MODEL` | 是 | 调用的模型名 | 官方 DeepSeek 用 `deepseek-chat`；兼容网关使用其公布的模型名 |
| `DEEPSEEK_TIMEOUT_MS` | 否 | DeepSeek 请求超时 | `90000` |
| `CRAWLER_ENABLED` | 否 | 是否开启公开页线索发现 | `true` |
| `CRAWLER_TIMEOUT_MS` | 否 | 爬虫请求超时 | `8000` |
| `ZHIHU_HOT_LIMIT` | 否 | 首页热搜轮播条数 | `20`，官方接口上限为 30 |
| `HOT_CACHE_TTL_MS` | 否 | 知乎热搜本地缓存有效期 | `600000`（10 分钟）；设为 `0` 停用缓存 |

最小配置：

```dotenv
ZHIHU_ACCESS_SECRET=从知乎开放平台获取的Access-Secret
ZHIHU_API_BASE_URL=https://developer.zhihu.com
DEEPSEEK_API_KEY=你的DeepSeek或兼容网关密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

**`ZHIHU_ACCESS_SECRET` 不是 App ID、OAuth App Key、Cookie 或 DeepSeek 补贴 Token。** 健康检查中的 `configured.zhihu=true` 只表示变量非空；如果页面返回 `Authorization failed`，需在知乎开放平台重新生成或确认 Access Secret 权限。

## 快速启动

`npm start` 以 `node --watch` 运行：修改 `core.mjs`、`server.mjs` 时进程会自动重启；`index.html`、`curation.html` 每次请求都从磁盘读取，保存后**直接刷新浏览器**即可生效，无需重启服务。修改 `.env.local` 或 `package.json` 仍需手动重启。

页面字体使用 MiSans（知乎同款，通过 `unpkg.zhimg.com` 加载，CSP 已放行该来源）；离线时自动回退到系统字体，不影响功能。

启动：

```powershell
npm start
```

打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)。

若知乎返回 `Authorization failed`，表示 `ZHIHU_ACCESS_SECRET` 无效、过期或权限未开通，代码无法绕过官方鉴权。

## 接口

### 健康检查

```http
GET /api/v1/health
```

响应只说明密钥是否存在，不返回密钥内容：

```json
{
  "status": "ok",
  "configured": {
    "zhihu": true,
    "deepseek": true
  }
}
```

### 生成认知时间线

```http
POST /api/v1/journey
Content-Type: application/json
```

```json
{
  "query": "共享单车为什么失败？",
  "stagePreference": "default",
  "retrieval": "zhihu"
}
```

`stagePreference` 可选，控制生成结果的阶段数量，只接受三个值：

| 值 | 含义 |
|---|---|
| `default`（缺省同此） | 约 3 个阶段，模型按问题复杂度调整 |
| `fewer` | 在保持认知变化完整的前提下适当减少阶段数量 |
| `more` | 当确实存在认知转折时适当增加阶段数量（上限 6 个） |

`retrieval` 可选，控制信息来源，只接受两个值：

| 值 | 含义 |
|---|---|
| `zhihu`（缺省同此） | 检索知乎官方接口，结果绑定真实帖子 |
| `model` | 不检索知乎，时间线由模型知识整理（是否联网取决于模型通道能力），结果不含帖子证据，`coverage` 为 `model` |

`POST /api/search` 是兼容别名，新代码统一使用 `/api/v1/journey`。追加 `?refresh=1` 可绕过本地缓存强制重新生成（详见「生成结果本地缓存」）。

### 核心响应字段

| 字段 | 含义 |
|---|---|
| `query` | 规范化后的用户问题 |
| `title` | 时间线标题 |
| `thesis` | 认知转变主线 |
| `stages` | 按时间或认知顺序排列的阶段 |
| `crawlerStatus` | `ok`、`empty`、`timeout`、`http_error`、`fallback_query`、`disabled` |
| `crawlerQuery` | 本阶段实际送入知乎接口的首个 query |
| `crawlHitCount` | 爬虫提取到的候选数量 |
| `crawlerHttpStatus` / `crawlerErrorCode` | 抓取失败时的安全化诊断信息 |
| `postIds` | 本阶段引用的正式知乎帖子 ID |
| `posts` | 经过知乎接口确认的帖子 |
| `coverage` | `sampled` 或 `model`（未启用知乎检索） |
| `limitations` | 本次结果的证据边界 |

### 知乎热搜

```http
GET /api/v1/hot?limit=20
```

- 调用知乎官方热榜接口 `/api/v1/content/hot_list`，返回 `{ items, fetchedAt, fetchedAtIso, cached }`，每项含 `title`、`url`、`summary`、`thumbnailUrl`。
- 只接受 `https://zhihu.com` 及其子域名链接，与主流程同一条来源规则。
- 首页「想了解点什么？」右侧以轮播方式展示当前知乎热搜（同时显示 3 条，每 5.2 秒整体上移一条；窄屏堆叠到下方），左边缘与搜索框中点对齐，按钮样式与推荐问题一致；点击标题填入输入框，回车开始检索。
- 缓存命中时不消耗知乎 `hot_list` 额度；上游失败时前端隐藏该模块，不影响提问主流程。

### 等待页过渡文案

```http
POST /api/v1/prelude
Content-Type: application/json
```

```json
{
  "query": "共享单车为什么失败？"
}
```

- 主流程生成较慢时，前端并行调用此接口获取与问题相关的过渡文字。
- 先查生成结果缓存：命中说明等待极短，直接返回空 `prelude`，不调用 DeepSeek。
- DeepSeek 失败或输出为空时回退到模板文案，接口始终返回 200（输入不合法除外）。
- 请求体支持与主接口相同的 `stagePreference` 与 `retrieval`，用于判断对应变体是否已缓存。

## 生成结果本地缓存

每次成功生成的完整时间线结果都会写入本地 JSON 缓存，目录为 `.cache/journey/`（已被 `.gitignore` 忽略）：

- 缓存键为「规范化后的 query + 阶段偏好 + 来源模式」（`default` / `zhihu` 与缺省视为同一键）；命中时直接返回完整结果，不再调用 DeepSeek、爬虫或知乎接口，也不要求任何密钥存在。
- 缓存内容与接口响应使用同一 JSON 契约，可直接人工审阅；文件内含 `fetchedAt` / `fetchedAtIso` 便于核查生成时间。
- `JOURNEY_CACHE_TTL_MS` 控制有效期，默认 7 天；设为 `0` 停用缓存读写。
- 热搜另有独立缓存 `.cache/hot/list.json`（键为请求条数），由 `HOT_CACHE_TTL_MS` 控制，默认 10 分钟；同样使用「临时文件 + rename」原子写入，读写失败静默降级。
- 写入使用「临时文件 + rename」原子替换；缓存读写失败一律静默降级，不影响真实请求。
- 生成失败不写缓存，下次请求自动重试完整链路。
- `POST /api/v1/journey?refresh=1` 强制绕过缓存重新生成并更新缓存。
- 路演前可将核心 query 的缓存文件人工审核后另行归档，作为快照数据源。

## 当前爬虫如何工作

`crawlStage(stage)` 是本地轻量爬虫，不使用第三方包：

1. 读取 DeepSeek 阶段规划中的第一个 `searchQueries`。
2. 请求知乎公开搜索页。
3. 还原 HTML 中转义的 URL。
4. 提取嵌入式 JSON 中的 `title` / `name` 和知乎问题、回答链接。
5. 使用中文二元字组重合度衡量候选标题与阶段认知的相关性。
6. 生成最多两个 `queryHint`。
7. 将 `queryHint` 送入知乎官方搜索接口。
8. 爬虫为空或失败时，退回 DeepSeek 生成的 `searchQueries`。

爬虫只负责发现线索，不负责确认来源。最终标题、作者、摘要、互动量和链接必须来自知乎官方接口。爬虫状态只用于页面展示与诊断，**不进入 DeepSeek 总结的输入**；爬虫未成功的阶段由后端在 `limitations` 中追加固定降级说明，避免模型误读接口状态。

## 热度参考分

当前公式：

```text
heat = ln(1 + 赞同数) × 10
     + ln(1 + 评论数) × 6
     + RankingScore × 10
     + AuthorityLevel × 2
```

热度只用于候选排序，不能当作真实性或权威性的证明。

## 前后端必须对齐

| 项目 | 固定约定 |
|---|---|
| 主接口 | `POST /api/v1/journey` |
| 阶段偏好 | 可选字段 `stagePreference`：`default` / `fewer` / `more` |
| 来源模式 | 可选字段 `retrieval`：`zhihu`（默认，绑定原帖）/ `model`（仅模型知识） |
| 过渡文案 | `POST /api/v1/prelude`，可选；失败时前端保留默认等待文案 |
| 首页热搜 | `GET /api/v1/hot`，可选；失败时前端隐藏轮播，不阻塞提问 |
| 输入字段 | `query`，2—100 个字符 |
| 阶段主键 | `stage-1`、`stage-2` 等稳定 ID |
| 帖子关联 | `stages[].postIds` 引用 `posts[].id` |
| 时间语义 | `editedAt` 是发布或编辑时间，不能直接当事件时间 |
| 来源规则 | 页面只展示后端返回的知乎 HTTPS 链接 |
| 密钥规则 | 仅存在 `.env.local` 或部署环境，不进入前端 |
| 覆盖声明 | 当前只能返回 `sampled` 或 `model` |

## 验证

```powershell
npm test
node --check core.mjs
node --check server.mjs
```

热搜接口自检：

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/api/v1/hot?limit=5' | ConvertTo-Json -Depth 5
```

接口测试：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health | ConvertTo-Json
$body = @{ query = '共享单车为什么失败？' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3000/api/v1/journey -Method Post -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 8
```

## 错误处理

| 状态 | 错误码 | 含义 |
|---:|---|---|
| `400` | `INPUT_INVALID` | query 或 JSON 不合法 |
| `404` | `NO_RESULTS` / `NOT_FOUND` | 没有结果或接口不存在 |
| `413` | `INPUT_TOO_LARGE` | 请求体超过 4 KB |
| `502` | `ZHIHU_*` / `DEEPSEEK_*` | 外部服务失败或输出无效 |
| `503` | `CONFIG_MISSING` | 缺少密钥 |
| `500` | `CONFIG_INVALID` / `INTERNAL` | 配置或内部错误 |

## 权威文档

- [知乎数据开放平台](https://developer.zhihu.com/)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
