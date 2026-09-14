/**
 * 知乎黑客松 OAuth：授权跳转、state 校验、换取 token、读取授权用户基础信息、应用会话。
 *
 * 安全边界（照抄接入文档的要求）：
 * - app_key 与 OAuth access token 只存在于后端与 SQLite，绝不进入前端、URL、日志或接口响应。
 * - state 使用密码学安全随机数，绑定发起登录的浏览器，短时有效且只能消费一次。
 * - 只做知乎登录与基础信息，不读取邮箱、手机号；接口返回也一律不落库。
 * - token 失效即停止读取，不静默切换到 Access Secret 所属账号。
 */
import crypto from 'node:crypto';
import * as store from './db.mjs';

const DEFAULT_BASE = 'https://openapi.zhihu.com';
const STATE_TTL_DEFAULT_MS = 600000; // 10 分钟，够用户完成一次授权页确认
const BROWSER_COOKIE_MAX_AGE = 2592000; // 30 天，仅用于绑定登录请求

const baseUrl = () => (process.env.ZHIHU_OAUTH_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

/** OAuth 是否已具备发起登录的最小配置。缺 app_id / app_key / redirect_uri 时前端只显示提示。 */
export function oauthConfig() {
  const appId = process.env.ZHIHU_OAUTH_APP_ID || '';
  const appKey = process.env.ZHIHU_OAUTH_APP_KEY || '';
  const redirectUri = process.env.ZHIHU_OAUTH_REDIRECT_URI || '';
  return {
    appId,
    appKey,
    redirectUri,
    configured: Boolean(appId && appKey && redirectUri),
    authorizeUrl: `${baseUrl()}/authorize`,
    tokenUrl: `${baseUrl()}/access_token`,
    profileUrl: `${baseUrl()}/user`,
  };
}

export function cookieName(kind) {
  if (kind === 'browser') return process.env.CYBY_BROWSER_COOKIE || 'cyby_browser';
  return process.env.CYBY_SESSION_COOKIE || 'cyby_session';
}

export function newToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

/* ------------------------------------------------------------------ Cookie */

export function parseCookies(header) {
  const jar = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try { jar.set(name, decodeURIComponent(part.slice(index + 1).trim())); } catch { /* 忽略非法编码 */ }
  }
  return jar;
}

export function serializeCookie(name, value, { maxAge, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name, { secure }) { return serializeCookie(name, '', { maxAge: 0, secure }); }

/* ------------------------------------------------------------ state 与登录 */

/** 生成 state 并入库，返回可直接跳转的授权地址。 */
export function startLogin(browserId) {
  const config = oauthConfig();
  if (!config.configured) {
    const error = new Error('未配置知乎 OAuth：需要 ZHIHU_OAUTH_APP_ID、ZHIHU_OAUTH_APP_KEY 与 ZHIHU_OAUTH_REDIRECT_URI');
    error.status = 503;
    error.code = 'OAUTH_NOT_CONFIGURED';
    throw error;
  }
  const ttl = Number(process.env.ZHIHU_OAUTH_STATE_TTL_MS) || STATE_TTL_DEFAULT_MS;
  const state = newToken(32);
  store.saveOAuthState({ state, sid: browserId, ttlMs: ttl });
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('app_id', config.appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { authorizeUrl: url.href, state, expiresInMs: ttl };
}

function oauthFail(message, status, code) { const error = new Error(message); error.status = status; error.code = code; throw error; }

/**
 * 用授权码换取 access token。
 * 文档记录：业务字段 code: 20000 表示成功，不能把所有非零 code 当失败，因此优先看 access_token 是否存在。
 */
export async function exchangeCode(code) {
  const config = oauthConfig();
  const form = new URLSearchParams({
    app_id: config.appId,
    app_key: config.appKey,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
    code,
  });
  let response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(Number(process.env.ZHIHU_OAUTH_TIMEOUT_MS) || 30000),
    });
  } catch (error) {
    oauthFail(`知乎 OAuth 换取 token 网络失败：${error.message}`, 502, 'OAUTH_NETWORK_ERROR');
  }
  const body = await response.json().catch(() => ({}));
  const token = body?.access_token;
  if (!response.ok || typeof token !== 'string' || !token) {
    oauthFail(`知乎 OAuth 换取 token 失败：${body?.error_description || body?.error || body?.message || response.status}`, 502, 'OAUTH_TOKEN_FAILED');
  }
  return { accessToken: token, tokenType: String(body.token_type || 'Bearer'), expiresIn: Number(body.expires_in) || 3600 };
}

