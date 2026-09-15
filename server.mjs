import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildJourney, buildPrelude, classifyQuery, getHotList, initStore } from './core.mjs';
import * as oauth from './oauth.mjs';
import * as store from './db.mjs';
import * as zhihuUser from './zhihu-user.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const readPage = name => readFile(path.join(root, name));
// 默认只监听回环地址：生产环境前面放 nginx/Caddy 反代，应用不直接对外暴露。
// 只有在确实需要让应用自己监听公网时才改 HOST=0.0.0.0。
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || '';
/**
 * OAuth 回调路径。必须与知乎开放平台登记的 redirect_uri 完全一致——
 * 正式环境使用 /auth/callback；旧路径保留为别名，避免历史配置失效。
 */
const CALLBACK_PATHS = new Set(['/auth/callback', '/api/v1/auth/callback']);

const headers = type => ({
  'Content-Type': type,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // img-src 额外放行知乎头像 CDN（*.zhimg.com），其余来源仍只允许自身
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://unpkg.zhimg.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' https://unpkg.zhimg.com; img-src 'self' https://*.zhimg.com data:; frame-ancestors 'none'; base-uri 'none'",
});

async function sendFile(response, name, type, cacheControl = 'no-store') {
  const body = await readPage(name);
  response.writeHead(200, { ...headers(type), 'Cache-Control': cacheControl });
  response.end(body);
}

/** 追加而非覆盖 Set-Cookie，登录回调可能同时下发浏览器标识与会话标识。 */
function setCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  list.push(cookie);
  response.setHeader('Set-Cookie', list);
}

function json(request, response, status, value) {
  const responseHeaders = headers('application/json; charset=utf-8');
  if (frontendOrigin && request.headers.origin === frontendOrigin) {
    responseHeaders['Access-Control-Allow-Origin'] = frontendOrigin;
    responseHeaders['Access-Control-Allow-Credentials'] = 'true';
    responseHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
    responseHeaders['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    responseHeaders.Vary = 'Origin';
  }
  response.writeHead(status, responseHeaders);
  response.end(JSON.stringify(value));
}

function redirect(response, location, status = 302) {
  response.writeHead(status, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'INPUT_TOO_LARGE' });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('请求必须是 JSON'), { status: 400, code: 'INPUT_INVALID' }); }
}

/**
 * 判断本次请求是否要下发 Secure Cookie。
 * 依据真实连接与可信代理头，**不依据 redirect_uri**：否则拿局域网 IP 演示时
 * （http://192.168.x.x:3000/...）会被误判成 HTTPS，Cookie 被浏览器直接丢弃，登录静默失败。
 * 明文请求无法靠伪造 X-Forwarded-Proto 把 Secure 降下来。
 */
function requestIsSecure(request) {
  if (request.socket?.encrypted) return true;
  const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}

const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * 取得（必要时下发）匿名浏览器标识。它只用于把 OAuth state 绑定到发起登录的浏览器，
 * 不是登录态，也不含任何用户信息。
 */
function ensureBrowserId(request, response) {
  const jar = oauth.parseCookies(request.headers.cookie);
  const current = jar.get(oauth.cookieName('browser'));
  if (current && BROWSER_ID_PATTERN.test(current)) return current;
  const browserId = oauth.newToken(32);
  setCookie(response, oauth.serializeCookie(oauth.cookieName('browser'), browserId, {
    maxAge: oauth.BROWSER_COOKIE_MAX_AGE_SECONDS,
    secure: requestIsSecure(request),
  }));
  return browserId;
}

function currentSession(request) {
  const jar = oauth.parseCookies(request.headers.cookie);
  return oauth.currentSession(jar.get(oauth.cookieName('session')));
}

