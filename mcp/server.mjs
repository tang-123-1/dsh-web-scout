#!/usr/bin/env node
/**
 * web-scout MCP 服务（v1.16，路线图第 3 步）
 *
 * 零依赖：手写 JSON-RPC 2.0 over stdio，直接复用插件自己的引擎/缓存/provider 层。
 * 这样同一套搜索能力可以被 DSH、Claude Desktop、Cursor 等任意 MCP 宿主调用。
 *
 * 启动：
 *   node <repo>/mcp/server.mjs
 *
 * 宿主配置（Claude Desktop / Cursor 的 mcpServers）：
 *   { "mcpServers": { "web-scout": { "command": "node", "args": ["D:/dshcs/web-scout/mcp/server.mjs"] } } }
 *
 * 协议：MCP 2024-11-05 / 2025-03-26 / 2025-06-18（stdio，换行分隔 JSON；也兼容 LSP 式 Content-Length）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createClient } from '../net.js';
import { ScoutStore } from '../store.js';
import { createCache } from '../cache.js';
import {
  PLATFORMS,
  initProviders,
  providerCatalog,
  readPage,
  resolvePlatforms,
  runSearch,
  packEvidence,
  formatEvidence,
  checkPlatforms,
  formatHealth,
  planQuery,
  research as runResearch,
} from '../engines.js';

const SERVER_NAME = 'web-scout';
const SERVER_VERSION = '1.16.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2024-11-05';

const log = (...parts) => {
  // stdout 是协议通道，日志只能走 stderr
  process.stderr.write(`[${SERVER_NAME}] ${parts.join(' ')}\n`);
};

// ---------------------------------------------------------------- 配置与依赖
const store = new ScoutStore();
let cache = null;

async function ensureStore() {
  try {
    await store.load();
  } catch (error) {
    log('读取配置失败，用默认值：', String(error && error.message));
  }
}

function settings() {
  let snapshot = {};
  try {
    snapshot = store.snapshot() || {};
  } catch {
    snapshot = {};
  }
  return {
    proxy: typeof snapshot.proxy === 'string' ? snapshot.proxy : '',
    limit: Number(snapshot.limit) || 8,
    pages: Number(snapshot.pages) || 3,
    maxPlatforms: Number(snapshot.maxPlatforms) || 10,
    timeoutMs: Number(snapshot.timeoutMs) || 12000,
    defaultPlatforms: Array.isArray(snapshot.defaultPlatforms) && snapshot.defaultPlatforms.length > 0 ? snapshot.defaultPlatforms : ['bing', 'so360', 'csdn', 'juejin'],
    cacheTtlMs: Number(snapshot.cacheTtlMs) || 6 * 60 * 60 * 1000,
    cookies: snapshot.cookies && typeof snapshot.cookies === 'object' ? snapshot.cookies : {},
  };
}

function getCache() {
  if (cache) return cache;
  const current = settings();
  cache = createCache({ ttlMs: current.cacheTtlMs });
  return cache;
}

async function cachedSearch(key, loader, ttlMs) {
  try {
    const box = getCache();
    const hit = box.get(`mcp::${key}`);
    if (hit) return { value: hit.value, cached: true, ageMs: hit.ageMs, source: hit.source };
    const value = await loader();
    box.set(`mcp::${key}`, value, ttlMs);
    return { value, cached: false, ageMs: 0, source: '' };
  } catch (error) {
    log('缓存不可用，直接跑：', String(error && error.message));
    return { value: await loader(), cached: false, ageMs: 0, source: '' };
  }
}

function searchKey(current, query, platforms, limit, pages) {
  return JSON.stringify({
    v: 'mcp1',
    proxy: current.proxy || 'direct',
    query,
    platforms,
    limit,
    pages,
  });
}

// ---------------------------------------------------------------- 工具实现
function platformLine(results) {
  if (!results || results.length === 0) return '';
  return results.map((item) => `${typeof item === 'string' ? item : item.id}`).join(' ');
}

function renderSearch(data) {
  const lines = [];
  lines.push(`查询：${data.query === '' ? '（榜单/信息流，无关键词）' : data.query}`);
  if (data.cached) lines.push(`缓存：命中（${Math.max(0, Math.round((data.cacheAgeMs || 0) / 1000))}s 前）`);
  const status = (data.platforms || [])
    .map((item) => `${item.label}:${item.status}${item.count ? `×${item.count}` : ''}`)
    .join('  ');
  lines.push(`平台：${status}`);
  lines.push('');
  (data.results || []).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   ${item.platformLabel || item.platform} · ${item.kind || 'article'} · ${item.url}`);
    if (item.snippet) lines.push(`   ${String(item.snippet).replace(/\s+/g, ' ').slice(0, 300)}`);
  });
  if (data.tunnelSuggested) lines.push('\n提示：部分站点需要代理才能直连，可用 web_scout_read 或浏览器打开。');
  return lines.join('\n');
}

async function toolSearch(args) {
  const current = settings();
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const platformsInput = Array.isArray(args.platforms) && args.platforms.length > 0 ? args.platforms : ['auto'];
  const platforms = resolvePlatforms(platformsInput, current.defaultPlatforms, []).slice(0, Math.min(14, current.maxPlatforms));
  const limit = Math.min(30, Math.max(1, Number(args.limit) || current.limit));
  const pages = Math.min(4, Math.max(1, Number(args.pages) || current.pages));

  const feedOnly = platforms.length > 0 && platforms.every((id) => {
    const def = PLATFORMS.get(id);
    return Boolean(def && def.list === true);
  });
  if (query === '' && !feedOnly) throw new Error('缺少 query：关键词搜索必须给查询词（榜单类平台可以留空）');

  const key = searchKey(current, query, platforms, limit, pages);
  if (args.refresh === true) {
    try {
      getCache().forget(`mcp::${key}`);
    } catch {
      // 清不掉也继续，下面会拿旧值但至少不报错
    }
  }

  const outcome = await cachedSearch(
    key,
    async () =>
      runSearch({
        query,
        platforms,
        limit,
        pages,
        timeoutMs: Math.min(30000, Math.max(3000, Number(args.timeoutMs) || current.timeoutMs)),
        proxy: current.proxy,
        cookies: current.cookies,
        defaultPlatforms: current.defaultPlatforms,
        hints: [],
        maxPlatforms: current.maxPlatforms,
      }),
    Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, current.cacheTtlMs)),
  );

  const value = outcome.value;
  const payload = {
    query: value.query,
    mode: value.mode,
    platforms: value.platforms.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      note: item.note,
      count: item.count,
      browser: item.browser,
      kind: item.kind,
    })),
    results: value.results.slice(0, Math.max(limit, 20)),
    blocked: value.blocked,
    tunnelSuggested: value.tunnelSuggested,
    cached: outcome.cached,
    cacheAgeMs: outcome.ageMs,
    cacheSource: outcome.source,
  };
  return { payload, text: renderSearch({ ...payload, results: payload.results.slice(0, 12) }) };
}

async function toolRead(args) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s) 链接');
  const maxChars = Math.min(20000, Math.max(500, Number(args.maxChars) || 6000));
  const current = settings();
  const key = `read::${url}::${maxChars}::${current.proxy || 'direct'}`;
  const outcome = await cachedSearch(
    key,
    async () => readPage({ url, maxChars, proxy: current.proxy, timeoutMs: current.timeoutMs }),
    Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, current.cacheTtlMs)),
  );
  const page = outcome.value;
  const text = [
    `标题：${page.title || '(无)'}`,
    `状态：${page.status} · ${page.chars} 字${page.truncated ? '（已截断）' : ''}${outcome.cached ? ' · 缓存命中' : ''}`,
    `链接：${page.finalUrl || page.url}`,
    '',
    page.text || '(正文为空)',
  ].join('\n');
  return { payload: { ...page, cached: outcome.cached, cacheAgeMs: outcome.ageMs, cacheSource: outcome.source }, text };
}

async function toolEvidence(args) {
  const current = settings();
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const platformsInput = Array.isArray(args.platforms) && args.platforms.length > 0 ? args.platforms : ['auto'];
  const platforms = resolvePlatforms(platformsInput, current.defaultPlatforms, []).slice(0, Math.min(14, current.maxPlatforms));
  const limit = Math.min(30, Math.max(1, Number(args.limit) || current.limit));
  const pages = Math.min(4, Math.max(1, Number(args.pages) || current.pages));
  const feedOnly = platforms.length > 0 && platforms.every((id) => {
    const def = PLATFORMS.get(id);
    return Boolean(def && def.list === true);
  });
  if (query === '' && !feedOnly) throw new Error('缺少 query：关键词检索必须给查询词（榜单类平台可以留空）');

  const packOptions = {
    budgetChars: Math.min(20000, Math.max(800, Number(args.budgetChars) || 6000)),
    maxItems: Math.min(20, Math.max(1, Number(args.maxItems) || 10)),
    perPlatform: Math.min(8, Math.max(1, Number(args.perPlatform) || 3)),
    excerptChars: Math.min(600, Math.max(80, Number(args.excerptChars) || 240)),
  };
  const key = ['ev', current.proxy || 'direct', query, platforms.join(','), limit, pages, JSON.stringify(packOptions)].join('::');
  if (args.refresh === true) {
    try { getCache().forget(`mcp::${key}`); } catch { /* ignore */ }
  }
  const outcome = await cachedSearch(
    key,
    async () => {
      const result = await runSearch({
        query,
        platforms,
        limit,
        pages,
        timeoutMs: Math.min(30000, Math.max(3000, Number(args.timeoutMs) || current.timeoutMs)),
        proxy: current.proxy,
        cookies: current.cookies,
        defaultPlatforms: current.defaultPlatforms,
        hints: [],
        maxPlatforms: current.maxPlatforms,
      });
      const packed = packEvidence({ query: result.query, results: result.results, platforms: result.platforms, ...packOptions });
      return { ...packed, mode: result.mode, tunnelSuggested: result.tunnelSuggested, text: formatEvidence(packed) };
    },
    Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, current.cacheTtlMs)),
  );
  const value = outcome.value;
  return {
    payload: {
      query: value.query,
      selected: value.selected,
      total: value.total,
      usedChars: value.usedChars,
      budgetChars: value.budgetChars,
      items: value.items,
      coverage: value.coverage,
      gaps: value.gaps,
      platformNotes: value.platformNotes,
      dropped: value.dropped,
      mode: value.mode,
      tunnelSuggested: value.tunnelSuggested,
      cached: outcome.cached,
      cacheAgeMs: outcome.ageMs,
    },
    text: value.text,
  };
}

