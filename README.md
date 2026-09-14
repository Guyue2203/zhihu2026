# 此刻彼时

## 项目状态

**此刻彼时**是一款时间型知识阅读工具。它追踪的不是事实年表，而是知乎语境中“一个问题的答案怎样失效、转向或被重写”。输入先经过语义准入；合格问题由模型规划完整认知骨架，再以帖子验证，最终生成可追溯的认知变化时间线。

当前链路：

```text
query
→ 语义准入：接受 / 要求选择方向 / 拒绝
├─ Live：DeepSeek 规划 2—8 个 core/detail 阶段 → 轻量爬虫发现 query hint
│        → 知乎官方接口检索/去重/排序 → DeepSeek 依据帖子整理
└─ Static：外部浏览器按时间严格检索 → 人工核验元数据
          → 离线硬筛选/推荐排序 → 预生成静态 JSON
→ 前端展示时间线、帖子和局限
```

必须明确：当前知乎搜索单次最多返回 **10 条**，因此结果是 `sampled`，不能称为完整历史。

## 目录

```text
知乎黑客松2026/
├── .env.example        # 环境变量模板，无真实密钥
├── .env.local          # 本机密钥，不得提交或外传
├── .data/              # SQLite 数据库，运行时生成，不提交
├── .cache/             # 改造前的 JSON 缓存；首次启动自动导入 SQLite，之后不再写入
├── .gitignore
├── db.mjs              # SQLite：缓存、永久时间线记录、用户、会话、检索历史
├── oauth.mjs           # 知乎 OAuth：state 校验、换取 token、用户信息、会话 Cookie
├── core.mjs            # DS、爬虫、知乎检索、校验、总流程
├── server.mjs          # HTTP 服务、路由与认证
├── index.html          # 输入、等待态、时间线、帖子和登录控件
├── curation.html       # 静态策展页；优先读取构建产物，无产物时显示待核验样稿
├── offline-pool.mjs    # 外部搜索页预选、硬校验、推荐排序、静态 JSON 构建
├── static/             # 离线策展说明与构建后的 journeys/*.json
├── zhihu-logo.png      # 粒子背景采样用的知乎 logo
├── test.mjs            # 持久层与 OAuth 自检（mock，不访问外网）
├── e2e.mjs             # 端到端：mock OAuth + 独立实例，覆盖登录全链路
├── dev-auth.mjs        # 本地个人中心开发：交互式 mock OAuth 与用户数据
├── deploy/             # 部署模板：nginx 反代配置与 systemd 服务单元
├── package.json
├── README.md           # 运行、接口和验证说明
└── 产品与技术方案.md    # 产品定义、架构和研发边界
```

## 环境配置

### 1. 准备运行环境

**Node.js 24 或更高版本**。项目只使用 Node.js 标准库，**不需要 `npm install`**。

