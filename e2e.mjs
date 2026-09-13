/**
 * 临时端到端验证：mock 知乎 OAuth 提供方 + 独立应用实例。
 * 覆盖 登录跳转 → 回调建会话 → /me → 检索写历史 → /me/history → 退出。
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const BIG_UID = '969570047710216200';
const failures = [];
let passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed += 1; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const equal = (name, a, b) => check(name, Object.is(a, b), `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

/** 用户数据接口的调用记录，用于断言分页参数、缓存命中和凭证传递。 */
const userApiCalls = [];

function contentItem(id) {
  return { ContentType: 'answer', Url: `https://www.zhihu.com/answer/${id}`, CreatedAt: 1789000000, LikeCount: id, CommentCount: id * 2, FavoriteCount: id * 3, Title: `创作 ${id}`, Summary: `摘要 ${id}` };
}
function followeeItem(id) {
  return { Fullname: `关注的人 ${id}`, UrlToken: `token${id}`, Url: `https://www.zhihu.com/people/token${id}`, AvatarUrl: `https://picx.zhimg.com/${id}.jpg`, Headline: `签名 ${id}`, Gender: 1, FollowerCount: id * 100 };
}
const sendJson = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(value)); };

const provider = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/access_token') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    if (form.get('code') !== 'good-code') return sendJson(response, { error: 'invalid_grant' });
    return sendJson(response, { access_token: 'e2e-oauth-token', token_type: 'Bearer', expires_in: 3600, code: 20000 });
  }
  if (request.method === 'GET' && url.pathname === '/user') {
    return sendJson(response, { uid: BIG_UID, hash_id: 'h', fullname: '端到端用户', gender: 'male', headline: '一句话介绍', avatar_path: 'https://picx.zhimg.com/a.jpg', url: `https://openapi.zhihu.com/users/${BIG_UID}`, email: 'leak@example.com', phone_no: '13800000000' });
  }
  if (request.method === 'GET' && (url.pathname === '/api/v1/user/contents' || url.pathname === '/api/v1/user/followees')) {
    const endpoint = url.pathname.endsWith('contents') ? 'contents' : 'followees';
    const offset = url.searchParams.get('Offset') || '0';
    userApiCalls.push({
      endpoint, offset,
      limit: url.searchParams.get('Limit'),
      contentType: url.searchParams.get('ContentType'),
      oauthToken: request.headers['x-oauth-token'],
      authorization: request.headers.authorization,
      timestamp: request.headers['x-request-timestamp'],
    });
    if (offset === '97') return sendJson(response, { Code: 20001, Message: 'auth failed' });
    if (offset === '98') return sendJson(response, { Code: 0, Message: 'success', Data: { Items: [], Paging: { IsEnd: false, Totals: 9 } } });
    if (offset === '99') return sendJson(response, { Code: 0, Message: 'success', Data: { Items: [], Paging: { IsEnd: false, NextOffset: 'not-a-number', Totals: 9 } } });
    const build = id => (endpoint === 'contents' ? contentItem(id) : followeeItem(id));
    if (offset === '0') return sendJson(response, { Code: 0, Message: 'success', Data: { Items: [build(1), build(2)], Paging: { IsEnd: false, NextOffset: '2', Totals: 3 } } });
    return sendJson(response, { Code: 0, Message: 'success', Data: { Items: [build(3)], Paging: { IsEnd: true, Totals: 3 } } });
  }
  response.writeHead(404); response.end('{}');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

/** 取一个空闲端口，避免与开发中的 3000/其他实例冲突。 */
async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const workspace = await mkdtemp(path.join(tmpdir(), 'zhihu-e2e-'));
// 预置一条改造前的 JSON 缓存：既让检索请求命中缓存（不依赖真实密钥、不消耗额度），
// 也顺带覆盖「上线后自动导入旧缓存」这条路径。
const legacyJourneyDir = path.join(workspace, 'legacy-journey');
await mkdir(legacyJourneyDir, { recursive: true });
await writeFile(path.join(legacyJourneyDir, 'seed.json'), JSON.stringify({
  version: 2, query: '共享单车为什么失败？', preference: 'default', source: 'zhihu',
  fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
  result: {
    query: '共享单车为什么失败？', title: '共享单车：从规模神话到单位经济性',
    thesis: '预置缓存', stages: [{ id: 'stage-1', period: '早期', cognition: '被视为创新', change: '', evidence: '', postIds: [] }],
    posts: [], limitations: ['预置缓存'], coverage: 'sampled', evidenceCount: 0, selectedCount: 0,
  },
}));
const appPort = await freePort();
const app = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PORT: String(appPort),
    ZHIHU_DB_PATH: path.join(workspace, 'e2e.db'),
    ZHIHU_DATA_DIR: workspace,
    JOURNEY_CACHE_DIR: legacyJourneyDir,
    HOT_CACHE_DIR: path.join(workspace, 'no-legacy-hot'),
    ZHIHU_API_BASE_URL: providerBase,
    ZHIHU_ACCESS_SECRET: 'e2e-access-secret',
    ZHIHU_OAUTH_BASE_URL: providerBase,
    ZHIHU_OAUTH_APP_ID: 'app-id-e2e',
    ZHIHU_OAUTH_APP_KEY: 'app-key-e2e',
    ZHIHU_OAUTH_REDIRECT_URI: `http://127.0.0.1:${appPort}/auth/callback`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', chunk => { appLog += chunk; });