async function toolResearch(args) {
  const current = settings();
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const platformsInput = Array.isArray(args.platforms) && args.platforms.length > 0 ? args.platforms : ['auto'];
  const platforms = resolvePlatforms(platformsInput, current.defaultPlatforms, []).slice(0, Math.min(14, current.maxPlatforms));
  const budgetMs = Math.min(60000, Math.max(3000, Number(args.budgetMs) || 12000));
  const maxRounds = Math.min(3, Math.max(1, Number(args.maxRounds) || 3));
  const minItems = Math.min(20, Math.max(1, Number(args.minItems) || 6));
  const quorumPlatforms = Math.min(8, Math.max(1, Number(args.quorumPlatforms) || 3));
  const quorumKinds = Math.min(6, Math.max(1, Number(args.quorumKinds) || 2));
  const limit = Math.min(30, Math.max(1, Number(args.limit) || current.limit));
  const pages = Math.min(4, Math.max(1, Number(args.pages) || current.pages));
  const plan = planQuery({ query, platforms, hints: [], maxPlatforms: current.maxPlatforms });
  const key = [
    'rs',
    current.proxy || 'direct',
    plan.query,
    plan.platforms.join(','),
    limit,
    pages,
    budgetMs,
    maxRounds,
    minItems,
    quorumPlatforms,
    quorumKinds,
  ].join('::');
  if (args.refresh === true) {
    try { getCache().forget(`mcp::${key}`); } catch { /* ignore */ }
  }
  const outcome = await cachedSearch(
    key,
    () => runResearch({
      query: plan.query,
      platforms: plan.platforms,
      budgetMs,
      maxRounds,
      minItems,
      quorumPlatforms,
      quorumKinds,
      limit,
      pages,
      timeoutMs: Math.min(30000, Math.max(3000, Number(args.timeoutMs) || current.timeoutMs)),
      proxy: current.proxy,
      cookies: current.cookies,
    }),
    Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, current.cacheTtlMs)),
  );
  const value = outcome.value;
  return {
    payload: {
      query: value.query,
      intent: value.plan && value.plan.intent,
      variants: (value.plan && value.plan.variants ? value.plan.variants : []).map((item) => item.text),
      platforms: value.plan ? value.plan.platforms : [],
      rounds: value.rounds,
      quality: value.quality,
      met: value.met,
      took: value.took,
      budgetMs: value.budgetMs,
      items: value.pack ? value.pack.items : [],
      gaps: value.pack ? value.pack.gaps : [],
      cached: outcome.cached,
      cacheAgeMs: outcome.ageMs,
    },
    text: value.text,
  };
}