缓存与用户数据存放在 SQLite 中，使用 Node 内置的 `node:sqlite`（SQLite 3.51），因此最低版本要求从 20.6 提高到 24。Node 版本过低时启动会给出「请升级到 Node 24」的明确提示，而不是抛出一句难懂的模块错误。

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
| `PORT` | 否 | 本地服务端口 | 默认 `3000`；改动后 `ZHIHU_OAUTH_REDIRECT_URI` 的端口要同步 |
| `DEV_AUTH_PORT` | 否 | 本地模拟登录服务端口 | 默认 `3000`；仅 `npm run dev:auth` 使用 |
| `FRONTEND_ORIGIN` | 否 | 前后端分离部署时的前端源，用于放开 CORS | 留空表示仅同源，且不返回任何 CORS 头 |
| `ZHIHU_ACCESS_SECRET` | Live 必填 | 知乎开放平台 Bearer 凭证 | [知乎开放平台个人中心](https://developer.zhihu.com/profile) |
| `ZHIHU_API_BASE_URL` | 是 | 知乎 API 根地址 | `https://developer.zhihu.com` |
| `ZHIHU_SEARCH_COUNT` | 否 | 每次知乎搜索数量 | `10`，官方接口上限为 10 |
| `ZHIHU_SEARCH_INTERVAL_MS` | 否 | 相邻知乎搜索的最小启动间隔 | 默认 `100`；同一进程内所有生成任务共用该节拍，设为 `0` 可停用 |
| `ZHIHU_TIMEOUT_MS` | 否 | 知乎请求超时 | `30000` |
| `JOURNEY_CACHE_TTL_MS` | 否 | Live 生成结果本地缓存有效期 | `604800000`（7 天）；设为 `0` 停用缓存 |
| `DEEPSEEK_API_KEY` | Live 必填 | 时间线规划与总结 | DeepSeek 或队伍获得的兼容服务密钥 |
| `DEEPSEEK_BASE_URL` | 是 | Chat Completions 根地址 | 官方为 `https://api.deepseek.com`；补贴网关按提供方说明填写 |
| `DEEPSEEK_MODEL` | 是 | 调用的模型名 | 官方当前为 `deepseek-flash` 或 `deepseek-v4-pro`；兼容网关使用其公布的模型名 |
| `DEEPSEEK_THINKING` | 否 | 思考模式开关 | 默认 `disabled`。V4 系列默认开启思考，会把 `max_tokens` 花在 reasoning 上导致正文被截断，**本项目必须关闭**；换成不支持该参数的网关时留空 |
| `DEEPSEEK_TIMEOUT_MS` | 否 | DeepSeek 请求超时 | `90000` |
| `DEEPSEEK_TEMPERATURE` | 否 | 生成温度 | 默认 `0`：输出尽量确定，便于 JSON 校验 |
| `CRAWLER_ENABLED` | 否 | 是否开启公开页线索发现 | `true` |
| `CRAWLER_TIMEOUT_MS` | 否 | 爬虫请求超时 | `8000` |
| `ZHIHU_HOT_LIMIT` | 否 | 首页热搜轮播条数 | `20`，官方接口上限为 30 |
| `HOT_CACHE_TTL_MS` | 否 | 知乎热搜本地缓存有效期 | `600000`（10 分钟）；设为 `0` 停用缓存 |
| `HOT_TRANSLATE_TIMEOUT_MS` | 否 | 热搜标题英译的单次调用超时 | `20000`；超时按翻译失败处理，前端回落中文 |
| `ZHIHU_DATA_DIR` | 否 | SQLite 数据目录 | 默认项目内 `.data/`；填相对路径时按**启动时的工作目录**解析 |
| `ZHIHU_DB_PATH` | 否 | SQLite 数据库文件路径 | 默认 `<数据目录>/zhihu.db`；优先级高于 `ZHIHU_DATA_DIR`，相对路径同样按工作目录解析 |
| `ZHIHU_OAUTH_APP_ID` | 登录必填 | 知乎 OAuth 应用 ID，可公开 | 赛事页面创建项目后分配 |
| `ZHIHU_OAUTH_APP_KEY` | 登录必填 | 知乎 OAuth 应用密钥，**仅后端保存** | 赛事页面创建项目后分配，不得外传或进前端 |
| `ZHIHU_OAUTH_REDIRECT_URI` | 登录必填 | OAuth 回调地址 | 必须与知乎开放平台登记值完全一致；本项目登记的是 `/auth/callback` |
| `ZHIHU_OAUTH_BASE_URL` | 否 | OAuth 服务根地址 | 默认 `https://openapi.zhihu.com`；仅在 mock 测试时改 |
| `ZHIHU_OAUTH_TIMEOUT_MS` | 否 | 换取 token 与拉取用户信息的超时 | 默认 `30000` |
| `ZHIHU_OAUTH_STATE_TTL_MS` | 否 | OAuth state 有效期 | 默认 `600000`（10 分钟） |
| `USER_API_CACHE_TTL_MS` | 否 | 创作/关注接口整页缓存有效期 | 默认 `600000`（10 分钟）；这组接口共用每日 100 次的 `user_data` 额度，不建议关闭 |

最小配置：

```dotenv
ZHIHU_ACCESS_SECRET=从知乎开放平台获取的Access-Secret
ZHIHU_API_BASE_URL=https://developer.zhihu.com
DEEPSEEK_API_KEY=你的DeepSeek或兼容网关密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
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

### 个人中心本地开发

真实知乎 OAuth 只能回调已登记的公网 HTTPS 地址。线上登记为 `https://flow.guyue.me/auth/callback` 后，`127.0.0.1` 无法共享线上 Cookie 和 OAuth state，这是正常的浏览器安全边界。

开发个人中心时运行：

```bash
npm run dev:auth
```

然后打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)，点击「登录知乎」。该命令会在本机回环地址启动模拟 OAuth 和用户数据接口，提供模拟资料、关注列表、创作列表与分页；检索历史写入独立的 `.data/dev-auth.db`。它不会调用真实知乎登录，也不会读取或复制服务器上的会话数据库。

如果本机 3000 端口已占用，可在 `.env.local` 中设置 `DEV_AUTH_PORT=3003`。这个变量只影响 `npm run dev:auth`，不改变生产服务的 `PORT`。正常开发和生产命令的行为保持不变：

- `npm start`：按 `.env.local` 启动普通本地实例，不模拟登录。
- `npm run dev:auth`：仅本机模拟登录，用于个人中心开发。
- `npm run start:prod`：生产启动，不加载任何模拟服务。

