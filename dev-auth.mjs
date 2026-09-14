/**
 * 个人中心本地开发入口。
 *
 * 在回环地址启动一个最小知乎 OAuth / 用户数据 mock，再用独立数据库启动应用。
 * 正常 start / start:prod 不会加载本文件，mock 凭证也不会发送给真实知乎接口。
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const MOCK_CODE = 'local-dev-code';
const MOCK_TOKEN = 'local-dev-oauth-token';
const MOCK_SECRET = 'local-dev-access-secret';
const MOCK_UID = '969570047710216200';

function portFrom(value) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DEV_AUTH_PORT 必须是 1024—65535 之间的整数');
  }
  return port;
}

const appPort = portFrom(process.env.DEV_AUTH_PORT);
const appBase = `http://${host}:${appPort}`;
const callbackUrl = `${appBase}/auth/callback`;

const contents = [
  ['answer', 101, '为什么我们会高估短期变化？', '许多变化并不是突然发生，而是经过长期积累后才被看见。'],
  ['article', 102, '从信息检索到认知时间线', '把不同时期的讨论放回各自语境，答案会呈现出变化的轨迹。'],
  ['answer', 103, '技术进步一定会带来效率提升吗？', '工具能力、组织方式和使用习惯往往需要一起改变。'],
  ['zvideo', 104, '如何观察一个观点的形成过程？', '从早期假设、关键争论和后续修正三个阶段展开。'],
  ['pin', 105, '值得反复追问的五个问题', '记录一些需要跨时间观察，而不是立刻寻找结论的问题。'],
  ['question', 106, '我们如何知道自己的判断已经过时？', '当环境、证据或问题本身发生变化时，旧答案需要重新审视。'],
].map(([ContentType, id, Title, Summary], index) => ({
  ContentType,
  Url: ContentType === 'article' ? `https://zhuanlan.zhihu.com/p/${id}` : `https://www.zhihu.com/${ContentType}/${id}`,
  CreatedAt: 1789000000 - index * 86400,
  LikeCount: 86 - index * 7,
  CommentCount: 12 + index,
  FavoriteCount: 30 - index * 2,
  Title,
  Summary,
}));

const followees = [
  ['时间研究者', '研究技术、社会与日常经验之间的时间差。', 28600],
  ['复杂系统笔记', '关注系统变化中的反馈、延迟与涌现。', 17300],
  ['科学史观察', '从历史语境理解科学知识如何形成。', 9200],
  ['产品考古学', '记录产品判断如何被真实使用修正。', 6800],
  ['数据与叙事', '探索数据证据与公共表达的边界。', 5100],
].map(([Fullname, Headline, FollowerCount], index) => ({
  Fullname,
  UrlToken: `local-dev-${index + 1}`,
  Url: `https://www.zhihu.com/people/local-dev-${index + 1}`,
  AvatarUrl: '',
  Headline,
  Gender: 0,
  FollowerCount,
}));

function json(response, value, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function page(items, offsetText) {
  const offset = Math.max(Number(offsetText) || 0, 0);
  const pageSize = 3;
  const selected = items.slice(offset, offset + pageSize);
  const next = offset + selected.length;
  const isEnd = next >= items.length;
  return {
    Code: 0,
    Message: 'success',
    Data: {
      Items: selected,
      Paging: { IsEnd: isEnd, ...(isEnd ? {} : { NextOffset: String(next) }), Totals: items.length },
    },
  };
}

function allowedCallback(value) {
  try { return new URL(value).href === new URL(callbackUrl).href; } catch { return false; }
}

const provider = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    if (!allowedCallback(redirectUri) || !state) return json(response, { error: 'invalid_request' }, 400);
    const callback = new URL(redirectUri);
    callback.searchParams.set('authorization_code', MOCK_CODE);
    callback.searchParams.set('state', state);
    response.writeHead(302, { Location: callback.href, 'Cache-Control': 'no-store' });
    return response.end();
  }

  if (request.method === 'POST' && url.pathname === '/access_token') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    if (form.get('code') !== MOCK_CODE || !allowedCallback(form.get('redirect_uri') || '')) {
      return json(response, { error: 'invalid_grant' }, 400);
    }
    return json(response, { access_token: MOCK_TOKEN, token_type: 'Bearer', expires_in: 86400, code: 20000 });
  }

  if (request.method === 'GET' && url.pathname === '/user') {
    if (request.headers.authorization !== `Bearer ${MOCK_TOKEN}`) return json(response, { error: 'unauthorized' }, 401);
    return json(response, {
      uid: MOCK_UID,
      hash_id: 'local-development-user',
      fullname: '本地开发用户',
      gender: 'unknown',
      headline: '模拟登录 · 数据仅保存在本机',
      description: '用于开发个人中心界面的本地模拟账号。',
      avatar_path: '/assets/brand/logo-mark.svg',
      url: 'https://www.zhihu.com/people/local-development-user',
    });
  }

  if (request.method === 'GET' && (url.pathname === '/api/v1/user/contents' || url.pathname === '/api/v1/user/followees')) {
    const validCredentials = request.headers.authorization === `Bearer ${MOCK_SECRET}` && request.headers['x-oauth-token'] === MOCK_TOKEN;
    if (!validCredentials) return json(response, { Code: 20001, Message: 'auth failed' }, 401);
    const items = url.pathname.endsWith('contents') ? contents : followees;
    return json(response, page(items, url.searchParams.get('Offset')));
  }

  return json(response, { error: 'not_found' }, 404);
});

provider.on('error', error => {
  process.stderr.write(`本地模拟 OAuth 启动失败：${error.message}\n`);
  process.exitCode = 1;
});

await new Promise((resolve, reject) => {
  provider.once('error', reject);
  provider.listen(0, host, resolve);
});

const providerBase = `http://${host}:${provider.address().port}`;
const databasePath = path.join(root, '.data', 'dev-auth.db');
const app = spawn(process.execPath, ['--watch', 'server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: host,
    PORT: String(appPort),
    ZHIHU_DB_PATH: databasePath,
    ZHIHU_OAUTH_BASE_URL: providerBase,
    ZHIHU_OAUTH_APP_ID: '20260001',
    ZHIHU_OAUTH_APP_KEY: 'local-dev-app-key',
    ZHIHU_OAUTH_REDIRECT_URI: callbackUrl,
    ZHIHU_USER_API_BASE_URL: providerBase,
    ZHIHU_USER_ACCESS_SECRET: MOCK_SECRET,
    USER_API_CACHE_TTL_MS: '0',
  },
  stdio: 'inherit',
});

process.stdout.write('\n个人中心本地模拟登录已启用\n');
process.stdout.write(`打开：${appBase}/\n`);
process.stdout.write('点击“登录知乎”会进入本地模拟账号，不会连接真实知乎 OAuth。\n');
process.stdout.write(`开发数据：${databasePath}\n\n`);

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (!app.killed) app.kill(signal);
  provider.close();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
app.on('error', error => {
  process.stderr.write(`本地应用启动失败：${error.message}\n`);
  process.exitCode = 1;
  stop();
});
app.on('exit', code => {
  provider.close();
  if (!stopping && code) process.exitCode = code;
});