async function toolHealth(args) {
  const current = settings();
  const report = await checkPlatforms({
    platforms: Array.isArray(args.platforms) ? args.platforms : [],
    defaultPlatforms: current.defaultPlatforms,
    query: typeof args.query === 'string' && args.query.trim() !== '' ? args.query : 'cordis',
    timeoutMs: Math.min(20000, Math.max(2000, Number(args.timeoutMs) || 8000)),
    deep: args.deep === true,
    concurrency: Math.min(8, Math.max(1, Number(args.concurrency) || 4)),
    proxy: current.proxy,
    cookies: current.cookies,
  });
  return { payload: { ...report, text: undefined }, text: formatHealth(report) };
}

async function toolProviders() {
  const list = providerCatalog();
  const current = settings();
  const lines = list.map((item) => `${item.label} (${item.id}) · ${item.source} · ${item.kind}${item.list ? ' · 榜单' : ''}`);
  return {
    payload: {
      providers: list,
      platforms: PLATFORMS.size,
      defaultPlatforms: current.defaultPlatforms,
      proxy: current.proxy,
      cacheTtlMs: current.cacheTtlMs,
    },
    text: `${PLATFORMS.size} 个平台 / ${list.length} 个 provider（默认源：${current.defaultPlatforms.join(' / ')}）：\n${lines.join('\n')}`,
  };
}