真实 OAuth、真实用户数据和 Cookie 安全属性仍需在 `https://flow.guyue.me` 做最终验收。不要把服务器的 `.data/zhihu.db` 下载到本机，其中包含有效会话与 OAuth Token。

## 部署到服务器

> 📄 **可直接照抄执行的完整命令见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)**（传文件 → 配 nginx → 起服务 → 验收 → 排错）。本节只说明设计取舍。

以 `flow.guyue.me` + nginx 反代为例，应用跑在 **3003** 端口，监听 `127.0.0.1`，**不直接对外暴露**，由 nginx 终结 TLS。

> **本项目不能照搬 ask.guyue.me 的 nginx 模式。** 那边是「静态文件放 root，只代理 `/api/`」；本项目由 Node 同时提供页面与接口（`index.html`、`curation.html`、图片、`/api/*`、`/auth/callback`），而且 CSP、`X-Content-Type-Options`、`Referrer-Policy` 都由应用统一下发。照搬会丢 CSP，并且 `/auth/callback` 不在 `/api/` 前缀下、会直接 404 导致登录失败。所以配置里是**整站反代**。

### 0. 部署前必须先在知乎侧改回调

线上回调是 `https://flow.guyue.me/auth/callback`，必须**先在知乎开放平台把 redirect_uri 改成它**，否则回调会跳到访问者自己的电脑上，登录必定失败。

> 如果知乎平台只允许登记一个回调地址，改成线上后**本地开发的登录就不能用了**。动手前先确认平台是否支持多个地址或区分环境。

### 1. 服务器准备

```bash
node --version   # 需要 24 或更高（node:sqlite 的要求）

sudo mkdir -p /var/guyue/flow.guyue.me && sudo chown "$USER" /var/guyue/flow.guyue.me
git clone https://github.com/Guyue2203/zhihu2026.git /var/guyue/flow.guyue.me
cd /var/guyue/flow.guyue.me && cp .env.example .env.local
```

不需要 `npm install`：项目零第三方依赖。

### 2. 填写 `.env.local`

```dotenv
PORT=3003
ZHIHU_ACCESS_SECRET=...
ZHIHU_API_BASE_URL=https://developer.zhihu.com
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
ZHIHU_OAUTH_APP_ID=...
ZHIHU_OAUTH_APP_KEY=...
ZHIHU_OAUTH_REDIRECT_URI=https://flow.guyue.me/auth/callback
```

`HOST` 留空即可（默认 `127.0.0.1`）。收紧权限：`chmod 600 .env.local`。

### 3. DNS 与证书

把 `flow.guyue.me` 的 A 记录指向服务器 IP。

证书直接复用 ask.guyue.me 那张（`/etc/nginx/ssl/.guyue.me/`），**前提是它是 `*.guyue.me` 通配符证书**。核对：

```bash
openssl x509 -in /etc/nginx/ssl/.guyue.me/fullchain.pem -noout -text | grep -A1 "Subject Alternative Name"
```

如果只签了 `ask.guyue.me`（没有通配符），需要单独为 `flow.guyue.me` 签一张。

### 4. nginx

复制 `deploy/nginx.conf.example` 到 `/etc/nginx/sites-available/flow.guyue.me`，软链到 `sites-enabled/`，`nginx -t` 后 reload。

三个容易踩的点：

- **`proxy_set_header X-Forwarded-Proto $scheme;` 不能少，也不能改写成 `$http_x_forwarded_proto`。** 应用靠这个头决定 Cookie 是否加 `Secure`；透传客户端输入等于让它可被伪造。写成 `$scheme` 时 nginx 会用实际协议覆写，是安全的。ask.guyue.me 的配置里没有这一行，是因为那边后端不依赖它。
- **`proxy_read_timeout` 要放大。** 一次时间线生成实测约 15s，nginx 默认 60s 在高峰期可能截断成 504，示例里给了 180s。
- **不要加 `try_files` 和 `root`。** 本项目没有独立的静态根目录，页面由 Node 下发。

示例里还顺带加了两项（可选，但建议保留）：

- **gzip**：首页 HTML 未压缩约 60KB，压缩后约 15KB。注意 `gzip_proxied any` 必须开，否则反代回来的响应不会被压缩。
- **HSTS**：`Strict-Transport-Security` 由 nginx 补（应用自身不设这个头）。示例**故意不加 `includeSubDomains`**——那会波及 `guyue.me` 下所有子域，如果还有别的子域跑 HTTP 会被一起打断。

### 5. 常驻运行

