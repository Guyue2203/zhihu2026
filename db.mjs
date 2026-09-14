/**
 * SQLite 持久层：时间线缓存、热搜缓存、知乎用户与登录会话。
 *
 * 只使用 Node 内置的 node:sqlite，不引入任何第三方依赖，也不需要 npm install。
 * 读写失败一律由调用方决定是否静默降级，本模块只负责如实抛出错误。
 */
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 延迟加载 node:sqlite，好在 Node 版本过低时给出可执行的提示，而不是一句 ERR_UNKNOWN_BUILTIN_MODULE。
let DatabaseSyncClass = null;
function sqlite() {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  try {
    ({ DatabaseSync: DatabaseSyncClass } = require('node:sqlite'));
  } catch {
    throw new Error(`当前 Node ${process.versions.node} 不支持内置 node:sqlite，请升级到 Node 24 或更高版本后再启动`);
  }
  return DatabaseSyncClass;
}

/** 数据目录：默认项目内 .data/，可用 ZHIHU_DATA_DIR 覆盖。 */
export function dataDir() {
  const raw = process.env.ZHIHU_DATA_DIR;
  return raw ? path.resolve(raw) : path.join(ROOT, '.data');
}

/** 数据库文件：默认 <数据目录>/zhihu.db，可用 ZHIHU_DB_PATH 直接指定。 */
export function databasePath() {
  const raw = process.env.ZHIHU_DB_PATH;
  return raw ? path.resolve(raw) : path.join(dataDir(), 'zhihu.db');
}

/**
 * 迁移按数组下标递增，实际版本号写入 PRAGMA user_version。
 * 只允许追加，不得修改已发布的迁移，否则老库无法升级。
 */
