import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildJourney, buildPrelude } from './core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const page = await readFile(path.join(root, 'index.html'));
const curationPage = await readFile(path.join(root, 'curation.html'));
const host = '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || '';

const headers = type => ({
  'Content-Type': type,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

function json(request, response, status, value) {
  const responseHeaders = headers('application/json; charset=utf-8');
  if (frontendOrigin && request.headers.origin === frontendOrigin) {
    responseHeaders['Access-Control-Allow-Origin'] = frontendOrigin;
    responseHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
    responseHeaders['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    responseHeaders.Vary = 'Origin';
  }
  response.writeHead(status, responseHeaders);
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'INPUT_TOO_LARGE' });
  }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('请求必须是 JSON'), { status: 400, code: 'INPUT_INVALID' }); }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, frontendOrigin && request.headers.origin === frontendOrigin ? {
        'Access-Control-Allow-Origin': frontendOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      } : {});
      return response.end();
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, headers('text/html; charset=utf-8'));
      return response.end(page);
    }
    if (request.method === 'GET' && url.pathname === '/curation.html') {
      response.writeHead(200, headers('text/html; charset=utf-8'));
      return response.end(curationPage);
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/health') return json(request, response, 200, {
      status: 'ok',
      mode: process.env.BACKEND_MODE || 'live',
      configured: { zhihu: Boolean(process.env.ZHIHU_ACCESS_SECRET), deepseek: Boolean(process.env.DEEPSEEK_API_KEY) },
    });
    if (request.method === 'POST' && url.pathname === '/api/v1/prelude') {
      const { query } = await readJson(request);
      const requestedMode = url.searchParams.get('mode');
      if (requestedMode && !['fixture', 'live'].includes(requestedMode)) throw Object.assign(new Error('mode 只能是 fixture 或 live'), { status: 400, code: 'INPUT_INVALID' });
      return json(request, response, 200, await buildPrelude(query, requestedMode || undefined));
    }
    if (request.method === 'POST' && (url.pathname === '/api/search' || url.pathname === '/api/v1/journey')) {
      const { query } = await readJson(request);
      const requestedMode = url.searchParams.get('mode');
      if (requestedMode && !['fixture', 'live'].includes(requestedMode)) throw Object.assign(new Error('mode 只能是 fixture 或 live'), { status: 400, code: 'INPUT_INVALID' });
      const refresh = ['1', 'true'].includes(url.searchParams.get('refresh'));
      return json(request, response, 200, await buildJourney(query, requestedMode || undefined, { refresh }));
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

server.listen(port, host, () => process.stdout.write(`知乎观点检索：http://${host}:${port}/\n`));