app.stderr.on('data', chunk => { appLog += chunk; });
await new Promise(resolve => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${appPort}`;
const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    jar.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
  }
}
const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', headers: { cookie: cookieHeader() }, ...opts });
const post = (p, body, opts = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHeader(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...opts });

try {
  /* 1. 未登录状态 */
  const meAnon = await get('/api/v1/me'); absorb(meAnon);
  const anonBody = await meAnon.json();
  equal('未登录时 authenticated 为 false', anonBody.authenticated, false);
  equal('OAuth 已配置', anonBody.oauthConfigured, true);
  equal('未登录时 user 为 null', anonBody.user, null);
  const histAnon = await get('/api/v1/me/history'); absorb(histAnon);
  equal('未登录访问历史返回 401', histAnon.status, 401);
  equal('401 带 AUTH_REQUIRED', (await histAnon.json()).code, 'AUTH_REQUIRED');

  /* 2. 发起登录 */
  const login = await get('/api/v1/auth/login'); absorb(login);
  equal('登录返回 302', login.status, 302);
  const authorize = new URL(login.headers.get('location'));
  equal('跳转到 mock 授权页', `${authorize.origin}${authorize.pathname}`, `${providerBase}/authorize`);
  equal('授权页带 app_id', authorize.searchParams.get('app_id'), 'app-id-e2e');
  equal('授权页回传 redirect_uri', authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${appPort}/auth/callback`);
  const state = authorize.searchParams.get('state');
  check('授权页带 state', Boolean(state) && state.length >= 32);
  check('登录后下发浏览器标识 Cookie', jar.has('cyby_browser'));
  equal('登录时无会话 Cookie', jar.has('cyby_session'), false);

  /* 3. state 校验失败的分支 */
  const beforeState = new Map(jar);
  const badState = await get(`/auth/callback?authorization_code=good-code&state=forged-state`); absorb(badState);
  equal('伪造 state 返回 302 回首页', badState.status, 302);
  equal('伪造 state 带错误码', new URL(badState.headers.get('location'), base).searchParams.get('auth_error'), 'OAUTH_STATE_INVALID');
  equal('伪造 state 不建立会话', badState.headers.getSetCookie().some(c => c.startsWith('cyby_session=')), false);
  const missingState = await get('/auth/callback?authorization_code=good-code'); absorb(missingState);
  equal('缺失 state 带错误码', new URL(missingState.headers.get('location'), base).searchParams.get('auth_error'), 'OAUTH_STATE_MISSING');
  jar.clear(); for (const [k, v] of beforeState) jar.set(k, v);

  /* 4. 正常回调 */
  const callback = await get(`/auth/callback?authorization_code=good-code&state=${encodeURIComponent(state)}`); absorb(callback);
  equal('正常回调返回 302', callback.status, 302);
  equal('正常回调跳回首页', new URL(callback.headers.get('location'), base).pathname, '/');
  check('正常回调无错误码', !new URL(callback.headers.get('location'), base).searchParams.has('auth_error'));
  check('正常回调下发会话 Cookie', jar.has('cyby_session'));
  const sessionCookieRaw = callback.headers.getSetCookie().find(c => c.startsWith('cyby_session='));
  check('会话 Cookie 带 HttpOnly', sessionCookieRaw.includes('HttpOnly'));
  check('会话 Cookie 带 SameSite=Lax', sessionCookieRaw.includes('SameSite=Lax'));
  check('明文 HTTP 下会话 Cookie 不带 Secure（局域网 IP 演示可用）', !sessionCookieRaw.includes('Secure'));

  /* 5. 已登录状态 */
  const meIn = await get('/api/v1/me'); absorb(meIn);
  const meBody = await meIn.json();
  equal('已登录 authenticated 为 true', meBody.authenticated, true);
  equal('uid 无损传递', meBody.user.uid, BIG_UID);
  equal('昵称正确', meBody.user.fullname, '端到端用户');
  check('响应不泄露 oauth token', !JSON.stringify(meBody).includes('e2e-oauth-token'));
  check('响应不泄露邮箱', !JSON.stringify(meBody).includes('leak@example.com'));
  check('响应不泄露手机号', !JSON.stringify(meBody).includes('13800000000'));

  /* 6. 已登录检索写入历史 */
  const journey = await post('/api/v1/journey', { query: '共享单车为什么失败？' }); absorb(journey);
  equal('已登录检索返回 200', journey.status, 200);
  const history = await get('/api/v1/me/history'); absorb(history);
  const histBody = await history.json();
  equal('历史记录写入 1 条', histBody.items?.length, 1);
  equal('历史记录 query 正确', histBody.items?.[0]?.query, '共享单车为什么失败？');
  equal('历史记录带上标题', Boolean(histBody.items?.[0]?.title), true);
  check('历史记录不含 token', !JSON.stringify(histBody).includes('e2e-oauth-token'));

  /* 6.5 用户数据接口：凭证传递、分页、缓存与协议边界 */
  const contents1 = await get('/api/v1/me/contents'); absorb(contents1);
  const contents1Body = await contents1.json();
  equal('创作列表首屏 2 条', contents1Body.items?.length, 2);
  equal('创作总数', contents1Body.paging?.totals, 3);
  equal('创作首页未结束', contents1Body.paging?.isEnd, false);
  equal('NextOffset 原样返回', contents1Body.paging?.nextOffset, '2');
  equal('首屏标记为非缓存', contents1Body.cached, false);
  equal('创作标题正确', contents1Body.items?.[0]?.title, '创作 1');
  equal('创作链接指向知乎', contents1Body.items?.[0]?.url, 'https://www.zhihu.com/answer/1');
  equal('创作摘要正确', contents1Body.items?.[0]?.summary, '摘要 1');
  const firstCall = userApiCalls.at(-1) || {};
  equal('ContentType 已传上游', firstCall.contentType, 'all');
  equal('Limit 已传上游', firstCall.limit, '20');
  equal('上游收到 X-OAuth-Token', firstCall.oauthToken, 'e2e-oauth-token');
  equal('上游收到 Access Secret', firstCall.authorization, 'Bearer e2e-access-secret');
  check('上游收到秒级时间戳', /^\d{10}$/.test(String(firstCall.timestamp || '')));

  const callCountBeforeCache = userApiCalls.length;
  const contentsCached = await get('/api/v1/me/contents'); absorb(contentsCached);
  const cachedBody = await contentsCached.json();
  equal('重复请求命中缓存', cachedBody.cached, true);
  equal('缓存命中不重复回源', userApiCalls.length, callCountBeforeCache);
  equal('缓存内容与首屏一致', cachedBody.items?.length, 2);

  const contents2 = await get('/api/v1/me/contents?offset=2'); absorb(contents2);
  const contents2Body = await contents2.json();
  equal('第二页 1 条', contents2Body.items?.length, 1);
  equal('第二页已结束', contents2Body.paging?.isEnd, true);
  equal('offset 原样传给上游', (userApiCalls.at(-1) || {}).offset, '2');

  const followees = await get('/api/v1/me/followees'); absorb(followees);
  const followeesBody = await followees.json();
  equal('关注列表首屏 2 人', followeesBody.items?.length, 2);
  equal('关注人姓名', followeesBody.items?.[0]?.fullname, '关注的人 1');
  equal('头像限定知乎图床', followeesBody.items?.[0]?.avatarUrl, 'https://picx.zhimg.com/1.jpg');
  equal('粉丝数', followeesBody.items?.[0]?.followerCount, 100);
  equal('关注页未结束', followeesBody.paging?.isEnd, false);

  const incomplete = await get('/api/v1/me/contents?offset=98'); absorb(incomplete);
  const incompleteBody = await incomplete.json();
  equal('IsEnd=false 却缺 NextOffset 时标记不完整', incompleteBody.paging?.incomplete, true);
  equal('不完整时不给 nextOffset', incompleteBody.paging?.nextOffset, null);

  const badPaging = await get('/api/v1/me/contents?offset=99'); absorb(badPaging);
  equal('非法 NextOffset 返回 502', badPaging.status, 502);
  equal('非法 NextOffset 错误码', (await badPaging.json()).code, 'ZHIHU_PAGING_INVALID');

  const upstreamAuthFail = await get('/api/v1/me/contents?offset=97'); absorb(upstreamAuthFail);
  equal('上游鉴权失败映射为 401', upstreamAuthFail.status, 401);
  equal('上游鉴权失败错误码', (await upstreamAuthFail.json()).code, 'AUTH_REQUIRED');

  check('用户数据响应不含 oauth token', !JSON.stringify(contents1Body).includes('e2e-oauth-token'));
  check('用户数据响应不含 access secret', !JSON.stringify(contents1Body).includes('e2e-access-secret'));

  /* 6.6 登记路径可回调，旧路径仍作为别名存活 */
  const aliasCallback = await get('/api/v1/auth/callback?authorization_code=good-code&state=forged'); absorb(aliasCallback);
  equal('旧回调别名仍可用', aliasCallback.status, 302);
  equal('旧别名同样校验 state', new URL(aliasCallback.headers.get('location'), base).searchParams.get('auth_error'), 'OAUTH_STATE_INVALID');
  const unknownPath = await get('/auth/callbac');
  equal('拼错的回调路径仍 404', unknownPath.status, 404);

  /* 7. 同一 state 不可重放 */
  const replay = await get(`/auth/callback?authorization_code=good-code&state=${encodeURIComponent(state)}`); absorb(replay);
  equal('重放 state 被拒', new URL(replay.headers.get('location'), base).searchParams.get('auth_error'), 'OAUTH_STATE_INVALID');

  /* 7.5 代理转发 HTTPS 时应补上 Secure */
  const proxiedHeaders = { cookie: cookieHeader(), 'x-forwarded-proto': 'https' };
  const proxiedLogin = await get('/api/v1/auth/login', { headers: proxiedHeaders });
  const proxiedState = new URL(proxiedLogin.headers.get('location')).searchParams.get('state');
  const proxiedCallback = await get(`/auth/callback?authorization_code=good-code&state=${encodeURIComponent(proxiedState)}`, { headers: proxiedHeaders });
  const proxiedCookie = proxiedCallback.headers.getSetCookie().find(c => c.startsWith('cyby_session='));
  check('X-Forwarded-Proto=https 时会话 Cookie 带 Secure', Boolean(proxiedCookie) && proxiedCookie.includes('Secure'));

  /* 8. 退出 */
  const logout = await post('/api/v1/auth/logout'); absorb(logout);
  equal('退出返回 200', logout.status, 200);
  equal('退出清掉会话 Cookie', jar.get('cyby_session'), '');
  const meOut = await get('/api/v1/me'); absorb(meOut);
  equal('退出后 authenticated 为 false', (await meOut.json()).authenticated, false);
  const histOut = await get('/api/v1/me/history'); absorb(histOut);
  equal('退出后历史不可访问', histOut.status, 401);

  /* 9. 首页仍可正常访问 */
  const page = await fetch(base + '/'); absorb(page);
  const html = await page.text();
  equal('首页 200', page.status, 200);
  check('首页含用户控件', html.includes('id="user-slot"') && html.includes('id="user-login"'));
  check('CSP 放行知乎头像 CDN', page.headers.get('content-security-policy').includes('https://*.zhimg.com'));
} finally {
  app.kill('SIGTERM');
  provider.close();
  await new Promise(resolve => setTimeout(resolve, 300));
}

