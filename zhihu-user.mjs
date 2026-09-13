/**
 * 知乎开放平台「用户数据 API」客户端：创作列表、关注列表。
 *
 * 身份模型（照抄接口文档）：代表已授权用户访问时两个凭证缺一不可——
 * - `Authorization: Bearer <Access Secret>` 鉴权调用方；
 * - `X-OAuth-Token: <用户 OAuth access token>` 指明当前代表哪个用户。
 * OAuth Token 只从服务端会话读取，绝不接受前端传入，也不出现在响应里。
 *
 * 额度：本组接口共用 `user_data` 额度（默认每日 100 次），整页响应会进 SQLite 缓存，
 * 避免「加载更多」来回翻页时重复消耗。
 */
import crypto from 'node:crypto';
import * as store from './db.mjs';

const DEFAULT_BASE = 'https://developer.zhihu.com';
const TTL_DEFAULT_MS = 600000; // 10 分钟
const MAX_LIMIT = 50;
const CONTENT_TYPES = new Set(['all', 'answer', 'article', 'zvideo', 'pin', 'question']);
const SORT_FIELDS = new Set(['ts', 'like_count']);
const SORT_ORDERS = new Set(['asc', 'desc']);

const apiBase = () => (process.env.ZHIHU_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

function fail(message, status = 400, code = status >= 500 ? 'UPSTREAM_ERROR' : 'INPUT_INVALID') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}

function cacheTtl() {
  const raw = process.env.USER_API_CACHE_TTL_MS;
  const value = raw === undefined || raw === '' ? TTL_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(value)) return TTL_DEFAULT_MS;
  return value > 0 ? value : 0;
}

export function userApiCacheTtl() { return cacheTtl(); }

/* ------------------------------------------------------------------ 规范化 */

function plainText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function count(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0; }

function secondsToIso(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : '';
}

/** 页面只展示知乎自己的 HTTPS 链接；不符合的留空，由前端渲染成纯文本。 */
function safeZhihuUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return '';
    return url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com') ? url.href : '';
  } catch { return ''; }
}

/** 头像只接受知乎图床，避免把任意第三方地址渲染进页面。 */
function safeZhimgUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return '';
    return url.hostname === 'zhimg.com' || url.hostname.endsWith('.zhimg.com') ? url.href : '';
  } catch { return ''; }
}

/**
 * 响应里的 NextOffset 是字符串，但要按 Int64 语义使用。
 * 解析失败按协议错误处理，不静默截断、也不转成 Number 丢精度。
 */
function strictOffset(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!/^\d{1,19}$/.test(text)) fail('分页偏移量不是合法的 Int64', 502, 'ZHIHU_PAGING_INVALID');
  return text;
}

function normalizePaging(raw) {
  if (!raw || typeof raw !== 'object') return { isEnd: true, nextOffset: null, totals: null, incomplete: false };
  const totals = Number.isFinite(Number(raw.Totals)) ? Number(raw.Totals) : null;
  const isEnd = raw.IsEnd !== false;
  if (isEnd) return { isEnd: true, nextOffset: null, totals, incomplete: false };
  const nextOffset = strictOffset(raw.NextOffset);
  // IsEnd=false 却没有 NextOffset：分页信息不完整，前端必须停止翻页而不是自己猜偏移量
  return { isEnd: false, nextOffset, totals, incomplete: nextOffset === null };
}

export function normalizeContentItem(raw) {
  return {
    contentType: String(raw?.ContentType || ''),
    url: safeZhihuUrl(raw?.Url),
    title: plainText(raw?.Title).slice(0, 200),
    summary: plainText(raw?.Summary).slice(0, 300),
    createdAt: Number(raw?.CreatedAt) || 0,
    createdAtIso: secondsToIso(raw?.CreatedAt),
    likeCount: count(raw?.LikeCount),
    commentCount: count(raw?.CommentCount),
    favoriteCount: count(raw?.FavoriteCount),
  };
}

export function normalizeFolloweeItem(raw) {
  return {
    fullname: plainText(raw?.Fullname).slice(0, 120),
    urlToken: String(raw?.UrlToken || ''),
    url: safeZhihuUrl(raw?.Url),
    avatarUrl: safeZhimgUrl(raw?.AvatarUrl),
    headline: plainText(raw?.Headline).slice(0, 200),
    gender: Number(raw?.Gender) || 0,
    followerCount: count(raw?.FollowerCount),
  };
}

/* -------------------------------------------------------------------- 请求 */