复制 `deploy/zhihu2026.service` 到 `/etc/systemd/system/`，改掉里面的 `User` / `WorkingDirectory` / `ExecStart` 三处路径（`ExecStart` 的 node 要用系统路径，不要写 nvm 的），然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zhihu2026
sudo journalctl -u zhihu2026 -f
```

**生产不要用 `npm start`**，它带 `--watch`（开发特性，文件变动就重启）。用 `npm run start:prod` 或上面的 systemd 单元。

### 6. 验收

```bash
curl -sS https://flow.guyue.me/api/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://flow.guyue.me/
```

然后在浏览器打开 https://flow.guyue.me/ ，点「登录知乎」完整走一次真实授权。

### 部署后要留意的两点

1. **接口没有任何鉴权或限流。** `POST /api/v1/journey` 每次都会真实消耗知乎检索额度与 DeepSeek token，域名公开后任何人都能刷。当前选择是完全公开；如果发现额度异常消耗，需要补一层访问口令或限流。
2. **爬虫在机房 IP 上更容易被拦。** `crawlStage` 抓的是知乎公开搜索页，从服务器发起可能被拒绝或弹验证码；代码会降级回 DeepSeek 生成的检索词（`crawlerStatus` 标为 `fallback_query`），不会中断主流程，但线索发现效果会打折。

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
    "deepseek": true,
    "oauth": false
  },
  "database": {
    "schemaVersion": 1
  }
}
```

### 登录与本人数据

知乎登录采用 Authorization Code Flow。浏览器只拿到应用自己的随机会话标识（`HttpOnly` Cookie），**OAuth access token、app_key 与 Access Secret 全部留在服务端**。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/auth/login` | 下发浏览器标识、生成一次性 `state`，302 跳转到知乎授权页 |
| `GET` | `/auth/callback` | 校验并消费 `state`，换取 token、读取用户信息、建立会话，302 回首页。**这条必须与知乎开放平台登记的 `redirect_uri` 逐字一致** |
| `GET` | `/api/v1/auth/callback` | 上一条的历史别名，保留以免旧配置失效 |
| `POST` | `/api/v1/auth/logout` | 删除服务端会话并清除会话 Cookie |
| `GET` | `/api/v1/me` | 当前登录状态与公开用户信息；未登录也返回 200 |
| `GET` | `/api/v1/me/history?limit=20&offset=0` | 本人检索历史；未登录返回 `401 AUTH_REQUIRED` |
| `POST` | `/api/v1/me/history/clear` | 清空本人检索历史 |
| `GET` | `/api/v1/me/contents?offset=0&limit=20&type=all&sort=ts&order=desc` | 授权用户的创作列表（消耗 `user_data` 额度） |
| `GET` | `/api/v1/me/followees?offset=0&limit=20` | 授权用户的关注列表（消耗 `user_data` 额度） |

创作与关注接口都可以追加 `?refresh=1` 单次绕过缓存。

`GET /api/v1/me` 响应：

```json
{
  "authenticated": true,
  "oauthConfigured": true,
  "user": {
    "uid": "969570047710216200",
    "fullname": "用户昵称",
    "headline": "一句话介绍",
    "avatarPath": "https://picx.zhimg.com/example.jpg",
    "profileUrl": "https://openapi.zhihu.com/users/969570047710216200"
  }
}
```

- `uid` 是 int64，**无损按字符串保存和传递**。`JSON.parse` 直接解析会把它变成超出安全整数范围的 Number 并静默丢精度（例如 `…201` 与 `…200` 会折叠成同一个数），后端因此在解析阶段先把它改写为字符串。
- 接口只返回昵称、头像、一句话介绍与 `uid`；**不读取也不落库邮箱和手机号**，OAuth token 从不出现在任何响应里。
- 回调失败时重定向到 `/?auth_error=<CODE>`，前端弹出提示并立即用 `history.replaceState` 从地址栏抹掉该参数。
- 未配置 OAuth 时登录按钮隐藏，`oauthConfigured` 为 `false`，主流程不受影响。
- 登录用户的每次成功检索（含缓存命中）都会写入 `journey_history`；未登录不写历史。

### 输入语义准入

```http
POST /api/v1/preflight
Content-Type: application/json

