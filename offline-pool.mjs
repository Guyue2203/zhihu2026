/**
 * 离线策展构建器：读取外部浏览器保存的搜索结果 HTML，以人工核验元数据补全帖子，
 * 再按相关度、热度、外部搜索排名与立场多样性生成可审核的静态 JSON。
 * 运行：node offline-pool.mjs <manifest.json> [output.json]
 * 检查 HTML：node offline-pool.mjs --inspect <capture.html> [output.json]
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ANSWER_PATH = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;
const EN_ANSWER_PATH = /^\/en\/answer\/(\d+)\/?$/;
const DAY = 86400000;

const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
const round = value => Math.round(value * 1000) / 1000;
const decodeHtml = value => String(value || '')
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x2F;/gi, '/');

/** 只接受知乎回答页（中文规范路径或官方英文镜像路径），并去掉跟踪参数。 */
export function canonicalZhihuAnswerUrl(raw) {
  let candidate = decodeHtml(raw).trim();
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      if (candidate.startsWith('//')) candidate = `https:${candidate}`;
      const parsed = new URL(candidate, 'https://search.invalid');
      if (['zhihu.com', 'www.zhihu.com'].includes(parsed.hostname.toLowerCase())) {
        const match = parsed.pathname.match(ANSWER_PATH);
        if (match) return `https://www.zhihu.com/question/${match[1]}/answer/${match[2]}`;
        const englishMatch = parsed.pathname.match(EN_ANSWER_PATH);
        return englishMatch ? `https://www.zhihu.com/en/answer/${englishMatch[1]}` : '';
      }
      const nested = ['q', 'url', 'u', 'target', 'redirect_url'].map(key => parsed.searchParams.get(key)).find(value => /^https?:\/\//i.test(value || ''));
      if (!nested) return '';
      candidate = nested;
    } catch { return ''; }
  }
  return '';
}

/** 按外部搜索页出现顺序提取知乎回答链接；重复链接只保留最靠前的一次。 */
export function extractAnswerCandidates(html) {
  const found = new Map();
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = anchor.exec(String(html || '')))) {
    const url = canonicalZhihuAnswerUrl(match[2]);
    if (url && !found.has(url)) found.set(url, { url, rank: found.size + 1 });
  }
  return [...found.values()];
}

function textTokens(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ').trim();
  const tokens = new Set(normalized.match(/[a-z0-9]+/g) || []);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')];
  if (han.length === 1) tokens.add(han[0]);
  for (let index = 0; index < han.length - 1; index += 1) tokens.add(han[index] + han[index + 1]);
  return tokens;
}

function relevance(stage, post, query) {
  const referenceText = [query, stage.title, stage.cognition, ...(stage.keywords || [])].join(' ');
  const candidateText = [post.question, post.excerpt, post.viewpoint].join(' ');
  const reference = textTokens(referenceText);
  const candidate = textTokens(candidateText);
  let overlap = 0;
  for (const token of reference) if (candidate.has(token)) overlap += 1;
  const tokenScore = overlap / Math.max(reference.size, 1);
  const keywordScore = (stage.keywords || []).filter(Boolean).some(keyword => candidateText.includes(keyword)) ? 1 : 0;
  return clamp01(tokenScore * 0.7 + keywordScore * 0.3);
}

function dateValue(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return NaN;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return NaN;
  return endOfDay ? parsed + DAY - 1 : parsed;
}