const TOOLS = [
  {
    name: 'web_scout_search',
    description:
      'Search the web through web-scout providers (Bing, Baidu, 360, CSDN, Juejin, V2EX, Zhihu, Bilibili, WeChat, hot lists, plus any external providers the user installed). Returns ranked results with platform, kind, url and snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. May be empty only for hot-list / feed platforms.' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Platform ids, e.g. ["bing","zhihu","bilibili"]; omit for the configured defaults.' },
        limit: { type: 'number', description: 'Results wanted (1-30, default from config).' },
        pages: { type: 'number', description: 'Pages per backend (1-4).' },
        timeoutMs: { type: 'number', description: 'Per-platform timeout in ms (3000-30000).' },
        refresh: { type: 'boolean', description: 'Bypass the cache and search again.' },
      },
      additionalProperties: false,
    },
    run: toolSearch,
  },
  {
    name: 'web_scout_read',
    description: 'Fetch one web page and return clean text (title, status,正文, links). Cached, so repeat reads are毫秒级.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to read.' },
        maxChars: { type: 'number', description: 'Max characters of body text (500-20000).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: toolRead,
  },
  {
    name: 'web_scout_evidence',
    description:
      'Search and return an EVIDENCE PACK: top items scored by relevance / freshness / native backend, each with a quoted excerpt, plus per-platform coverage and gaps. Cheaper on context than a raw result list.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords; may be empty only for hot-list platforms.' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Platform ids; omit for configured defaults.' },
        budgetChars: { type: 'number', description: 'Character budget (800-20000, default 6000).' },
        maxItems: { type: 'number', description: 'Max items (1-20, default 10).' },
        perPlatform: { type: 'number', description: 'Max items per platform (1-8, default 3).' },
        excerptChars: { type: 'number', description: 'Max excerpt length (80-600, default 240).' },
        limit: { type: 'number', description: 'Raw results per platform (1-30).' },
        pages: { type: 'number', description: 'Pages per backend (1-4).' },
        refresh: { type: 'boolean', description: 'Bypass cache.' },
      },
      additionalProperties: false,
    },
    run: toolEvidence,
  },
  {
    name: 'web_scout_research',
    description:
      'Run a multi-round research job: plan the query (intent routing + query variants), search in waves, stop early once the quality quorum is met, and return an evidence pack plus a report. Best for open-ended questions that need several sources.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or keywords; may be empty only for hot-list platforms.' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Starting platform ids; omit to let the planner route by intent.' },
        budgetMs: { type: 'number', description: 'Wall-clock budget in ms (3000-60000, default 12000).' },
        maxRounds: { type: 'number', description: 'Max search waves (1-3, default 3).' },
        minItems: { type: 'number', description: 'Items needed to stop early (1-20, default 6).' },
        quorumPlatforms: { type: 'number', description: 'Distinct platforms needed (1-8, default 3).' },
        quorumKinds: { type: 'number', description: 'Distinct result kinds needed (1-6, default 2).' },
        limit: { type: 'number', description: 'Raw results per platform per wave (1-30).' },
        pages: { type: 'number', description: 'Pages per backend (1-4).' },
        refresh: { type: 'boolean', description: 'Bypass cache.' },
      },
      additionalProperties: false,
    },
    run: toolResearch,
  },
  {
    name: 'web_scout_health',
    description: 'Probe native search backends now and report which ones actually work (ok / empty / blocked / login / error) with latency.',
    inputSchema: {
      type: 'object',
      properties: {
        platforms: { type: 'array', items: { type: 'string' }, description: 'Only check these ids; omit for all native backends.' },
        query: { type: 'string', description: 'Probe keyword (default "cordis").' },
        timeoutMs: { type: 'number', description: 'Per-platform timeout (2000-20000).' },
        deep: { type: 'boolean', description: 'Also probe site: fallback platforms (slower).' },
        concurrency: { type: 'number', description: 'Parallel probes (1-8, default 4).' },
      },
      additionalProperties: false,
    },
    run: toolHealth,
  },
  {
    name: 'web_scout_providers',
    description: 'List the search providers available to web-scout (built-in, external and custom), with kind and capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: toolProviders,
  },
];

