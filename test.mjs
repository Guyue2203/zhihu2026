/**
 * 持久层与 OAuth 的自检。不访问任何外部网络：OAuth 通过本地 mock 服务端完成。
 * 运行：node test.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as store from './db.mjs';
import * as oauth from './oauth.mjs';
import * as zhihuUser from './zhihu-user.mjs';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** uid 超出 Number.MAX_SAFE_INTEGER：先解析成 Number 再转字符串会丢精度。 */
const BIG_UID = '969570047710216200';
const BIG_UID_TEXT = `{"uid":${BIG_UID},"hash_id":"0e4f7a","fullname":"测试用户","gender":"male","headline":"一句话介绍","description":"详细描述","avatar_path":"https://picx.zhimg.com/x.jpg","url":"https://openapi.zhihu.com/users/${BIG_UID}","email":"a@b.c","phone_no":"13800000000"}`;

async function mockZhihuServer() {
  const seen = { tokenRequests: 0, profileRequests: 0, lastTokenForm: null, lastAuthHeader: '' };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/access_token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      seen.tokenRequests += 1;
      seen.lastTokenForm = new URLSearchParams(body);
      if (seen.lastTokenForm.get('code') !== 'good-code') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: 'invalid_grant', error_description: '授权码无效' }));
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // 业务字段 code 为 20000，文档说明这也是成功，不能被当成错误
      return response.end(JSON.stringify({ access_token: 'oauth-token-abc', token_type: 'Bearer', expires_in: 3600, code: 20000 }));
    }
    if (request.method === 'GET' && url.pathname === '/user') {
      seen.profileRequests += 1;
      seen.lastAuthHeader = String(request.headers.authorization || '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(BIG_UID_TEXT);
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    return response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zhihu-store-test-'));
  process.env.ZHIHU_DATA_DIR = workspace;
  process.env.ZHIHU_DB_PATH = path.join(workspace, 'app.db');

  /* ------------------------------------------------------------ 建库与迁移 */
  const db = store.getDb();
  equal('schema version 与迁移数量一致', Number(db.prepare('PRAGMA user_version').get().user_version), store.SCHEMA_VERSION);
  equal('WAL 已开启', String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  equal('外键约束已开启', Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  for (const table of ['journey_cache', 'hot_cache', 'users', 'sessions', 'oauth_states', 'journey_history', 'user_api_cache', 'journey_records']) {
    check(`表 ${table} 已建立`, tables.includes(table));
  }
  store.getDb();
  equal('重复 getDb 不会重复建表', db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, tables.length);

  /* ------------------------------------------------------------ 无损 uid */
  const parsed = oauth.parseProfileJson(BIG_UID_TEXT);
  equal('uid 无损解析为字符串', parsed.uid, BIG_UID);
  check('uid 未被解析成 Number', typeof parsed.uid === 'string');
  // 对照：两个相邻 int64 经朴素 JSON.parse 会折叠成同一个 double，说明精度确实丢失
  const naiveA = JSON.parse('{"uid":969570047710216201}').uid;
  const naiveB = JSON.parse('{"uid":969570047710216200}').uid;
  check('朴素 JSON.parse 把相邻 int64 折叠成同一个数（对照）', naiveA === naiveB, `得到 ${naiveA} 与 ${naiveB}`);
  equal('无损解析可区分相邻 int64', oauth.parseProfileJson('{"uid":969570047710216201}').uid, '969570047710216201');
  const profile = oauth.normalizeProfile(parsed);
  equal('normalizeProfile 保留 uid', profile.uid, BIG_UID);
  equal('normalizeProfile 丢弃邮箱', Object.hasOwn(profile, 'email'), false);
  equal('normalizeProfile 丢弃手机号', Object.hasOwn(profile, 'phoneNo'), false);
  equal('缺少 uid 时返回 null', oauth.normalizeProfile({ fullname: '无 id' }), null);

  /* ---------------------------------------------------------------- 用户 */
  const user = store.upsertUser(profile);
  equal('用户落库', user.uid, BIG_UID);
  equal('用户昵称落库', user.fullname, '测试用户');
  store.upsertUser({ ...profile, fullname: '改过的昵称' });
  equal('重复 upsert 不新增行', store.countUsers(), 1);
  equal('重复 upsert 更新字段', store.getUser(BIG_UID).fullname, '改过的昵称');
  equal('读取不存在的用户返回 null', store.getUser('no-such-uid'), null);

  /* ---------------------------------------------------------------- 会话 */
  const created = store.createSession({ sid: 'sid-a', uid: BIG_UID, oauthToken: 'oauth-token-abc', expiresInSeconds: 3600 });
  check('会话过期时间晚于当前', created.expiresAt > Date.now());
  const session = store.getSession('sid-a');
  equal('会话可读回', session?.user?.uid, BIG_UID);
  equal('会话持有 oauth token（仅服务端）', session?.oauthToken, 'oauth-token-abc');
  const exposed = oauth.publicUser(store.getUser(BIG_UID));
  equal('对外用户对象不含 oauth token', Object.hasOwn(exposed, 'oauthToken'), false);
  equal('对外用户对象不含 token', Object.hasOwn(exposed, 'token'), false);
  equal('对外用户对象不含邮箱', Object.hasOwn(exposed, 'email'), false);
  equal('读取不存在的会话返回 null', store.getSession('nope'), null);
  equal('空 sid 返回 null', store.getSession(''), null);
  store.getDb().prepare('UPDATE sessions SET token_expires_at = ? WHERE sid = ?').run(Date.now() - 1000, 'sid-a');
  equal('过期会话读取被拒', store.getSession('sid-a'), null);
  equal('过期会话被顺手清理', store.getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  store.createSession({ sid: 'sid-b', uid: BIG_UID, oauthToken: 't', expiresInSeconds: 3600 });
  equal('logout 删除会话', oauth.logout('sid-b'), 1);
  equal('logout 后会话不存在', store.getSession('sid-b'), null);
  equal('logout 不存在的会话返回 0', oauth.logout('sid-b'), 0);

  /* ---------------------------------------------------------- OAuth state */
  store.saveOAuthState({ state: 'st-ok', sid: 'browser-1', ttlMs: 600000 });
  equal('正确 state 可消费', store.consumeOAuthState({ state: 'st-ok', sid: 'browser-1' }).ok, true);
  equal('重复消费被拒', store.consumeOAuthState({ state: 'st-ok', sid: 'browser-1' }).reason, 'replayed');
  equal('未知 state 被拒', store.consumeOAuthState({ state: 'st-none', sid: 'browser-1' }).reason, 'unknown');
  store.saveOAuthState({ state: 'st-sess', sid: 'browser-1', ttlMs: 600000 });
  equal('其他浏览器会话不能复用', store.consumeOAuthState({ state: 'st-sess', sid: 'browser-2' }).reason, 'session_mismatch');
  equal('会话不匹配后仍可被正确会话消费', store.consumeOAuthState({ state: 'st-sess', sid: 'browser-1' }).ok, true);
  store.saveOAuthState({ state: 'st-old', sid: 'browser-1', ttlMs: -1000 });
  equal('过期 state 被拒', store.consumeOAuthState({ state: 'st-old', sid: 'browser-1' }).reason, 'expired');

  /* ---------------------------------------------------------------- 历史 */
  store.recordHistory({ uid: BIG_UID, query: '共享单车为什么失败', preference: 'default', source: 'zhihu', cacheKey: 'k1', title: '共享单车' });
  store.recordHistory({ uid: BIG_UID, query: '元宇宙为什么退潮', preference: 'more', source: 'model', cacheKey: 'k2', title: '元宇宙' });
  const history = store.listHistory({ uid: BIG_UID });
  equal('历史记录条数', history.length, 2);
  equal('历史按时间倒序返回最新一条', history[0].query, '元宇宙为什么退潮');
  check('历史带 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(history[0].createdAtIso));
  equal('历史分页 limit', store.listHistory({ uid: BIG_UID, limit: 1 }).length, 1);
  equal('历史分页 offset', store.listHistory({ uid: BIG_UID, offset: 1 })[0].query, '共享单车为什么失败');
  equal('其他用户看不到该历史', store.listHistory({ uid: 'other' }).length, 0);
  equal('清空历史', store.clearHistory(BIG_UID), 2);
  equal('清空后为空', store.listHistory({ uid: BIG_UID }).length, 0);
  // 级联：删用户要连带清掉历史和会话
  store.recordHistory({ uid: BIG_UID, query: 'q', preference: 'default', source: 'zhihu', cacheKey: 'k', title: '' });
  store.createSession({ sid: 'sid-c', uid: BIG_UID, oauthToken: 't', expiresInSeconds: 3600 });
  store.getDb().prepare('DELETE FROM users WHERE uid = ?').run(BIG_UID);
  equal('删除用户级联清理历史', store.getDb().prepare('SELECT COUNT(*) AS n FROM journey_history').get().n, 0);
  equal('删除用户级联清理会话', store.getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  /* ------------------------------------------------------ 缓存版本与 TTL */
  store.writeJourneyCache({ cacheKey: 'ck', query: 'q', preference: 'default', source: 'zhihu', version: 2, result: { title: 't' } });
  equal('缓存命中', store.readJourneyCache('ck', { version: 2, ttlMs: 1000 })?.title, 't');
  equal('版本不符未命中', store.readJourneyCache('ck', { version: 3, ttlMs: 1000 }), null);
  equal('TTL 为 0 时停用', store.readJourneyCache('ck', { version: 2, ttlMs: 0 }), null);
  store.getDb().prepare('UPDATE journey_cache SET fetched_at = ? WHERE cache_key = ?').run(Date.now() - 5000, 'ck');
  equal('超期未命中', store.readJourneyCache('ck', { version: 2, ttlMs: 1000 }), null);
  store.writeJourneyCache({ cacheKey: 'ck', query: 'q', preference: 'default', source: 'zhihu', version: 2, result: { title: 'updated' } });
  equal('同键覆写而非新增', store.getDb().prepare('SELECT COUNT(*) AS n FROM journey_cache WHERE cache_key = ?').get('ck').n, 1);

  const recordId = store.appendJourneyRecord({ cacheKey: 'ck', query: 'q', preference: 'default', source: 'zhihu', version: 3, payload: { journey: { title: '永久记录' }, plan: { stages: [] }, candidates: [] } });
  equal('永久记录写入', store.countJourneyRecords(), 1);
  equal('永久记录可读回', store.getJourneyRecord(recordId)?.payload?.journey?.title, '永久记录');
  check('永久记录带 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(store.getJourneyRecord(recordId)?.createdAtIso || ''));
  store.pruneJourneyCache({ ttlMs: 1, keep: 0 });
  equal('清理缓存不删除永久记录', store.countJourneyRecords(), 1);

  store.writeHotCache({ bucket: 20, version: 2, items: [{ title: '热搜' }] });
  equal('热搜缓存命中', store.readHotCache(20, { version: 2, ttlMs: 1000 })?.items[0].title, '热搜');
  equal('热搜档位隔离', store.readHotCache(10, { version: 2, ttlMs: 1000 }), null);

  /* ------------------------------------------ 用户数据接口规范化与分页缓存 */
  equal('创作非知乎域名链接被清空', zhihuUser.normalizeContentItem({ Url: 'https://evil.example.com/x', Title: 't' }).url, '');
  equal('创作非 HTTPS 链接被清空', zhihuUser.normalizeContentItem({ Url: 'http://www.zhihu.com/answer/1' }).url, '');
  equal('创作合法知乎链接保留', zhihuUser.normalizeContentItem({ Url: 'https://zhuanlan.zhihu.com/p/1' }).url, 'https://zhuanlan.zhihu.com/p/1');
  equal('创作摘要剥离 HTML 标签', zhihuUser.normalizeContentItem({ Summary: '<em>强调</em> 正文' }).summary, '强调 正文');
  equal('创作计数负数归零', zhihuUser.normalizeContentItem({ LikeCount: -5 }).likeCount, 0);
  equal('创作时间转为 ISO', zhihuUser.normalizeContentItem({ CreatedAt: 1789000000 }).createdAtIso, new Date(1789000000 * 1000).toISOString());
  equal('头像非知乎图床被清空', zhihuUser.normalizeFolloweeItem({ AvatarUrl: 'https://evil.example.com/a.jpg' }).avatarUrl, '');
  equal('头像 zhimg 子域放行', zhihuUser.normalizeFolloweeItem({ AvatarUrl: 'https://picx.zhimg.com/a.jpg' }).avatarUrl, 'https://picx.zhimg.com/a.jpg');
  equal('关注人主页链接校验', zhihuUser.normalizeFolloweeItem({ Url: 'https://www.zhihu.com/people/x' }).url, 'https://www.zhihu.com/people/x');
  equal('关注人非知乎主页被清空', zhihuUser.normalizeFolloweeItem({ Url: 'https://example.com/people/x' }).url, '');

  // 这些校验必须在发起网络请求之前就失败
  let badContentType = null;
  try { await zhihuUser.listUserContents({ uid: 'u', oauthToken: 't', contentType: 'bogus' }); } catch (error) { badContentType = error; }
  equal('非法 ContentType 被拒', badContentType?.code, 'INPUT_INVALID');
  let badSortField = null;
  try { await zhihuUser.listUserContents({ uid: 'u', oauthToken: 't', sortField: 'bogus' }); } catch (error) { badSortField = error; }
  equal('非法 SortField 被拒', badSortField?.code, 'INPUT_INVALID');
  let badSortOrder = null;
  try { await zhihuUser.listUserContents({ uid: 'u', oauthToken: 't', sortOrder: 'bogus' }); } catch (error) { badSortOrder = error; }
  equal('非法 SortOrder 被拒', badSortOrder?.code, 'INPUT_INVALID');
  let badOffset = null;
  try { await zhihuUser.listUserFollowees({ uid: 'u', oauthToken: 't', offset: 'abc' }); } catch (error) { badOffset = error; }
  equal('非法 offset 被拒', badOffset?.code, 'INPUT_INVALID');
  // 凭证缺失的两种形态：先看服务端配置，再看用户会话
  const savedSecret = process.env.ZHIHU_ACCESS_SECRET;
  process.env.ZHIHU_ACCESS_SECRET = 'test-access-secret';
  let missingToken = null;
  try { await zhihuUser.listUserFollowees({ uid: 'u', oauthToken: '' }); } catch (error) { missingToken = error; }
  equal('缺 OAuth Token 被拒', missingToken?.code, 'AUTH_REQUIRED');
  delete process.env.ZHIHU_ACCESS_SECRET;
  let missingSecret = null;
  try { await zhihuUser.listUserFollowees({ uid: 'u', oauthToken: 't' }); } catch (error) { missingSecret = error; }
  equal('缺 Access Secret 被拒', missingSecret?.code, 'CONFIG_MISSING');
  if (savedSecret !== undefined) process.env.ZHIHU_ACCESS_SECRET = savedSecret;

  store.writeUserApiCache({ uid: BIG_UID, endpoint: 'contents', cacheKey: 'uck', payload: { items: [{ title: 'x' }], paging: { isEnd: true } } });
  equal('用户数据缓存命中', store.readUserApiCache({ uid: BIG_UID, cacheKey: 'uck', ttlMs: 1000 })?.payload.items[0].title, 'x');
  equal('用户数据缓存按 uid 隔离', store.readUserApiCache({ uid: 'other', cacheKey: 'uck', ttlMs: 1000 }), null);
  equal('用户数据缓存 TTL 为 0 时停用', store.readUserApiCache({ uid: BIG_UID, cacheKey: 'uck', ttlMs: 0 }), null);
  store.getDb().prepare('UPDATE user_api_cache SET fetched_at = ? WHERE cache_key = ?').run(Date.now() - 5000, 'uck');
  equal('用户数据缓存超期未命中', store.readUserApiCache({ uid: BIG_UID, cacheKey: 'uck', ttlMs: 1000 }), null);
  store.writeUserApiCache({ uid: BIG_UID, endpoint: 'contents', cacheKey: 'uck2', payload: { items: [], paging: { isEnd: true } } });
  check('清空指定用户缓存返回条数', store.clearUserApiCache(BIG_UID) >= 1);
  equal('清空后 uck 不可读', store.readUserApiCache({ uid: BIG_UID, cacheKey: 'uck', ttlMs: 999999 }), null);
  equal('清空后 uck2 不可读', store.readUserApiCache({ uid: BIG_UID, cacheKey: 'uck2', ttlMs: 999999 }), null);

  /* ------------------------------------------------- 旧 JSON 缓存导入 */
  const legacyJourney = path.join(workspace, 'legacy', 'journey');
  const legacyHot = path.join(workspace, 'legacy', 'hot');
  await mkdir(legacyJourney, { recursive: true });
  await mkdir(legacyHot, { recursive: true });
  await writeFile(path.join(legacyJourney, '旧问题-abc123.json'), JSON.stringify({
    version: 2, query: '旧问题', preference: 'default', source: 'zhihu',
    fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
    result: { query: '旧问题', title: '旧缓存标题', stages: [{ id: 'stage-1' }], posts: [] },
  }));
  await writeFile(path.join(legacyJourney, '坏文件.json'), '{ 不是 JSON');
  await writeFile(path.join(legacyHot, 'list.json'), JSON.stringify({
    version: 2, limit: 20, fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(), items: [{ title: '旧热搜' }],
  }));
  const importDb = path.join(workspace, 'import.db');
  store.closeDb();
  process.env.ZHIHU_DB_PATH = importDb;
  const report = store.importLegacyJsonCache({
    journeyDir: legacyJourney, hotDir: legacyHot,
    readJourneyKey: (query, preference, source) => `${query}|${preference}|${source}`,
  });
  equal('导入 1 条时间线缓存', report.journey, 1);
  equal('导入 1 条热搜缓存', report.hot, 1);
  equal('损坏文件被跳过且不影响其余导入', store.readJourneyCache('旧问题|default|zhihu', { version: 2, ttlMs: 60000 })?.title, '旧缓存标题');
  const second = store.importLegacyJsonCache({
    journeyDir: legacyJourney, hotDir: legacyHot,
    readJourneyKey: (query, preference, source) => `${query}|${preference}|${source}`,
  });
  equal('非空库不重复导入时间线', second.journeySkipped, true);
  equal('非空库不重复导入热搜', second.hotSkipped, true);
  equal('非空库不再新增行', second.journey + second.hot, 0);

  // 回归：热搜表非空不应连带跳过时间线缓存的导入
  store.closeDb();
  process.env.ZHIHU_DB_PATH = path.join(workspace, 'regression.db');
  store.writeHotCache({ bucket: 20, version: 2, items: [{ title: '运行时新写的热搜' }] });
  const regression = store.importLegacyJsonCache({
    journeyDir: legacyJourney, hotDir: legacyHot,
    readJourneyKey: (query, preference, source) => `${query}|${preference}|${source}`,
  });
  equal('热搜表非空时仍导入时间线缓存', regression.journey, 1);
  equal('热搜表非空时跳过热搜导入', regression.hotSkipped, true);
  equal('热搜表非空时保留运行时数据', store.readHotCache(20, { version: 2, ttlMs: 60000 })?.items[0].title, '运行时新写的热搜');

  /* -------------------------------------------------- OAuth 端到端（mock） */
  const mock = await mockZhihuServer();
  process.env.ZHIHU_OAUTH_BASE_URL = mock.base;
  process.env.ZHIHU_OAUTH_APP_ID = 'app-id-123';
  process.env.ZHIHU_OAUTH_APP_KEY = 'app-key-secret';
  process.env.ZHIHU_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/api/v1/auth/callback';

  const config = oauth.oauthConfig();
  equal('OAuth 配置就绪', config.configured, true);
  check('授权地址指向 base_url', config.authorizeUrl === `${mock.base}/authorize`);

  const login = oauth.startLogin('browser-x');
  const authorize = new URL(login.authorizeUrl);
  equal('授权地址带 app_id', authorize.searchParams.get('app_id'), 'app-id-123');
  equal('授权地址带 response_type=code', authorize.searchParams.get('response_type'), 'code');
  equal('授权地址回传 redirect_uri', authorize.searchParams.get('redirect_uri'), process.env.ZHIHU_OAUTH_REDIRECT_URI);
  equal('授权地址回传 state', authorize.searchParams.get('state'), login.state);
  check('state 足够长且随机', login.state.length >= 32);
  check('两次登录 state 不同', oauth.startLogin('browser-x').state !== login.state);

  // state 会话不匹配必须在换 token 之前就被拒绝
  const beforeMismatch = mock.seen.tokenRequests;
  let mismatchError = null;
  try { await oauth.completeLogin({ authorizationCode: 'good-code', state: login.state, browserId: 'browser-y' }); } catch (error) { mismatchError = error; }
  equal('state 会话不匹配被拒绝', mismatchError?.code, 'OAUTH_STATE_INVALID');
  equal('拒绝时未发起换 token 请求', mock.seen.tokenRequests, beforeMismatch);

  let missingStateError = null;
  try { await oauth.completeLogin({ authorizationCode: 'good-code', browserId: 'browser-x' }); } catch (error) { missingStateError = error; }
  equal('缺失 state 被拒绝', missingStateError?.code, 'OAUTH_STATE_MISSING');

  let missingCodeError = null;
  try { await oauth.completeLogin({ state: login.state, browserId: 'browser-x' }); } catch (error) { missingCodeError = error; }
  equal('缺失授权码被拒绝', missingCodeError?.code, 'OAUTH_CALLBACK_INVALID');

  const done = await oauth.completeLogin({ authorizationCode: 'good-code', state: login.state, browserId: 'browser-x' });
  equal('换 token 请求次数', mock.seen.tokenRequests, beforeMismatch + 1);
  equal('换 token 使用表单字段 code', mock.seen.lastTokenForm.get('code'), 'good-code');
  equal('换 token 携带 grant_type', mock.seen.lastTokenForm.get('grant_type'), 'authorization_code');
  equal('换 token 携带 app_key', mock.seen.lastTokenForm.get('app_key'), 'app-key-secret');
  equal('读取用户信息时使用 Bearer token', mock.seen.lastAuthHeader, 'Bearer oauth-token-abc');
  equal('登录返回无损 uid', done.user.uid, BIG_UID);
  check('登录返回会话标识', typeof done.sid === 'string' && done.sid.length >= 32);
  equal('登录返回用户昵称', done.user.fullname, '测试用户');
  equal('登录响应不含 oauth token', Object.hasOwn(done.user, 'oauthToken'), false);
  equal('登录响应不含会话 token', Object.hasOwn(done.user, 'token'), false);
  check('会话 sid 与登录浏览器标识不同（防会话固定）', done.sid !== 'browser-x');

  const persisted = oauth.currentSession(done.sid);
  equal('会话持久化在 SQLite', persisted?.user?.uid, BIG_UID);
  equal('会话中的 token 仅在服务端', persisted?.oauthToken, 'oauth-token-abc');
  equal('重复回调同一 state 被拒绝', store.consumeOAuthState({ state: login.state, sid: 'browser-x' }).reason, 'replayed');

  let badCodeError = null;
  const relogin = oauth.startLogin('browser-x');
  try { await oauth.completeLogin({ authorizationCode: 'bad-code', state: relogin.state, browserId: 'browser-x' }); } catch (error) { badCodeError = error; }
  equal('无效授权码被拒绝', badCodeError?.code, 'OAUTH_TOKEN_FAILED');

  // 未配置时不应发起任何请求
  delete process.env.ZHIHU_OAUTH_APP_KEY;
  equal('缺 app_key 时判定未配置', oauth.oauthConfig().configured, false);
  let notConfigured = null;
  try { oauth.startLogin('browser-x'); } catch (error) { notConfigured = error; }
  equal('未配置时拒绝发起登录', notConfigured?.code, 'OAUTH_NOT_CONFIGURED');
  process.env.ZHIHU_OAUTH_APP_KEY = 'app-key-secret';

  const cleaned = oauth.cleanup();
  check('清理函数返回计数', Number.isFinite(cleaned.sessions) && Number.isFinite(cleaned.states));
  equal('logout 清理会话', oauth.logout(done.sid), 1);

  /* ------------------------------------------------------------- Cookie */
  const jar = oauth.parseCookies('a=1; cyby_session=abc%2Fdef; broken');
  equal('解析 Cookie 键值', jar.get('a'), '1');
  equal('解析并 URL 解码 Cookie', jar.get('cyby_session'), 'abc/def');
  const cookie = oauth.serializeCookie('cyby_session', 'v', { maxAge: 3600, secure: true });
  check('Cookie 带 HttpOnly', cookie.includes('HttpOnly'));
  check('Cookie 带 SameSite=Lax', cookie.includes('SameSite=Lax'));
  check('Cookie 带 Secure', cookie.includes('Secure'));
  check('清除 Cookie 的 Max-Age 为 0', oauth.clearCookie('cyby_session', { secure: false }).includes('Max-Age=0'));

  await new Promise(resolve => mock.server.close(resolve));
  store.closeDb();
  await rm(workspace, { recursive: true, force: true });

  if (failures.length) {
    process.stdout.write(`\n自检失败 ${failures.length} 项 / 通过 ${passed} 项\n`);
    for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`自检通过：${passed} 项\n`);
}

await main();