/**
 * 无损解析 uid。
 * /user 返回的 uid 是 int64，可能超过 Number.MAX_SAFE_INTEGER；先解析成 Number 再转字符串会静默丢精度，
 * 所以在 JSON.parse 之前把 "uid": <数字> 改写为字符串字面量。
 */
export function parseProfileJson(text) {
  return JSON.parse(String(text).replace(/("uid"\s*:\s*)(\d+)/gi, '$1"$2"'));
}

export function normalizeProfile(raw) {
  const uid = raw?.uid === undefined || raw?.uid === null ? '' : String(raw.uid);
  if (!uid) return null;
  const text = (value, max) => String(value ?? '').slice(0, max);
  return {
    uid,
    hashId: text(raw.hash_id, 128),
    fullname: text(raw.fullname, 120),
    gender: text(raw.gender, 16),
    headline: text(raw.headline, 300),
    description: text(raw.description, 1000),
    avatarPath: text(raw.avatar_path, 500),
    profileUrl: text(raw.url, 500),
  };
}

/** 读取授权用户基础信息。只取登录所需字段，email / phone_no 不读取也不落库。 */
export async function fetchProfile(accessToken) {
  const config = oauthConfig();
  let response;
  try {
    response = await fetch(config.profileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(Number(process.env.ZHIHU_OAUTH_TIMEOUT_MS) || 30000),
    });
  } catch (error) {
    oauthFail(`知乎用户信息网络请求失败：${error.message}`, 502, 'OAUTH_NETWORK_ERROR');
  }
  const text = await response.text().catch(() => '');
  let body; try { body = parseProfileJson(text); } catch { oauthFail('知乎用户信息返回无法解析', 502, 'OAUTH_INVALID'); }
  // HTTP 200 也可能是 {"code":404,"data":"User don't exist"}，必须确认拿到有效用户标识。
  const profile = normalizeProfile(body);
  if (!response.ok || !profile) {
    oauthFail(`知乎用户信息读取失败：${body?.data || body?.message || response.status}`, 502, 'OAUTH_PROFILE_FAILED');
  }
  return profile;
}

/**
 * 完整回调处理：先原子消费 state，再换 token、拉取用户、建立会话。
 * state 校验失败时立即拒绝，且不发起任何后续请求。
 */
export async function completeLogin({ authorizationCode, state, browserId }) {
  if (!authorizationCode) oauthFail('回调缺少 authorization_code', 400, 'OAUTH_CALLBACK_INVALID');
  if (!state) oauthFail('回调缺少 state，无法校验请求关联性', 400, 'OAUTH_STATE_MISSING');
  const consumed = store.consumeOAuthState({ state, sid: browserId });
  if (!consumed.ok) oauthFail(`state 校验失败（${consumed.reason}）`, 400, 'OAUTH_STATE_INVALID');

  const token = await exchangeCode(authorizationCode);
  const raw = await fetchProfile(token.accessToken);
  const user = store.upsertUser(raw);
  const sid = newToken(32);
  store.createSession({ sid, uid: user.uid, oauthToken: token.accessToken, expiresInSeconds: token.expiresIn });
  return { sid, user: publicUser(user), expiresIn: token.expiresIn };
}

/** 对外暴露的用户对象：不含任何 token、邮箱或手机号。 */
export function publicUser(user) {
  if (!user) return null;
  return {
    uid: user.uid,
    fullname: user.fullname,
    headline: user.headline,
    avatarPath: user.avatarPath,
    profileUrl: user.profileUrl,
  };
}

export function logout(sid) { return store.destroySession(sid); }

export function currentSession(sid) { return store.getSession(sid); }

export function cleanup() {
  const sessions = store.purgeExpiredSessions();
  const states = store.purgeExpiredOAuthStates();
  return { sessions, states };
}

export const BROWSER_COOKIE_MAX_AGE_SECONDS = BROWSER_COOKIE_MAX_AGE;