// ---------------------------------------------------------------- JSON-RPC
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleToolCall(id, params) {
  const name = params && typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) {
    reply(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
    return;
  }
  const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try {
    const { payload, text } = await tool.run(args);
    reply(id, { content: [{ type: 'text', text }], structuredContent: payload, isError: false });
  } catch (error) {
    const message = String((error && error.message) || error);
    log(`工具 ${name} 失败：`, message);
    reply(id, { content: [{ type: 'text', text: `执行失败：${message}` }], isError: true });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'web-scout 提供联网检索与正文读取：web_scout_search 搜索（可用平台名）、web_scout_read 抓正文、web_scout_providers 看可用平台。结果默认带缓存。',
      });
      return;
    }
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    case 'shutdown':
      if (!isNotification) reply(id, {});
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (!isNotification) fail(id, -32601, `未实现的方法：${method}`);
  }
}

function onPayload(raw) {
  const text = String(raw || '').trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    fail(null, -32700, `JSON 解析失败：${error.message}`);
    return;
  }
  const list = Array.isArray(message) ? message : [message];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    Promise.resolve()
      .then(() => handle(item))
      .catch((error) => {
        log('处理消息失败：', String((error && error.message) || error));
        if (item.id !== undefined) fail(item.id, -32603, `内部错误：${String((error && error.message) || error)}`);
      });
  }
}

// ---------------------------------------------------------------- 传输层
let buffer = '';

function feed(chunk) {
  buffer += chunk;
  // 兼容 LSP 式 Content-Length 头
  for (;;) {
    const trimmed = buffer.replace(/^\s+/, '');
    if (/^Content-Length:/i.test(trimmed)) {
      const headerEnd = trimmed.indexOf('\r\n\r\n') >= 0 ? trimmed.indexOf('\r\n\r\n') : trimmed.indexOf('\n\n');
      if (headerEnd < 0) return;
      const header = trimmed.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = trimmed.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + (trimmed.indexOf('\r\n\r\n') >= 0 ? 4 : 2);
      if (trimmed.length < bodyStart + length) return;
      const body = trimmed.slice(bodyStart, bodyStart + length);
      buffer = trimmed.slice(bodyStart + length);
      onPayload(body);
      continue;
    }
    const newline = trimmed.indexOf('\n');
    if (newline < 0) {
      buffer = trimmed;
      return;
    }
    const line = trimmed.slice(0, newline);
    buffer = trimmed.slice(newline + 1);
    if (line.trim() !== '') onPayload(line);
  }
}

async function main() {
  await ensureStore();
  try {
    const report = await initProviders();
    log(`providers ready: builtin=${report.builtin} external=${report.external.length} platforms=${report.platforms}`);
    if (report.errors && report.errors.length > 0) log('provider 错误：', JSON.stringify(report.errors));
  } catch (error) {
    log('provider 初始化失败（继续用内置）：', String((error && error.message) || error));
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdin.on('end', () => {
    try {
      getCache().close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  });
  process.stdin.on('error', (error) => log('stdin 出错：', String(error && error.message)));
  process.on('uncaughtException', (error) => log('uncaught:', String((error && error.stack) || error)));
  process.on('unhandledRejection', (error) => log('unhandled:', String((error && error.message) || error)));
  log(`started (pid ${process.pid}), protocol ${SUPPORTED_PROTOCOLS.join(' / ')}`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n用法：node mcp/server.mjs\n传输：stdio（换行分隔 JSON，兼容 Content-Length）\n工具：web_scout_search / web_scout_read / web_scout_providers\n`);
  process.exit(0);
}

main();