const MIGRATIONS = [
  function initialSchema(db) {
    db.exec(`
      -- 时间线生成结果。cache_key 为「query + 阶段偏好 + 来源模式」的 sha256。
      CREATE TABLE journey_cache (
        cache_key      TEXT PRIMARY KEY,
        query          TEXT NOT NULL,
        preference     TEXT NOT NULL,
        source         TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload        TEXT NOT NULL,
        fetched_at     INTEGER NOT NULL,
        fetched_at_iso TEXT NOT NULL
      );
      CREATE INDEX idx_journey_cache_fetched_at ON journey_cache (fetched_at);
      CREATE INDEX idx_journey_cache_query ON journey_cache (query);

      -- 热搜缓存。bucket 为归并后的条数档位（10/20/30），避免零散 limit 各自击穿缓存。
      CREATE TABLE hot_cache (
        bucket         INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        payload        TEXT NOT NULL,
        fetched_at     INTEGER NOT NULL,
        fetched_at_iso TEXT NOT NULL
      );

      -- 知乎授权用户。uid 是 int64，超出 JS 安全整数范围，全程按十进制字符串保存。
      CREATE TABLE users (
        uid           TEXT PRIMARY KEY,
        hash_id       TEXT NOT NULL DEFAULT '',
        fullname      TEXT NOT NULL DEFAULT '',
        gender        TEXT NOT NULL DEFAULT '',
        headline      TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        avatar_path   TEXT NOT NULL DEFAULT '',
        profile_url   TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );

      -- 应用会话。sid 是下发给浏览器的随机标识，OAuth token 只留在服务端。
      CREATE TABLE sessions (
        sid              TEXT PRIMARY KEY,
        uid              TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
        oauth_token      TEXT NOT NULL,
        token_expires_at INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_uid ON sessions (uid);
      CREATE INDEX idx_sessions_token_expires_at ON sessions (token_expires_at);

      -- OAuth state：一次性、短时效，绑定发起登录时的浏览器会话。
      CREATE TABLE oauth_states (
        state       TEXT PRIMARY KEY,
        sid         TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX idx_oauth_states_expires_at ON oauth_states (expires_at);

      -- 登录用户的检索历史。未登录访客不写入。
      CREATE TABLE journey_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uid        TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
        query      TEXT NOT NULL,
        preference TEXT NOT NULL,
        source     TEXT NOT NULL,
        cache_key  TEXT,
        title      TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_journey_history_uid_created_at ON journey_history (uid, created_at DESC);
    `);
  },
  function userApiCache(db) {
    // 用户数据接口按 offset 分页，翻页会稳定消耗 user_data 额度（默认每日 100 次）。
    // 缓存整页响应，让「加载更多」反复来回翻页时不再重复回源。
    db.exec(`
      CREATE TABLE user_api_cache (
        cache_key  TEXT PRIMARY KEY,
        uid        TEXT NOT NULL,
        endpoint   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX idx_user_api_cache_fetched_at ON user_api_cache (fetched_at);
      CREATE INDEX idx_user_api_cache_uid ON user_api_cache (uid);
    `);
  },
  function permanentJourneyRecords(db) {
    db.exec(`
      -- 永久时间线快照；与可删除的 journey_cache 分离，不参与 TTL 或条数清理。
      CREATE TABLE journey_records (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key      TEXT NOT NULL,
        query          TEXT NOT NULL,
        preference     TEXT NOT NULL,
        source         TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload        TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        created_at_iso TEXT NOT NULL
      );
      CREATE INDEX idx_journey_records_query_created_at ON journey_records (query, created_at DESC);
      CREATE INDEX idx_journey_records_cache_key ON journey_records (cache_key);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let handle = null;

/** 打开（首次调用时建库建表）并返回数据库句柄。 */
export function getDb() {
  if (handle) return handle;
  const file = databasePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const DatabaseSync = sqlite();
  const db = new DatabaseSync(file);
  // WAL 让读写并发更稳；foreign_keys 保证删用户时级联清理会话与历史。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  handle = db;
  return handle;
}

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (current > SCHEMA_VERSION) throw new Error(`数据库版本 ${current} 高于当前代码支持的 ${SCHEMA_VERSION}，请升级代码或改用其他数据目录`);
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** 关闭句柄。测试与进程退出时使用；关闭后再次 getDb() 会重新打开。 */
export function closeDb() {
  if (!handle) return;
  try { handle.close(); } finally { handle = null; }
}

function one(sql, ...params) { return getDb().prepare(sql).get(...params); }
function all(sql, ...params) { return getDb().prepare(sql).all(...params); }
function run(sql, ...params) { return getDb().prepare(sql).run(...params); }

/* ---------------------------------------------------------------- 时间线缓存 */

export function readJourneyCache(cacheKey, { version, ttlMs }) {
  if (ttlMs <= 0) return null;
  const row = one('SELECT schema_version, payload, fetched_at FROM journey_cache WHERE cache_key = ?', cacheKey);
  if (!row) return null;
  if (Number(row.schema_version) !== version) return null;
  if (Date.now() - Number(row.fetched_at) > ttlMs) return null;
  return JSON.parse(row.payload);
}

export function writeJourneyCache({ cacheKey, query, preference, source, version, result }) {
  const now = Date.now();
  run(`INSERT INTO journey_cache (cache_key, query, preference, source, schema_version, payload, fetched_at, fetched_at_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET
         schema_version = excluded.schema_version,
         payload        = excluded.payload,
         fetched_at     = excluded.fetched_at,
         fetched_at_iso = excluded.fetched_at_iso`,
    cacheKey, query, preference, source, version, JSON.stringify(result), now, new Date(now).toISOString());
}

export function pruneJourneyCache({ ttlMs, keep = 500 }) {
  const db = getDb();
  if (ttlMs > 0) db.prepare('DELETE FROM journey_cache WHERE fetched_at < ?').run(Date.now() - ttlMs);
  db.prepare(`DELETE FROM journey_cache WHERE cache_key IN (
      SELECT cache_key FROM journey_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET ?
    )`).run(keep);
}

/* -------------------------------------------------------------- 永久时间线记录 */

export function appendJourneyRecord({ cacheKey, query, preference, source, version, payload }) {
  const now = Date.now();
  const inserted = run(`INSERT INTO journey_records (cache_key, query, preference, source, schema_version, payload, created_at, created_at_iso)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cacheKey, query, preference, source, version, JSON.stringify(payload), now, new Date(now).toISOString());
  return Number(inserted.lastInsertRowid);
}

export function getJourneyRecord(id) {
  const row = one(`SELECT id, query, preference, source, schema_version, payload, created_at, created_at_iso
                   FROM journey_records WHERE id = ?`, id);
  if (!row) return null;
  return {
    id: Number(row.id), query: row.query, preference: row.preference, source: row.source,
    schemaVersion: Number(row.schema_version), payload: JSON.parse(row.payload),
    createdAt: Number(row.created_at), createdAtIso: row.created_at_iso,
  };
}

export function countJourneyRecords() {
  return Number(one('SELECT COUNT(*) AS n FROM journey_records').n);
}

/* ------------------------------------------------------------------ 热搜缓存 */

export function readHotCache(bucket, { version, ttlMs }) {
  if (ttlMs <= 0) return null;
  const row = one('SELECT schema_version, payload, fetched_at FROM hot_cache WHERE bucket = ?', bucket);
  if (!row) return null;
  if (Number(row.schema_version) !== version) return null;
  if (Date.now() - Number(row.fetched_at) > ttlMs) return null;
  return { items: JSON.parse(row.payload), fetchedAt: Number(row.fetched_at) };
}

export function writeHotCache({ bucket, version, items }) {
  const now = Date.now();
  run(`INSERT INTO hot_cache (bucket, schema_version, payload, fetched_at, fetched_at_iso)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bucket) DO UPDATE SET
         schema_version = excluded.schema_version,
         payload        = excluded.payload,
         fetched_at     = excluded.fetched_at,
         fetched_at_iso = excluded.fetched_at_iso`,
    bucket, version, JSON.stringify(items), now, new Date(now).toISOString());
}

/* -------------------------------------------------------------------- 用户 */

export function upsertUser(profile) {
  const now = Date.now();
  run(`INSERT INTO users (uid, hash_id, fullname, gender, headline, description, avatar_path, profile_url, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET
         hash_id       = excluded.hash_id,
         fullname      = excluded.fullname,
         gender        = excluded.gender,
         headline      = excluded.headline,
         description   = excluded.description,
         avatar_path   = excluded.avatar_path,
         profile_url   = excluded.profile_url,
         updated_at    = excluded.updated_at,
         last_login_at = excluded.last_login_at`,
    profile.uid, profile.hashId, profile.fullname, profile.gender, profile.headline,
    profile.description, profile.avatarPath, profile.profileUrl, now, now, now);
  return getUser(profile.uid);
}

export function getUser(uid) {
  const row = one(`SELECT uid, hash_id, fullname, gender, headline, description, avatar_path, profile_url,
                          created_at, updated_at, last_login_at
                   FROM users WHERE uid = ?`, uid);
  return row ? toUser(row) : null;
}

export function countUsers() {
  return Number(one('SELECT COUNT(*) AS n FROM users').n);
}

/* -------------------------------------------------------------------- 会话 */

export function createSession({ sid, uid, oauthToken, expiresInSeconds }) {
  const now = Date.now();
  const expiresAt = now + Math.max(60, Number(expiresInSeconds) || 3600) * 1000;
  run(`INSERT INTO sessions (sid, uid, oauth_token, token_expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`, sid, uid, oauthToken, expiresAt, now, now);
  return { sid, uid, expiresAt };
}

/** 读取有效会话；token 已过期时顺手删除并返回 null。 */
export function getSession(sid) {
  if (!sid) return null;
  const row = one(`SELECT s.sid, s.uid, s.oauth_token, s.token_expires_at, s.created_at,
                          u.fullname, u.avatar_path, u.headline, u.profile_url, u.hash_id
                   FROM sessions s JOIN users u ON u.uid = s.uid
                   WHERE s.sid = ?`, sid);
  if (!row) return null;
  if (Number(row.token_expires_at) <= Date.now()) { destroySession(sid); return null; }
  run('UPDATE sessions SET last_seen_at = ? WHERE sid = ?', Date.now(), sid);
  return {
    sid: row.sid,
    oauthToken: row.oauth_token,
    tokenExpiresAt: Number(row.token_expires_at),
    user: {
      uid: row.uid,
      hashId: row.hash_id,
      fullname: row.fullname,
      headline: row.headline,
      avatarPath: row.avatar_path,
      profileUrl: row.profile_url,
    },
  };
}

export function destroySession(sid) {
  if (!sid) return 0;
  return Number(run('DELETE FROM sessions WHERE sid = ?', sid).changes);
}

export function purgeExpiredSessions() {
  return Number(run('DELETE FROM sessions WHERE token_expires_at <= ?', Date.now()).changes);
}

/* --------------------------------------------------------------- OAuth state */

export function saveOAuthState({ state, sid, ttlMs }) {
  const now = Date.now();
  run('INSERT INTO oauth_states (state, sid, created_at, expires_at) VALUES (?, ?, ?, ?)', state, sid, now, now + ttlMs);
}

/**
 * 原子消费 state：只有在「未被用过、未过期、且属于当前浏览器会话」时才成功。
 * 校验通过即写入 consumed_at，重复回调无法复用。
 */
export function consumeOAuthState({ state, sid }) {
  const row = one('SELECT sid, expires_at, consumed_at FROM oauth_states WHERE state = ?', state);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumed_at !== null && row.consumed_at !== undefined) return { ok: false, reason: 'replayed' };
  if (Number(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };
  if (String(row.sid) !== String(sid)) return { ok: false, reason: 'session_mismatch' };
  const changed = Number(run('UPDATE oauth_states SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL', Date.now(), state).changes);
  if (changed !== 1) return { ok: false, reason: 'replayed' };
  return { ok: true };
}

export function purgeExpiredOAuthStates() {
  return Number(run('DELETE FROM oauth_states WHERE expires_at <= ?', Date.now()).changes);
}

/* ------------------------------------------------------------------ 检索历史 */

export function recordHistory({ uid, query, preference, source, cacheKey, title }) {
  run(`INSERT INTO journey_history (uid, query, preference, source, cache_key, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, uid, query, preference, source, cacheKey, String(title || '').slice(0, 200), Date.now());
}

export function listHistory({ uid, limit = 20, offset = 0 }) {
  const rows = all(`SELECT id, query, preference, source, title, created_at
                    FROM journey_history WHERE uid = ?
                    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, uid, limit, offset);
  return rows.map(row => ({
    id: Number(row.id),
    query: row.query,
    preference: row.preference,
    source: row.source,
    title: row.title,
    createdAt: Number(row.created_at),
    createdAtIso: new Date(Number(row.created_at)).toISOString(),
  }));
}

export function clearHistory(uid) {
  return Number(run('DELETE FROM journey_history WHERE uid = ?', uid).changes);
}

/* --------------------------------------------------------- 用户数据接口缓存 */

export function readUserApiCache({ uid, cacheKey, ttlMs }) {
  if (ttlMs <= 0) return null;
  const row = one('SELECT payload, fetched_at FROM user_api_cache WHERE cache_key = ? AND uid = ?', cacheKey, uid);
  if (!row) return null;
  if (Date.now() - Number(row.fetched_at) > ttlMs) return null;
  return { payload: JSON.parse(row.payload), fetchedAt: Number(row.fetched_at) };
}

export function writeUserApiCache({ uid, endpoint, cacheKey, payload }) {
  run(`INSERT INTO user_api_cache (cache_key, uid, endpoint, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET
         uid        = excluded.uid,
         endpoint   = excluded.endpoint,
         payload    = excluded.payload,
         fetched_at = excluded.fetched_at`,
    cacheKey, uid, endpoint, JSON.stringify(payload), Date.now());
}

export function pruneUserApiCache({ ttlMs, keep = 2000 }) {
  const db = getDb();
  if (ttlMs > 0) db.prepare('DELETE FROM user_api_cache WHERE fetched_at < ?').run(Date.now() - ttlMs);
  db.prepare(`DELETE FROM user_api_cache WHERE cache_key IN (
      SELECT cache_key FROM user_api_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET ?
    )`).run(keep);
}

export function clearUserApiCache(uid) {
  return Number(run('DELETE FROM user_api_cache WHERE uid = ?', uid).changes);
}

/* --------------------------------------------------------- 旧 JSON 缓存导入 */

/**
 * 把改造前写入 .cache/journey/*.json 与 .cache/hot/list.json 的历史缓存导入 SQLite。
 * 两张表各自独立判断：只有该表为空时才导入，避免覆盖运行时新写入的数据，也避免一张表非空
 * 就连带跳过另一张表的导入。导入后保留原文件不删除。
 */
export function importLegacyJsonCache({ journeyDir, hotDir, readJourneyKey }) {
  const report = { journey: 0, hot: 0, journeySkipped: false, hotSkipped: false };
  const db = getDb();

  if (Number(one('SELECT COUNT(*) AS n FROM journey_cache').n) > 0) {
    report.journeySkipped = true;
  } else {
    for (const file of listJsonFiles(journeyDir)) {
      let entry; try { entry = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (!entry || typeof entry.query !== 'string' || !Number.isFinite(entry.fetchedAt)) continue;
      const preference = typeof entry.preference === 'string' ? entry.preference : 'default';
      const source = typeof entry.source === 'string' ? entry.source : 'zhihu';
      try {
        run(`INSERT OR IGNORE INTO journey_cache (cache_key, query, preference, source, schema_version, payload, fetched_at, fetched_at_iso)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          readJourneyKey(entry.query, preference, source), entry.query, preference, source,
          Number(entry.version) || 0, JSON.stringify(entry.result ?? null), Number(entry.fetchedAt),
          entry.fetchedAtIso || new Date(Number(entry.fetchedAt)).toISOString());
        report.journey += 1;
      } catch { /* 单条导入失败不影响其余文件 */ }
    }
  }

  if (Number(one('SELECT COUNT(*) AS n FROM hot_cache').n) > 0) {
    report.hotSkipped = true;
  } else {
    const hotFile = hotDir ? path.join(hotDir, 'list.json') : null;
    if (hotFile && existsSync(hotFile)) {
      try {
        const entry = JSON.parse(readFileSync(hotFile, 'utf8'));
        if (Array.isArray(entry?.items) && Number.isFinite(entry.fetchedAt) && Number.isFinite(entry.limit)) {
          run(`INSERT OR IGNORE INTO hot_cache (bucket, schema_version, payload, fetched_at, fetched_at_iso)
               VALUES (?, ?, ?, ?, ?)`, Number(entry.limit), Number(entry.version) || 0, JSON.stringify(entry.items),
            Number(entry.fetchedAt), entry.fetchedAtIso || new Date(Number(entry.fetchedAt)).toISOString());
          report.hot = 1;
        }
      } catch { /* 热搜缓存损坏时忽略 */ }
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return report;
}

function listJsonFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name)); } catch { return []; }
}

function toUser(row) {
  return {
    uid: row.uid,
    hashId: row.hash_id,
    fullname: row.fullname,
    gender: row.gender,
    headline: row.headline,
    description: row.description,
    avatarPath: row.avatar_path,
    profileUrl: row.profile_url,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastLoginAt: Number(row.last_login_at),
  };
}