{"query":"人工智能怎么样"}
```

返回 `accept`、`clarify` 或 `reject`。算式、固定客观事实、学科通史不会进入认知时间线；宽泛问题返回最多三个固定结构的查询方向，前端让用户选择后再生成。主接口会重复执行同一校验，不能通过跳过前端绕开。

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
| `default`（缺省同此） | 目标 4 个阶段 |
| `fewer` | 目标 3 个阶段 |
| `more` | 目标 6 个阶段 |

模型始终先规划完整的 2—8 阶段骨架并标注 `importance: core/detail`。偏好只决定保留多少 `detail`；所有 `core` 都强制保留，因此巨大转折多于目标值时，结果可以超过该档位。

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
| `thesis` | 认知转变主线（接口与缓存中保留，当前结果页顶部只显示返回按钮与问题标题，因此不在前端展示） |
| `stages` | 按时间或认知顺序排列的阶段 |
| `startYear` / `endYear` | 阶段的结构化公历起止年份；持续至今时 `endYear` 为 `null` |
| `ongoing` / `approximate` | 是否持续至今、时间边界是否为近似判断 |
| `keywords` | 拼图块上展示的 2—3 个阶段关键词 |
| `importance` / `salience` / `reason` | 该阶段属于核心转折还是细节补充，以及它在规划骨架里的理由 |
| `candidateStageCount` | 完整规划骨架的阶段数；可能大于最终展示数 |
| `crawlerStatus` | `ok`、`empty`、`timeout`、`http_error`、`fallback_query`、`disabled` |
| `crawlerQuery` | 本阶段实际送入知乎接口的首个 query |
| `crawlHitCount` | 爬虫提取到的候选数量 |
| `crawlerHttpStatus` / `crawlerErrorCode` | 抓取失败时的安全化诊断信息 |
| `postIds` | 本阶段引用的正式知乎帖子 ID |
| `posts` | 经过知乎接口确认的帖子 |
| `coverage` | `sampled` 或 `model`（未启用知乎检索） |
| `limitations` | 本次结果的证据边界 |
| `recordId` | 本次新生成结果的永久本地记录 ID；缓存命中沿用原值 |

### 知乎热搜

```http
GET /api/v1/hot?limit=20
```

- 调用知乎官方热榜接口 `/api/v1/content/hot_list`，返回 `{ items, fetchedAt, fetchedAtIso, cached }`，每项含 `title`、`titleEn`、`url`、`summary`、`thumbnailUrl`。
- 只接受 `https://zhihu.com` 及其子域名链接，与主流程同一条来源规则。
- 首页左侧「想了解点什么？」内置 10 个适合观察认知变化的预设问题，右侧展示当前知乎热搜。两栏均同时显示 3 条，每 3 秒向上滚动 1 条（停留 3 秒 + 0.36 秒滚动动画，硬编码在前端 `index.html` 的 `TICKER_INTERVAL` / `TICKER_MOVE_MS`，不走 `.env`）；窄屏时上下堆叠。点击任一条目会填入输入框，回车开始检索。
- 缓存命中时不消耗知乎 `hot_list` 额度；上游失败时前端隐藏该模块，不影响提问主流程。
- **热搜英译**：每次回源拿到热榜后，用同一套 DeepSeek JSON 通道把全部标题一次性译成英文，作为 `titleEn` 与热搜条目一起写入缓存。因此翻译只在回源时发生一次，命中缓存（含英文页刷新）不再调用模型，也不额外消耗知乎额度。
- 标题是不可信数据，翻译提示词显式声明其中的指令一律不执行；译文经 HTML 剥离、空白折叠与长度截断后才会落盘。
- 译文缺失（未配置 `DEEPSEEK_API_KEY`、翻译超时或返回残缺）时 `titleEn` 为空串，英文界面自动回落到中文标题，热榜本身始终可用；此时仍照常写缓存，避免因翻译失败反复回源消耗知乎额度。
- 英文界面显示译文，但点击填入的仍是中文原标题——检索语料是中文，直接用译文会显著降低召回；悬停提示同时给出中英两个版本。

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

## 数据存储（SQLite）

时间线缓存、永久生成快照、热搜缓存、知乎用户、登录会话与检索历史统一存放在 SQLite 中，默认文件为 `.data/zhihu.db`（已被 `.gitignore` 忽略）。使用 Node 内置 `node:sqlite`，**不引入任何第三方依赖**；数据库以 WAL 模式运行，`PRAGMA foreign_keys = ON`，并设置 5 秒 busy timeout。

### 表结构

| 表 | 主键 | 用途 |
|---|---|---|
| `journey_cache` | `cache_key` | 生成结果缓存；`payload` 为完整结果 JSON，与接口响应同一契约 |
| `journey_records` | `id` | 每次成功生成的永久快照，含完整规划、候选池与成品；只追加，不参与 TTL 清理 |
| `hot_cache` | `bucket` | 热搜缓存，`bucket` 为归并后的条数档位（10/20/30） |
| `users` | `uid` | 知乎授权用户；`uid` 按十进制字符串存储 |
| `sessions` | `sid` | 应用会话；`oauth_token` 只存在于此，不下发浏览器 |
| `oauth_states` | `state` | 一次性登录请求关联值，含 `expires_at` 与 `consumed_at` |
| `journey_history` | `id` | 登录用户的检索历史；`uid` 外键级联删除 |
| `user_api_cache` | `cache_key` | 创作 / 关注接口的整页缓存；按 `uid` 隔离，`USER_API_CACHE_TTL_MS` 控制有效期 |