/** 对一个阶段的已核验预选池排序；日期、来源页与 verified 是硬门槛。 */
export function rankStageCandidates({ query, stage, posts, discovered, limit = 3, excludedUrls = new Set() }) {
  const from = dateValue(stage.from);
  const to = dateValue(stage.to, true);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error(`阶段 ${stage.id || stage.title} 的日期边界无效`);
  const pool = [];
  for (const post of posts || []) {
    const url = canonicalZhihuAnswerUrl(post.url);
    const discovery = discovered.get(url);
    const publishedAt = dateValue(post.publishedAt);
    if (!post.verified || !url || !discovery || excludedUrls.has(url) || !Number.isFinite(publishedAt) || publishedAt < from || publishedAt > to) continue;
    const relevanceScore = relevance(stage, post, query);
    if (relevanceScore < 0.08) continue;
    pool.push({ ...post, url, votes: Math.max(0, Number(post.votes) || 0), comments: Math.max(0, Number(post.comments) || 0), relevanceScore, externalRank: discovery.rank });
  }
  const maxHeat = Math.max(1, ...pool.map(post => Math.log1p(post.votes) * 10 + Math.log1p(post.comments) * 6));
  const maxRank = Math.max(1, discovered.size);
  for (const post of pool) {
    const heatScore = (Math.log1p(post.votes) * 10 + Math.log1p(post.comments) * 6) / maxHeat;
    const externalScore = maxRank === 1 ? 1 : 1 - (post.externalRank - 1) / (maxRank - 1);
    post.scoreBreakdown = { relevance: round(post.relevanceScore), heat: round(heatScore), externalRank: round(externalScore) };
    post.recommendationScore = round(post.relevanceScore * 0.55 + heatScore * 0.3 + externalScore * 0.15);
  }
  pool.sort((a, b) => b.recommendationScore - a.recommendationScore || b.votes - a.votes || a.externalRank - b.externalRank);

  // 先取不同立场中的最高分，再按总分补齐，避免单一高赞叙事垄断阶段。
  const diverse = [];
  const seenStances = new Set();
  for (const post of pool) {
    const stance = String(post.stance || 'unspecified');
    if (!seenStances.has(stance)) { diverse.push(post); seenStances.add(stance); }
  }
  diverse.sort((a, b) => b.recommendationScore - a.recommendationScore);
  const selected = diverse.slice(0, limit);
  for (const post of pool) {
    if (selected.length >= limit) break;
    if (!selected.includes(post)) selected.push(post);
  }
  return selected.sort((a, b) => b.recommendationScore - a.recommendationScore);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest 必须是 JSON 对象');
  if (!/^[a-z0-9-]+$/.test(String(manifest.slug || ''))) throw new Error('slug 只能含小写字母、数字和连字符');
  if (!String(manifest.query || '').trim()) throw new Error('缺少 query');
  if (!Array.isArray(manifest.stages) || !manifest.stages.length) throw new Error('至少需要一个阶段');
  if (!Array.isArray(manifest.posts)) throw new Error('posts 必须是数组');
}

/** 把浏览器导出的预选池构建为静态页面可直接读取的时间线。 */
export async function buildStaticJourney(manifest, readCapture) {
  validateManifest(manifest);
  const outputPosts = [];
  const usedUrls = new Set();
  const preselectedUrls = new Set();
  const verifiedUrls = new Set(manifest.posts.filter(post => post?.verified).map(post => canonicalZhihuAnswerUrl(post.url)).filter(Boolean));
  const stages = [];
  const defaultLimit = Math.min(5, Math.max(1, Number(manifest.limitPerStage) || 3));

  for (const rawStage of manifest.stages) {
    if (!rawStage?.id || !Array.isArray(rawStage.captures) || !rawStage.captures.length) throw new Error(`阶段 ${rawStage?.id || '?'} 缺少 captures`);
    const discovered = new Map();
    for (const capture of rawStage.captures) {
      for (const candidate of extractAnswerCandidates(await readCapture(capture))) {
        if (!discovered.has(candidate.url)) discovered.set(candidate.url, { ...candidate, rank: discovered.size + 1 });
      }
    }
    for (const url of discovered.keys()) if (verifiedUrls.has(url)) preselectedUrls.add(url);
    const selected = rankStageCandidates({ query: manifest.query, stage: rawStage, posts: manifest.posts, discovered, limit: defaultLimit, excludedUrls: usedUrls });
    if (!selected.length) throw new Error(`阶段 ${rawStage.id} 没有通过来源、日期与相关度校验的帖子`);
    const postIds = [];
    for (const post of selected) {
      usedUrls.add(post.url);
      const pathname = new URL(post.url).pathname;
      const id = pathname.match(ANSWER_PATH)?.[2] || pathname.match(EN_ANSWER_PATH)?.[1];
      postIds.push(id);
      outputPosts.push({
        id, stageId: rawStage.id, question: String(post.question || ''), answerer: String(post.answerer || ''),
        excerpt: String(post.excerpt || ''), viewpoint: String(post.viewpoint || ''), url: post.url,
        publishedAt: post.publishedAt, votes: post.votes, comments: post.comments,
        stance: String(post.stance || 'unspecified'), recommendationScore: post.recommendationScore,
        scoreBreakdown: post.scoreBreakdown,
      });
    }
    stages.push({
      id: rawStage.id, period: String(rawStage.period || `${rawStage.from}—${rawStage.to}`),
      title: String(rawStage.title || ''), cognition: String(rawStage.cognition || ''),
      importance: rawStage.importance === 'detail' ? 'detail' : 'core',
      change: String(rawStage.change || ''), evidence: String(rawStage.evidence || ''), postIds,
    });
  }

  return {
    schemaVersion: 1, slug: manifest.slug, query: manifest.query,
    title: String(manifest.title || manifest.query), thesis: String(manifest.thesis || ''),
    stages, posts: outputPosts, coverage: 'curated_static', evidenceCount: preselectedUrls.size,
    selectedCount: outputPosts.length, generatedAt: new Date().toISOString(),
    limitations: ['内容来自外部浏览器导出的检索结果与人工核验元数据，不在访客请求时实时搜索。', '推荐分用于策展排序，不代表事实正确；最终页面只展示通过来源、日期和相关度硬校验的帖子。'],
  };
}

