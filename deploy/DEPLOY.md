# 部署到 flow.guyue.me

本文是可直接照抄执行的完整流程：传文件 → 配 nginx → 起服务 → 验收。

目标环境：服务器目录 `/var/guyue/flow.guyue.me/`，应用监听 `127.0.0.1:3003`，nginx 终结 TLS 并整站反代。

---

## ⚠️ 先读：当前仓库状态会让 `git clone` 部署失败

本地分支是 `alpha`，且以下文件**尚未提交**（未跟踪或已修改）：

```
db.mjs  oauth.mjs  zhihu-user.mjs  test.mjs  e2e.mjs  deploy/  assets/
server.mjs  core.mjs  index.html  package.json  README.md ...
```

`server.mjs` 会 `import` 上面的 `db.mjs` / `oauth.mjs` / `zhihu-user.mjs`。**如果直接 `git clone`，服务器上会缺这三个文件，启动即报 `ERR_MODULE_NOT_FOUND`。**

所以本文**主推 rsync**（把本地磁盘现状原样传过去，包含未提交的改动）。想用 git 方式的话，参见 [方式 B](#方式-bgit需要先提交)。

---

## 0. 你必须在知乎侧先做的一件事

线上回调是 `https://flow.guyue.me/auth/callback`。

**去知乎开放平台把 redirect_uri 改成这个地址**，否则授权后回调会跳到访问者自己的电脑上，登录必定失败。

> 如果平台只允许登记一个地址，改成线上后本地开发的登录就不能用了。这一步没有替代方案，也无法由脚本完成。

---

## 1. 服务器环境

```bash
# 需要 Node 24 或更高（node:sqlite 的要求）
node --version
```

没有或版本过低时（Ubuntu / Debian）：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

> 记下 `which node` 的输出（通常是 `/usr/bin/node`），第 5 步要用。
> **不要用 nvm 装的 node** —— nvm 依赖登录 shell 环境，systemd 里取不到。

---

## 2. 传文件

### 方式 A：rsync（推荐）

在**本地**项目目录执行。

```bash
cd /Users/guyue/Developer/projects/zhihuhackthon/zhihu2026
```

先把服务器目录建好（把 `guyue` 和 `your-server` 换成你的实际用户名与地址）：

```bash
ssh guyue@your-server 'sudo mkdir -p /var/guyue/flow.guyue.me && sudo chown guyue:guyue /var/guyue/flow.guyue.me'
```

然后同步。`--exclude` 里的四项**必须排除**：

```bash
rsync -avz --delete \
  --exclude='.env.local' \
  --exclude='.data/' \
  --exclude='.cache/' \
  --exclude='.git/' \
  --exclude='.DS_Store' \
  --exclude='node_modules/' \
  ./ guyue@your-server:/var/guyue/flow.guyue.me/
```

各条排除的理由：

| 排除项 | 原因 |
|---|---|
| `.env.local` | 含 App Key 与 Access Secret，且线上端口/回调跟本地不同，应由第 3 步单独生成 |
| `.data/` | 本地 SQLite 库，含登录会话与 token，不该传上服务器 |
| `.cache/` | 改造前的 JSON 缓存，服务器不需要 |
| `.git/` | 体积大；用 rsync 方式部署不需要 git 元数据 |

`--delete` 会让服务器目录与本地保持一致。`--exclude` 列出的项同时受保护、不会被删。

### 方式 B：git（需要先提交）

```bash
# 本地：先把工作提交并推送，否则推上去的代码缺文件
cd /Users/guyue/Developer/projects/zhihuhackthon/zhihu2026
git add -A
git commit -m "SQLite 持久化 + 知乎 OAuth 登录 + 用户界面 + 部署配置"
git push origin alpha

# 服务器
sudo mkdir -p /var/guyue/flow.guyue.me && sudo chown guyue:guyue /var/guyue/flow.guyue.me
git clone -b alpha https://github.com/Guyue2203/zhihu2026.git /var/guyue/flow.guyue.me
```

> ⚠️ `.env.local` 被 `.gitignore` 忽略，两种方式都不会带上它，第 3 步必须单独做。

---

## 3. 生成 `.env.local`

从本地直接传过去，避免密钥出现在终端历史和聊天记录里：

```bash
# 本地执行
scp .env.local guyue@your-server:/var/guyue/flow.guyue.me/.env.local
```

然后在**服务器**上只改这两处（其余值原样保留）：

```bash
ssh guyue@your-server
cd /var/guyue/flow.guyue.me
sed -i 's|^PORT=.*|PORT=3003|' .env.local
sed -i 's|^ZHIHU_OAUTH_REDIRECT_URI=.*|ZHIHU_OAUTH_REDIRECT_URI=https://flow.guyue.me/auth/callback|' .env.local
```

确认结果（这一步不会打印密钥本身）：

```bash
grep -E '^(PORT|ZHIHU_OAUTH_APP_ID|ZHIHU_OAUTH_REDIRECT_URI|DEEPSEEK_MODEL|DEEPSEEK_THINKING)=' .env.local
```

期望看到：

```
PORT=3003
ZHIHU_OAUTH_APP_ID=541
ZHIHU_OAUTH_REDIRECT_URI=https://flow.guyue.me/auth/callback
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled
```

> 注意回调地址**不写 3003**：公网走 443，3003 只是 nginx 反代到后端的内部端口。

---

## 4. 目录与权限

```bash
cd /var/guyue/flow.guyue.me

# .data/ 必须提前建好：systemd 开了 ProtectSystem=strict，应用自己无权创建它
mkdir -p .data
chmod 700 .data

# 密钥文件只有属主可读
chmod 600 .env.local

ls -ld . .data .env.local
```

---

## 5. 先手动跑一次（配 systemd 之前）

这一步能在引入 systemd 之前把配置错误暴露出来，省掉大量排查：

```bash
cd /var/guyue/flow.guyue.me
node --env-file=.env.local server.mjs
```

期望输出：

```
知乎观点检索：http://127.0.0.1:3003/
SQLite：/var/guyue/flow.guyue.me/.data/zhihu.db（schema v2）
```

另开一个终端验证，然后回前台 `Ctrl+C` 停掉：

```bash
curl -sS http://127.0.0.1:3003/api/v1/health
```

出现 `{"status":"ok",...}` 即可继续。

---

## 6. 配置 systemd

```bash
cd /var/guyue/flow.guyue.me
sudo cp deploy/zhihu2026.service /etc/systemd/system/
```

**改三处**（`User` / `Group` / `WorkingDirectory`）。文件里默认已写成 `guyue` 与目标路径；如果你的服务器用户名不是 `guyue`，用 `id -un` 查出来后改：

```bash
sudo vim /etc/systemd/system/zhihu2026.service
```

> `User` 必须是**拥有项目文件的用户**，不能用 `www-data`：`.env.local` 是 600，运行用户不一致会直接读不到、启动失败。

启动并设为开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zhihu2026
sudo systemctl status zhihu2026 --no-pager
```

看日志：

```bash
sudo journalctl -u zhihu2026 -f
```

确认端口在监听：

```bash
ss -lntp | grep 3003
```

---

## 7. 配置 nginx

```bash
cd /var/guyue/flow.guyue.me
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/flow.guyue.me
sudo ln -sf /etc/nginx/sites-available/flow.guyue.me /etc/nginx/sites-enabled/flow.guyue.me
sudo nginx -t
sudo systemctl reload nginx
```

配置里已经按你的服务器环境写好了：证书沿用 `/etc/nginx/ssl/.guyue.me/`，反代到 `127.0.0.1:3003`，并带上 `X-Forwarded-Proto $scheme`、180s 超时、gzip、HSTS。

**三个不要改的地方：**

- `proxy_set_header X-Forwarded-Proto $scheme;` —— 应用靠它决定 Cookie 是否加 `Secure`。写成 `$http_x_forwarded_proto` 会变成透传客户端输入，可被伪造。
- 不要加 `root` / `try_files` —— 本项目没有独立静态根目录，`index.html` 由 Node 下发；拆出去会丢 CSP。
- 不要改成只代理 `/api/` —— `/auth/callback` 不在该前缀下，会 404 导致登录失败。

---

## 8. DNS 与证书

```bash
# A 记录要指向服务器 IP
dig +short flow.guyue.me

# 确认现有证书覆盖 flow.guyue.me（是 *.guyue.me 通配符即可）
openssl x509 -in /etc/nginx/ssl/.guyue.me/fullchain.pem -noout -text | grep -A1 "Subject Alternative Name"
```

如果证书只签了 `ask.guyue.me` 而没有通配符，需要单独为 `flow.guyue.me` 签一张。

---

## 9. 验收

```bash
# 1) 健康检查
curl -sS https://flow.guyue.me/api/v1/health

# 2) 首页
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' https://flow.guyue.me/

# 3) 回调路径必须可达：期望 302 回首页，而不是 404
curl -sS -o /dev/null -w 'HTTP %{http_code} -> %{redirect_url}\n' \
  'https://flow.guyue.me/auth/callback?state=x'

# 4) 确认 Cookie 带上了 Secure（由 X-Forwarded-Proto 决定）
curl -sSI https://flow.guyue.me/api/v1/auth/login | grep -i '^set-cookie'

# 5) 确认 gzip 生效
curl -sSI -H 'Accept-Encoding: gzip' https://flow.guyue.me/ | grep -i 'content-encoding'
```

第 3 条是**最关键的一条**：它同时验证了 nginx 是整站反代（不是只代理 `/api/`）和回调路径没被拦。
第 4 条应能看到 `Secure` 字样，看不到说明 `X-Forwarded-Proto` 没生效。

最后在浏览器打开 https://flow.guyue.me/ ，点右上角「登录知乎」**完整走一次真实授权**（最后一步确认按钮由你本人点）。

---

## 10. 日常更新

改了代码之后：

```bash
# 本地
cd /Users/guyue/Developer/projects/zhihuhackthon/zhihu2026
rsync -avz --delete \
  --exclude='.env.local' --exclude='.data/' --exclude='.cache/' \
  --exclude='.git/' --exclude='.DS_Store' --exclude='node_modules/' \
  ./ guyue@your-server:/var/guyue/flow.guyue.me/

# 服务器
ssh guyue@your-server 'sudo systemctl restart zhihu2026'
```

`.env.local` 变更不会被自动感知，改完必须 `restart`。

---

## 11. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 502 Bad Gateway | 应用没起来或端口不对 | `sudo systemctl status zhihu2026`、`ss -lntp \| grep 3003` |
| 启动报 `ERR_MODULE_NOT_FOUND: db.mjs` | 用了 `git clone` 但文件没提交 | 改用 [方式 A](#方式-arsync推荐)，或先提交推送 |
| 启动报读不到 `.env.local` | systemd 的 `User` 与文件属主不一致 | 改 `User` 为文件属主，或 `chown` |
| `203/EXEC` | `ExecStart` 里的 node 是 nvm 路径 | 改成 `which node` 的系统路径 |
| 登录后右上角仍显示未登录 | `X-Forwarded-Proto` 缺失，Cookie 没带 `Secure` 被丢弃 | 检查 nginx 该行；用验收第 4 条自检 |
| 回调 404 | nginx 只代理了 `/api/` | 改成整站反代 |
| 生成时报 504 | `proxy_read_timeout` 太短 | 配置里已设 180s，确认没被覆盖 |
| 热榜板块消失 | `hot_list` 每日额度只有 100，被耗尽 | 前端会自动隐藏、不影响提问；把 `HOT_CACHE_TTL_MS` 调到 `1800000` 可降到 48 次/天 |
| 生成时报 `rate limit exceeded` | 知乎检索按**账号**限流，多访客共用同一个桶 | 默认先以 100ms 间隔做轻量错峰；仍触发时调高 `ZHIHU_SEARCH_INTERVAL_MS` |

---

## 附：两个已知限制

1. **接口没有任何鉴权或限流。** `POST /api/v1/journey` 每次都会真实消耗知乎检索额度与 DeepSeek token。域名公开后任何人都能刷。想加口令时，在 nginx 的 `location /` 里加两行 `auth_basic` 即可（配置示例文件底部有说明），可复用你现有的 `.htpasswd-guyue`。

2. **突发限流。** 一次生成仍会发起最多 8 次知乎搜索，但同一 Node 进程中的所有搜索现在共享节拍，默认至少间隔 100ms 启动，先以较小延迟避免请求在同一时刻发出。该改动暂不减少请求次数，也不重试已经被上游拒绝的请求；若仍触发限流，可逐步把 `.env.local` 中的 `ZHIHU_SEARCH_INTERVAL_MS` 调高到 `500`、`1000` 或更高后重启服务。

额度自查（不会打印密钥）：

```bash
cd /var/guyue/flow.guyue.me && set -a && . ./.env.local && set +a
curl -sS -G "https://developer.zhihu.com/api/v1/quota" \
  -H "Authorization: Bearer $ZHIHU_ACCESS_SECRET" \
  -H "X-Request-Timestamp: $(date +%s)" | python3 -m json.tool
```