function requireSession(request, response) {
  const session = currentSession(request);
  if (!session) { json(request, response, 401, { error: '需要先登录知乎', code: 'AUTH_REQUIRED', actionUrl: '/api/v1/auth/login' }); return null; }
  return session;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, frontendOrigin && request.headers.origin === frontendOrigin ? {
        'Access-Control-Allow-Origin': frontendOrigin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      } : {});
      return response.end();
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return sendFile(response, 'index.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/curation.html') {
      return sendFile(response, 'curation.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && /^\/static\/journeys\/[a-z0-9-]+\.json$/.test(url.pathname)) {
      try {
        const body = await readPage(url.pathname.slice(1));
        const responseHeaders = headers('application/json; charset=utf-8');
        responseHeaders['Cache-Control'] = 'public, max-age=300';
        response.writeHead(200, responseHeaders);
        return response.end(body);
      } catch (error) {
        if (error.code === 'ENOENT') return json(request, response, 404, { error: '静态时间线不存在', code: 'NOT_FOUND' });
        throw error;
      }
    }
    if (request.method === 'GET' && url.pathname === '/zhihu-logo.png') {
      return sendFile(response, 'zhihu-logo.png', 'image/png');
    }
    if (request.method === 'GET' && url.pathname === '/assets/brand/logo-mark.png') {
      return sendFile(response, 'assets/brand/logo-mark.png', 'image/png', 'public, max-age=86400');
    }
    if (request.method === 'GET' && url.pathname === '/assets/brand/logo-mark.svg') {
      return sendFile(response, 'assets/brand/logo-mark.svg', 'image/svg+xml; charset=utf-8', 'public, max-age=86400');
    }
    if (request.method === 'GET' && url.pathname === '/assets/kan-shan-button.png') {
      return sendFile(response, 'assets/kan-shan-button.png', 'image/png', 'public, max-age=86400');
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/health') return json(request, response, 200, {
      status: 'ok',
      configured: { zhihu: Boolean(process.env.ZHIHU_ACCESS_SECRET), deepseek: Boolean(process.env.DEEPSEEK_API_KEY), oauth: oauth.oauthConfig().configured },
      database: { schemaVersion: store.SCHEMA_VERSION },
    });

    /* --------------------------------------------------------------- 认证 */
    if (request.method === 'GET' && url.pathname === '/api/v1/auth/login') {
      const browserId = ensureBrowserId(request, response);
      let authorizeUrl;
      try {
        ({ authorizeUrl } = oauth.startLogin(browserId));
      } catch (error) {
        // 未配置时也回跳首页走提示条，不把裸 JSON 摆给浏览器
        return redirect(response, `/?auth_error=${encodeURIComponent(error.code || 'OAUTH_FAILED')}`);
      }
      return redirect(response, authorizeUrl);
    }
    if (request.method === 'GET' && CALLBACK_PATHS.has(url.pathname)) {
      const browserId = ensureBrowserId(request, response);
      // 当前实测回调参数是 authorization_code；同时接受 code 以兼容协议修订
      const authorizationCode = url.searchParams.get('authorization_code') || url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      let result;
      try {
        result = await oauth.completeLogin({ authorizationCode, state, browserId });
      } catch (error) {
        // 只回传错误码，不把上游错误细节或任何凭证带进 URL
        return redirect(response, `/?auth_error=${encodeURIComponent(error.code || 'OAUTH_FAILED')}`);
      }
      setCookie(response, oauth.serializeCookie(oauth.cookieName('session'), result.sid, {
        maxAge: result.expiresIn,
        secure: requestIsSecure(request),
      }));
      return redirect(response, '/');
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
      const jar = oauth.parseCookies(request.headers.cookie);
      const removed = oauth.logout(jar.get(oauth.cookieName('session')));
      setCookie(response, oauth.clearCookie(oauth.cookieName('session'), { secure: requestIsSecure(request) }));
      return json(request, response, 200, { ok: true, removed });
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/me') {
      const session = currentSession(request);
      return json(request, response, 200, {
        authenticated: Boolean(session),
        oauthConfigured: oauth.oauthConfig().configured,
        user: session ? oauth.publicUser(session.user) : null,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/me/history') {
      const session = requireSession(request, response);
      if (!session) return;
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      return json(request, response, 200, { items: store.listHistory({ uid: session.user.uid, limit, offset }) });
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/me/history/clear') {
      const session = requireSession(request, response);
      if (!session) return;
      return json(request, response, 200, { ok: true, cleared: store.clearHistory(session.user.uid) });
    }
    // 用户数据接口：OAuth Token 只从服务端会话取，不接受前端传入
    if (request.method === 'GET' && url.pathname === '/api/v1/me/contents') {
      const session = requireSession(request, response);
      if (!session) return;
      return json(request, response, 200, await zhihuUser.listUserContents({
        uid: session.user.uid,
        oauthToken: session.oauthToken,
        offset: url.searchParams.get('offset') || 0,
        limit: url.searchParams.get('limit') || 20,
        contentType: url.searchParams.get('type') || 'all',
        sortField: url.searchParams.get('sort') || 'ts',
        sortOrder: url.searchParams.get('order') || 'desc',
        refresh: ['1', 'true'].includes(url.searchParams.get('refresh')),
      }));
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/me/followees') {
      const session = requireSession(request, response);
      if (!session) return;
      return json(request, response, 200, await zhihuUser.listUserFollowees({
        uid: session.user.uid,
        oauthToken: session.oauthToken,
        offset: url.searchParams.get('offset') || 0,
        limit: url.searchParams.get('limit') || 20,
        refresh: ['1', 'true'].includes(url.searchParams.get('refresh')),
      }));
    }

    /* --------------------------------------------------------------- 业务 */
    if (request.method === 'GET' && url.pathname === '/api/v1/hot') {
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const refresh = ['1', 'true'].includes(url.searchParams.get('refresh'));
      const result = await getHotList({ limit, refresh });
      const responseHeaders = headers('application/json; charset=utf-8');
      responseHeaders['Cache-Control'] = 'public, max-age=300';
      response.writeHead(200, responseHeaders);
      return response.end(JSON.stringify(result));
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/preflight') {
      const { query } = await readJson(request);
      return json(request, response, 200, await classifyQuery(query));
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/prelude') {
      const { query, stagePreference, retrieval } = await readJson(request);
      return json(request, response, 200, await buildPrelude(query, { stagePreference, retrieval }));
    }
    if (request.method === 'POST' && (url.pathname === '/api/search' || url.pathname === '/api/v1/journey')) {
      const { query, stagePreference, retrieval } = await readJson(request);
      const refresh = ['1', 'true'].includes(url.searchParams.get('refresh'));
      // 已登录时把检索历史记到该用户名下；未登录不写历史
      const session = currentSession(request);
      return json(request, response, 200, await buildJourney(query, { refresh, stagePreference, retrieval, uid: session?.user?.uid || '' }));
    }
    return json(request, response, 404, { error: '接口不存在', code: 'NOT_FOUND' });
  } catch (error) {
    const status = error.status || 500;
    return json(request, response, status, {
      error: status === 500 ? '服务内部错误' : (error.message || '未知错误'),
      code: error.code || 'INTERNAL',
    });
  }
});

let storeInfo;
try {
  storeInfo = initStore();
} catch (error) {
  process.stderr.write(`数据库初始化失败：${error.message}\n`);
  process.exit(1);
}

server.listen(port, host, () => {
  const imported = storeInfo.imported;
  const importNote = imported.journey || imported.hot ? `，已从旧 JSON 缓存导入 时间线 ${imported.journey} 条 / 热搜 ${imported.hot} 条` : '';
  process.stdout.write(`知乎观点检索：http://${host}:${port}/\n`);
  process.stdout.write(`SQLite：${storeInfo.path}（schema v${storeInfo.schemaVersion}${importNote}）\n`);
  if (!oauth.oauthConfig().configured) process.stdout.write('知乎登录未启用：缺少 ZHIHU_OAUTH_APP_ID / ZHIHU_OAUTH_APP_KEY / ZHIHU_OAUTH_REDIRECT_URI\n');
});