async function selfTest() {
  const direct = 'https://www.zhihu.com/question/1/answer/11?utm_source=x';
  const english = 'https://www.zhihu.com/en/answer/13?utm_source=x';
  const redirected = `https://www.google.com/url?q=${encodeURIComponent('https://www.zhihu.com/question/1/answer/12')}`;
  const extracted = extractAnswerCandidates(`<a href="${direct}">A</a><a href="${redirected.replaceAll('&', '&amp;')}">B</a><a href="${english}">C</a><a href="https://evil.example/a">X</a>`);
  if (extracted.length !== 3 || extracted[0].url.endsWith('?utm_source=x') || extracted[2].url !== 'https://www.zhihu.com/en/answer/13') throw new Error('candidate extraction failed');
  const manifest = {
    slug: 'test', query: '共享单车规模为什么失败', title: 'test', limitPerStage: 2,
    stages: [{ id: 's1', from: '2016-01-01', to: '2016-12-31', period: '2016', title: '规模增长', cognition: '共享单车规模扩张', keywords: ['共享单车'], captures: ['capture.html'] }],
    posts: [
      { url: direct, question: '共享单车规模增长', excerpt: '规模扩张', viewpoint: '乐观', publishedAt: '2016-05-01', votes: 500, comments: 20, stance: 'positive', verified: true },
      { url: 'https://www.zhihu.com/question/1/answer/12', question: '共享单车为什么失败', excerpt: '运营成本', viewpoint: '质疑规模', publishedAt: '2016-06-01', votes: 50, comments: 8, stance: 'critical', verified: true },
      { url: 'https://www.zhihu.com/question/1/answer/13', question: '共享单车', excerpt: '日期越界', publishedAt: '2017-01-01', votes: 9999, verified: true },
    ],
  };
  const result = await buildStaticJourney(manifest, async () => `<a href="${direct}">A</a><a href="${redirected}">B</a><a href="https://www.zhihu.com/question/1/answer/13">C</a>`);
  if (result.selectedCount !== 2 || new Set(result.posts.map(post => post.stance)).size !== 2) throw new Error('ranking/diversity failed');
  process.stdout.write('offline-pool self-test passed\n');
}

async function main() {
  const [manifestFile, inputFile, optionalOutputFile] = process.argv.slice(2);
  if (manifestFile === '--self-test') return selfTest();
  if (manifestFile === '--inspect') {
    if (!inputFile) throw new Error('用法：node offline-pool.mjs --inspect <capture.html> [output.json]');
    const candidates = extractAnswerCandidates(await readFile(path.resolve(inputFile), 'utf8'));
    const result = { capture: path.basename(inputFile), candidateCount: candidates.length, candidates };
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (!optionalOutputFile) return process.stdout.write(json);
    const output = path.resolve(optionalOutputFile);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, json, 'utf8');
    return process.stdout.write(`已提取 ${candidates.length} 个知乎回答链接到 ${output}\n`);
  }
  if (!manifestFile) throw new Error('用法：node offline-pool.mjs <manifest.json> [output.json]');
  const outputFile = inputFile;
  const absoluteManifest = path.resolve(manifestFile);
  const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8'));
  const base = path.dirname(absoluteManifest);
  const result = await buildStaticJourney(manifest, capture => readFile(path.resolve(base, capture), 'utf8'));
  const output = path.resolve(outputFile || path.join('static', 'journeys', `${manifest.slug}.json`));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`已生成 ${output}：${result.stages.length} 个阶段 / ${result.selectedCount} 篇帖子\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