版本由 `PRAGMA user_version` 管理，`db.mjs` 里的迁移数组**只能追加、不得修改已发布的迁移**，否则老库无法升级。库版本高于代码支持版本时会明确报错，而不是静默读写错表。

### 生成结果缓存

- 缓存键为「规范化后的 query + 阶段偏好 + 来源模式」的 sha256（三者全量参与，`default` / `zhihu` 不再省略）。
- 命中时直接返回完整结果，不再调用 DeepSeek、爬虫或知乎接口，也不要求任何密钥存在；实测命中约 25 ms，回源约 15 s。
- `JOURNEY_CACHE_TTL_MS` 控制有效期，默认 7 天；设为 `0` 停用缓存读写。
- `schema_version` 记录写入时的结果契约版本。当前为 `3`（阶段带 `core/detail`，总结不得改写规划骨架）；版本不符按未命中处理并自动重建，因此升级后首次请求会重新回源一次。
- 热搜缓存由 `HOT_CACHE_TTL_MS` 控制，默认 10 分钟，同样使用版本号失效。
- **缓存读写失败一律静默降级**：数据库异常不会让真实请求失败，只是每次都回源。生成失败不写缓存，下次请求自动重试完整链路。
- `POST /api/v1/journey?refresh=1` 强制绕过缓存重新生成并更新缓存。
- 启动时会清理超过 TTL 的缓存行，并把 `journey_cache` 控制在最近 500 条，避免演示机长期运行后无限增长。
- 上述清理只作用于加速缓存。每次真正生成都会先追加写入 `journey_records`；7 天后缓存可失效，但历史生成数据仍保留。

### 用户数据接口缓存

创作与关注接口共用开放平台的 `user_data` 额度（默认每租户每日 100 次），而「加载更多」每次翻页都是一次真实调用，很容易烧完。因此每个 `(uid, endpoint, 分页参数)` 组合的整页响应都会进 `user_api_cache`：

- 有效期由 `USER_API_CACHE_TTL_MS` 控制，默认 10 分钟；设为 `0` 停用。
- 只缓存成功响应。鉴权失败、频率限制、配额用尽一律不写缓存，避免把错误状态固化 10 分钟。
- 缓存按 `uid` 隔离，换账号不会读到上一个人的数据。
- 追加 `?refresh=1` 可单次绕过缓存并顺带刷新它。
- 上限 2000 行，启动时按 TTL 清理。

### 旧 JSON 缓存的导入

改造前的 `.cache/journey/*.json` 与 `.cache/hot/list.json` 会在**首次启动时自动导入** SQLite，导入后原文件保留不删除：

- 两张表**各自独立判断**：只有该表为空时才导入。因此「先写入了热搜缓存」不会连带跳过时间线缓存的导入。
- 单个文件损坏（无法解析或结构不符）只跳过该文件，不影响其余导入。
- 库中已有数据时不重复导入，运行时新写入的数据不会被旧文件覆盖。
- 导入完成后启动日志会打印导入条数；`.cache/` 之后不再写入，可以自行归档或删除。

### 迁移到 SQLite 后需要注意

- 缓存键算法与旧版不同（旧版是「文件名 slug + 12 位摘要」），因此**旧文件必须靠导入才能复用**，不能只靠文件名匹配。
- 旧缓存里的 `version: 1` 条目会被导入但按版本规则判为未命中，会在下次请求时重建。
- 不要手工用其他工具同时写这个库；`node:sqlite` 是同步 API，多写者需要自行处理冲突。

## 知乎登录（OAuth）

登录是**可选能力**：不配置也能跑完整主流程，只是没有登录按钮、不记录检索历史。

登录后能力分两层：**基础信息**（昵称、头像、一句话介绍）只需 OAuth access token；**创作列表与关注列表**是开放平台的用户数据 API，除 OAuth token 外还要求 `Authorization: Bearer <Access Secret>`，因此这两项同时依赖 `ZHIHU_ACCESS_SECRET`。

### 接入步骤

1. 在知乎开放平台创建项目，取得 `app_id` 与 `app_key`，并登记回调地址。二者与开放平台 Access Secret **不是同一套凭证**，Access Secret 不能用于 OAuth。
2. 把三项写入 `.env.local`：

```dotenv
ZHIHU_OAUTH_APP_ID=开放平台分配的app_id
ZHIHU_OAUTH_APP_KEY=开放平台分配的app_key
ZHIHU_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/auth/callback
```