/* 10. 未配置 OAuth 的实例：登录入口应友好回跳，而不是把裸 JSON 摆给浏览器 */
{
  const portB = await freePort();
  const appB = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(portB),
      ZHIHU_DB_PATH: path.join(workspace, 'e2e-unconfigured.db'),
      ZHIHU_OAUTH_APP_ID: '',
      ZHIHU_OAUTH_APP_KEY: '',
      ZHIHU_OAUTH_REDIRECT_URI: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const baseB = `http://127.0.0.1:${portB}`;
    const healthB = await fetch(`${baseB}/api/v1/health`).then(response => response.json());
    equal('未配置实例 oauth 为 false', healthB.configured.oauth, false);
    const meB = await fetch(`${baseB}/api/v1/me`).then(response => response.json());
    equal('未配置实例仍返回 200 且未登录', meB.authenticated, false);
    const loginB = await fetch(`${baseB}/api/v1/auth/login`, { redirect: 'manual' });
    equal('未配置时登录入口返回 302', loginB.status, 302);
    const locationB = new URL(loginB.headers.get('location'), baseB);
    equal('未配置时回跳首页', locationB.pathname, '/');
    equal('未配置时带 OAUTH_NOT_CONFIGURED', locationB.searchParams.get('auth_error'), 'OAUTH_NOT_CONFIGURED');
    const pageB = await fetch(baseB + '/');
    equal('未配置实例首页仍可访问', pageB.status, 200);
  } finally {
    appB.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

await rm(workspace, { recursive: true, force: true });

if (failures.length) {
  process.stdout.write(`\n端到端失败 ${failures.length} 项 / 通过 ${passed} 项\n`);
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.stdout.write(`\n服务端日志：\n${appLog}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`端到端通过：${passed} 项\n`);
}