const CODE_HINTS = { 10001: '参数错误', 20001: '鉴权失败', 30001: '频率限制', 30002: '配额限制', 90001: '内部错误' };

function pageCacheKey(endpoint, params) {
  return crypto.createHash('sha256').update(JSON.stringify([endpoint, params])).digest('hex');
}

async function callUserApi(endpoint, params, { uid, oauthToken, refresh = false }) {
  const secret = process.env.ZHIHU_ACCESS_SECRET;
  if (!secret) fail('缺少 ZHIHU_ACCESS_SECRET', 503, 'CONFIG_MISSING');
  if (!oauthToken) fail('没有可用的知乎授权，请重新登录', 401, 'AUTH_REQUIRED');

  const ttlMs = cacheTtl();
  const cacheKey = pageCacheKey(endpoint, params);
  if (ttlMs > 0 && !refresh) {
    try {
      const hit = store.readUserApiCache({ uid, cacheKey, ttlMs });
      if (hit) return { ...hit.payload, cached: true, fetchedAt: hit.fetchedAt };
    } catch { /* 缓存读失败照常回源 */ }
  }

  const url = new URL(`${apiBase()}/api/v1/user/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-OAuth-Token': oauthToken,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(Number(process.env.ZHIHU_TIMEOUT_MS) || 30000),
    });
  } catch (error) {
    fail(`知乎用户数据网络请求失败：${error.message}`, 502, 'ZHIHU_NETWORK_ERROR');
  }

  const body = await response.json().catch(() => ({}));
  const code = Number(body?.Code);
  if (!response.ok || code !== 0) {
    const hint = CODE_HINTS[code] || body?.Message || response.status;
    if (code === 20001) fail(`知乎用户数据鉴权失败：${hint}`, 401, 'AUTH_REQUIRED');
    if (code === 30001) fail(`知乎用户数据频率限制：${hint}`, 429, 'RATE_LIMITED');
    if (code === 30002) fail(`知乎用户数据配额已用尽：${hint}`, 429, 'QUOTA_EXCEEDED');
    fail(`知乎用户数据接口失败：${hint}`, 502, 'ZHIHU_USER_API_FAILED');
  }

  const data = body.Data || {};
  const payload = {
    items: Array.isArray(data.Items) ? data.Items : [],
    paging: normalizePaging(data.Paging),
  };
  // 只缓存成功结果；鉴权失败、限流、配额问题都不写缓存
  if (ttlMs > 0) {
    try { store.writeUserApiCache({ uid, endpoint, cacheKey, payload }); } catch { /* 缓存写失败不影响返回 */ }
  }
  return { ...payload, cached: false, fetchedAt: Date.now() };
}

function normalizePage(result, mapper) {
  return {
    items: result.items.map(mapper).filter(item => item && (item.title || item.fullname || item.url)),
    paging: result.paging,
    cached: Boolean(result.cached),
    fetchedAt: result.fetchedAt,
  };
}

/** 创作列表。ContentType 是必填参数，缺省取 all。 */
export async function listUserContents({ uid, oauthToken, offset = 0, limit = 20, contentType = 'all', sortField = 'ts', sortOrder = 'desc', refresh = false } = {}) {
  if (!CONTENT_TYPES.has(contentType)) fail('ContentType 只能是 all、answer、article、zvideo、pin 或 question');
  if (!SORT_FIELDS.has(sortField)) fail('SortField 只能是 ts 或 like_count');
  if (!SORT_ORDERS.has(sortOrder)) fail('SortOrder 只能是 asc 或 desc');
  const params = { ContentType: contentType, SortField: sortField, SortOrder: sortOrder, Offset: normalizeOffset(offset), Limit: normalizeLimit(limit) };
  return normalizePage(await callUserApi('contents', params, { uid, oauthToken, refresh }), normalizeContentItem);
}

/** 关注的人。 */
export async function listUserFollowees({ uid, oauthToken, offset = 0, limit = 20, refresh = false } = {}) {
  const params = { Offset: normalizeOffset(offset), Limit: normalizeLimit(limit) };
  return normalizePage(await callUserApi('followees', params, { uid, oauthToken, refresh }), normalizeFolloweeItem);
}

/** Offset 必须原样透传服务端给的值，只校验形态，不自行换算。 */
function normalizeOffset(value) {
  const text = String(value ?? '0').trim() || '0';
  if (!/^\d{1,19}$/.test(text)) fail('offset 必须是非负整数');
  return text;
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}