3. 重启服务（`.env.local` 变更不会被 `--watch` 感知），首页右上角出现「登录知乎」。

`redirect_uri` 的协议、域名、端口、路径、尾部斜杠和固定 Query 参数必须与赛事页面登记值**完全一致**；换端口或换域名联调前，先在赛事页面同步修改。

### 协议要点

- 授权页：`GET https://openapi.zhihu.com/authorize?redirect_uri=…&app_id=…&response_type=code&state=…`
- 回调参数当前实测为 `authorization_code`；后端同时接受 `code` 以兼容协议修订，但以 `authorization_code` 为主路径。
- 换取 token：`POST https://openapi.zhihu.com/access_token`，表单字段仍用 `code`（不是 `authorization_code`）。
- 用户信息：`GET https://openapi.zhihu.com/user`，`Authorization: Bearer <access_token>`，无需 Access Secret。
- `/access_token` 与 `/user` 的业务字段 `code: 20000` 表示成功，因此**优先检查 `access_token` 或用户对象是否存在**，不把所有非零 `code` 当失败；也不能只凭 HTTP 200 判断成功（历史上有 HTTP 200 + `{"code":404}` 的失败形态）。
- 黑客松 OAuth 已支持 `state` 原样透传，本项目按带 `state` 的流程实现。

### 安全约束

| 约束 | 实现方式 |
|---|---|
| CSRF / 登录请求关联 | 32 字节随机 `state`，绑定发起登录的浏览器标识，10 分钟有效，**单次消费**；缺失、不匹配、过期、重放一律拒绝，且拒绝发生在换取 token **之前** |
| 会话固定 | 登录成功时签发全新的会话标识，不复用登录前的浏览器标识 |
| 凭证不落地浏览器 | app_key 与 OAuth token 只在服务端与 SQLite；Cookie 仅承载随机会话标识，`HttpOnly` + `SameSite=Lax`；`Secure` 按**真实请求**判断（TLS 连接或 `X-Forwarded-Proto: https`），不按 `redirect_uri`——否则用局域网 IP 做 HTTP 演示时 Cookie 会被浏览器直接丢弃，登录静默失败 |
| 会话生命周期 | 会话有效期取 token 的 `expires_in`；读写路径都会检查过期并顺手清理。当前协议没有 refresh token，token 过期后需用户重新授权 |
| 最小数据 | 只读取昵称、头像、一句话介绍与 `uid`；**不读取邮箱和手机号**，也不落库 |
| 失败不越权 | token 失效或鉴权失败时返回 `AUTH_REQUIRED` 并停止读取，**绝不静默回退到 Access Secret 所属账号** |
| 错误不外泄 | 回调失败只回传错误码（`/?auth_error=…`），不把上游错误细节或任何凭证放进 URL |

### 用 mock 验证登录

`npm test` 不访问外网：`test.mjs` 用本地 mock 覆盖换 token 与用户信息，`e2e.mjs` 额外启动一个指向 mock 的独立实例，跑通「登录跳转 → state 拒绝分支 → 建立会话 → 读取本人信息 → 检索写历史 → 退出」。真实联调仍需开发者本人在浏览器完成一次授权，mock 通过不代表线上通过。

## DeepSeek 模型与思考模式

`deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 停用**，当前正式模型是 `deepseek-flash` 与 `deepseek-v4-pro`。停用后 `deepseek-chat` 仍被服务端当别名兜底转发（响应体里 `"model"` 会回 `deepseek-flash`），但这是无保证状态，随时可能彻底失效，因此项目已切换到显式模型名。

**迁移时必须同时关闭思考模式。** V4 系列默认开启思考，`max_tokens` 会先被 reasoning 吃掉，而本项目多处预算很小。以 `prelude`（`max_tokens: 400`）为例的实测结果：

| 配置 | 结果 | reasoning | completion |
|---|---|---:|---:|
| `deepseek-chat`（旧别名） | 正常 | 0 | 41 |
| `deepseek-flash`（默认思考） | 正常但余量极小 | 249 | 302 |
| `deepseek-v4-pro`（默认思考） | **失败**：`finish_reason=length`，正文为空 | 400 | 400 |
| `deepseek-flash` + 关闭思考 | 正常 | 0 | 41 |

`DEEPSEEK_THINKING=disabled` 会发送 `thinking: {type: "disabled"}`；不设置该变量时不发送此字段，避免兼容网关因未知参数报错。

`deepseekJson` 对「被 `max_tokens` 截断且正文为空」单独返回 `DEEPSEEK_TRUNCATED`，比笼统的 `DEEPSEEK_INVALID` 更容易判断是不是思考模式吃掉了预算。

> 说明：以上结论来自对当前 key 的实测（请求体、`usage.completion_tokens_details.reasoning_tokens` 与 `finish_reason`），不是按文档推断。输出**质量**差异未做评测，如需在 `deepseek-flash` 与 `deepseek-v4-pro` 之间取舍，应在本项目「评测方法」一节列出的 10 个固定问题上做 A/B。

## 离线外部检索与静态演示

`offline-pool.mjs` 实现比赛演示采用的非实时路径：外部浏览器按阶段和日期严格检索并保存 HTML，程序从中建立预选池，再与人工核验的帖子元数据求交集。规范知乎回答链接、`verified: true`、阶段日期范围和最低相关度是硬门槛；之后按“相关度 55% + 对数热度 30% + 外部排名 15%”计算推荐分，并先取不同 `stance` 的最高分以防单一叙事垄断。

```powershell
node offline-pool.mjs path\to\manifest.json
# 默认输出 static/journeys/<slug>.json
```

manifest 格式和浏览器导出步骤见 [`static/README.md`](static/README.md)。任一阶段没有合格帖子时构建直接失败，不生成假数据。`curation.html?journey=<slug>#results` 会读取对应的 `/static/journeys/<slug>.json`（缺省 `bike`）；文件不存在时保留并明确标注当前策展占位稿。该路径不在用户访问时启动浏览器、爬虫或模型。

## Live 轻量爬虫如何工作

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
| 语义准入 | `POST /api/v1/preflight`；主接口也强制复验 |
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
| 登录入口 | `GET /api/v1/auth/login`（302 跳转）、`GET /auth/callback`（登记路径）、`POST /api/v1/auth/logout` |
| 登录状态 | `GET /api/v1/me`；未登录也返回 200 且 `authenticated: false` |
| 会话载体 | `HttpOnly` Cookie `cyby_session`；浏览器全程不接触 OAuth token |
| 用户主键 | `uid` 是无损字符串，前端不得转成 Number |
| 检索历史 | `GET /api/v1/me/history`；未登录返回 `401 AUTH_REQUIRED` |
| 创作与关注 | `GET /api/v1/me/contents`、`GET /api/v1/me/followees`；分页一律用服务端返回的 `NextOffset` 原样回传 |
| 覆盖声明 | Live API 返回 `sampled` 或 `model`；离线构建产物为 `curated_static` |

## 验证

```powershell
npm test           # 自检 + 持久层/OAuth 单测 + 端到端，全程不访问外网
npm run test:unit  # 只跑自检与单测
npm run test:e2e   # 只跑端到端（自行取空闲端口，起一个临时实例）
node offline-pool.mjs --self-test  # 离线提取、硬校验、排序与立场多样性
```

语法检查：

```powershell
node --check core.mjs
node --check server.mjs
node --check db.mjs
node --check oauth.mjs
node --check offline-pool.mjs
```

覆盖范围：

| 命令 | 覆盖 |
|---|---|
| `node core.mjs --self-test` | 语义准入、核心节点保留、缓存隔离与失效、爬虫候选提取、prelude 回退 |
| `node offline-pool.mjs --self-test` | 外部结果链接提取、日期/来源硬校验、推荐排序、立场多样性 |
| `node test.mjs` | 建表迁移、永久记录不受缓存清理、WAL 与外键、用户/会话、OAuth state、历史、缓存与旧 JSON 导入 |
| `node e2e.mjs` | 输入拒绝、静态路由、mock OAuth 登录全链路、用户数据接口、检索历史、退出、CSP |

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
| `400` | `OAUTH_CALLBACK_INVALID` / `OAUTH_STATE_MISSING` / `OAUTH_STATE_INVALID` | 回调缺少授权码，或 state 缺失 / 不匹配 / 过期 / 重放 |
| `401` | `AUTH_REQUIRED` | 未登录访问本人数据 |
| `404` | `NO_RESULTS` / `NOT_FOUND` | 没有结果或接口不存在 |
| `413` | `INPUT_TOO_LARGE` | 请求体超过 4 KB |
| `502` | `ZHIHU_*` / `DEEPSEEK_*` | 外部服务失败或输出无效 |
| `502` | `OAUTH_NETWORK_ERROR` / `OAUTH_TOKEN_FAILED` / `OAUTH_PROFILE_FAILED` / `OAUTH_INVALID` | 知乎 OAuth 通信失败或返回无效 |
| `503` | `CONFIG_MISSING` | 缺少密钥 |
| `503` | `OAUTH_NOT_CONFIGURED` | 缺少 OAuth 配置，无法发起登录 |
| `500` | `CONFIG_INVALID` / `INTERNAL` | 配置或内部错误 |

## 权威文档

- [知乎数据开放平台](https://developer.zhihu.com/)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
