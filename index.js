import {
  platformCatalog,
  inferPlatforms,
  cleanQuery,
  resolvePlatforms,
  contextQuery,
  runSearch,
  readPage,
  packEvidence,
  formatEvidence,
  checkPlatforms,
  formatHealth,
  browserUrlFor,
  initProviders,
  providerCatalog,
  PLATFORMS,
} from './engines.js';
import { openInBrowser } from './open.js';
import { ScoutStore } from './store.js';
import { createApi } from './api.js';
import { createCache } from './cache.js';

export const name = 'web-scout';
export const inject = ['tools', 'webServer'];

const PACKAGE_NAME = '@local/web-scout';
const JSON_OBJECT = { type: 'object', additionalProperties: true };
const ROUTE_PATH = '/web-scout/api';

const blocks = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

function plainText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Read the live transcript of the calling session (best effort: every step is optional). */
function transcript(ctx, exec) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
  let id = exec && exec.agent ? exec.agent.id : undefined;
  if (!id && agents && typeof agents.currentInitiator === 'function') {
    const current = agents.currentInitiator();
    id = current ? current.id : undefined;
  }
  if (!sessions || typeof sessions.get !== 'function' || !id) return { id, messages: [] };
  try {
    const session = sessions.get(id);
    const messages = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
    return { id, messages: Array.isArray(messages) ? messages : [] };
  } catch {
    return { id, messages: [] };
  }
}

function conversationText(messages, count = 6) {
  const rows = [];
  for (let index = messages.length - 1; index >= 0 && rows.length < count; index -= 1) {
    const message = messages[index];
    const role = message && message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = plainText(message).trim();
    if (text !== '') rows.unshift(`${role}: ${text.slice(0, 600)}`);
  }
  return rows.join('\n');
}

function firstBrowserUrl(result) {
  const found = result.results.find((item) => /^https?:\/\//i.test(item.url));
  return found ? found.url : '';
}

function searchReport(value) {
  const lines = [];
  const platforms = value.platforms || [];
  lines.push(`搜索「${value.query}」 · 平台：${platforms.map((entry) => entry.label).join('、') || '无'} · 命中 ${value.results.length} 条`);
  value.results.slice(0, 8).forEach((item, index) => {
    lines.push(`${index + 1}. [${item.platformLabel}] ${item.title}`);
    lines.push(`   ${item.url}`);
    if (item.snippet) lines.push(`   ${item.snippet.replace(/\s+/g, ' ').slice(0, 160)}`);
  });
  const status = platforms.map((entry) => {
    const suffix = entry.note && entry.note !== `${entry.note}` ? ` ${entry.note}` : '';
    return `${entry.label}:${entry.status}${entry.count ? `/${entry.count}` : ''}${entry.status === 'ok' ? '' : suffix}`;
  });
  lines.push(`平台状态：${status.join('、')}`);
  const blocked = platforms.filter((entry) => entry.status !== 'ok');
  if (blocked.length > 0) {
    lines.push('浏览器入口：');
    blocked.slice(0, 4).forEach((entry) => lines.push(`- ${entry.label}: ${entry.browser}`));
  }
  if (value.tunnelSuggested) lines.push('提示：部分站点在直连环境不可达，可用 web_scout_open 在桌面浏览器打开，或使用 /web-scout 面板设置代理。');
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const store = new ScoutStore(config.file);
  const defaults = {
    limit: Number(config.limit) || 12,
    timeoutMs: Number(config.timeoutMs) || 12000,
    maxPlatforms: Number(config.maxPlatforms) || 10,
    cacheTtlMs: Number(config.cacheTtlMs) || 6 * 60 * 60 * 1000,
    defaultPlatforms: Array.isArray(config.defaultPlatforms) && config.defaultPlatforms.length > 0 ? config.defaultPlatforms : ['bing', 'so360', 'csdn', 'juejin', 'toutiao', 'v2ex', 'zhihu', 'bilibili', 'weixin'],
  };
  const ready = store.load().catch(() => {});

  async function settings() {
    await ready;
    return store.snapshot();
  }

  /** Host-side view of the client-modules table (the service that serves the dock bundle). */
  function clientModules() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined;
    } catch {
      return undefined;
    }
  }

  function clientGraph() {
    const modules = clientModules();
    if (!modules || typeof modules.graph !== 'function') return { available: false, package: PACKAGE_NAME };
    let clientPath;
    try {
      clientPath = typeof modules.clientPath === 'function' ? modules.clientPath(PACKAGE_NAME) : undefined;
    } catch {
      clientPath = undefined;
    }
    let rev = '';
    let entries = [];
    try {
      const graph = modules.graph();
      rev = (graph && graph.rev) || '';
      entries = Array.isArray(graph && graph.entries) ? graph.entries.map((entry) => entry.id) : [];
    } catch {
      /* ignore */
    }
    return {
      available: true,
      package: PACKAGE_NAME,
      composed: Boolean(clientPath),
      clientPath: clientPath || null,
      has: entries.includes(PACKAGE_NAME),
      rev,
      count: entries.length,
      tail: entries.slice(-6),
    };
  }

  /**
   * A bundle installed into an already-running host can miss the client-modules
   * reconciliation (its flush reruns only for Loader events), which leaves the
   * dock with no served client bundle at all. Push our own name through the same
   * incremental path the scan uses.
   */
  function healClientModules() {
    const modules = clientModules();
    if (!modules || typeof modules.flush !== 'function') return false;
    try {
      if (typeof modules.clientPath === 'function' && modules.clientPath(PACKAGE_NAME)) return true;
    } catch {
      /* ignore */
    }
    try {
      if (!modules.dirty || typeof modules.dirty.add !== 'function') return false;
      modules.dirty.add(PACKAGE_NAME);
      modules.flush((error) => {
        try {
          ctx.logger?.warn?.('web-scout: client-modules flush: %s', String((error && error.message) || error));
        } catch {
          /* ignore */
        }
      });
    } catch (error) {
      try {
        ctx.logger?.warn?.('web-scout: client-modules heal: %s', String((error && error.message) || error));
      } catch {
        /* ignore */
      }
    }
    try {
      if (modules.clientPath && modules.clientPath(PACKAGE_NAME) && typeof modules.rebuilt === 'function') {
        modules.rebuilt(PACKAGE_NAME);
      }
    } catch (error) {
      try {
        ctx.logger?.warn?.('web-scout: client-modules rebuilt: %s', String((error && error.message) || error));
      } catch {
        /* ignore */
      }
    }
    try {
      return Boolean(modules.clientPath && modules.clientPath(PACKAGE_NAME));
    } catch {
      return false;
    }
  }

  // 搜索与正文读取共用一份缓存（内存 LRU + SQLite），工具与面板谁先查谁写。
  const cache = createCache({
    ttlMs: Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(defaults.cacheTtlMs) || 6 * 60 * 60 * 1000)),
  });
  // provider 层（v1.15）：内置 provider + 外部 web-scout-providers/*.mjs。
  // 初始化失败只降级（继续用内置），不能把插件整体搞挂。
  const providerState = { report: null, error: '' };
  const startupProviders = initProviders()
    .then((report) => {
      providerState.report = report;
      return report;
    })
    .catch((error) => {
      providerState.error = String((error && error.message) || error);
      ctx.logger?.warn?.('web-scout: provider init failed: ' + providerState.error);
      return null;
    });

  const api = createApi({
    store,
    defaults,
    clientGraph,
    cache,
    providers: {
      list: () => providerCatalog(),
      reload: async () => initProviders(),
      state: () => providerState,
      platformCount: () => PLATFORMS.size,
    },
    readMessages: (sessionId) => {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      if (!sessions || typeof sessions.get !== 'function') return [];
      try {
        const session = sessions.get(sessionId);
        const messages = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
        return Array.isArray(messages) ? messages : [];
      } catch {
        return [];
      }
    },
  });

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: api.handler,
    }),
  );

  ctx.effect(() => {
    const timers = [0, 300, 1200, 3000].map((delay) => setTimeout(() => healClientModules(), delay));
    return () => timers.forEach((timer) => clearTimeout(timer));
  });

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'web-scout',
        order: 62,
        text: [
          '## web-scout（联网检索）',
          '- 当用户要求「搜一下/查一下/看看网上怎么说」，或需要平台内检索（知乎、B站、CSDN、掘金、GitHub、小红书、淘宝……）时，调用 `web_scout_search`。',
          '- `web_scout_search` 会从当前对话自动提取检索词（`query` 可省略），并自动识别用户提到的平台；`platforms` 可显式指定。',
          '- 直连环境常见不可达站点（Google、YouTube、Wikipedia、Reddit 等）会返回 `blocked`/`error` 状态与浏览器入口，此时用 `web_scout_open` 在桌面浏览器打开。',
          '- 需要正文时用 `web_scout_read` 抓取单页正文，再作答并给出链接。',
        ].join('\n'),
      }),
    );
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'web_scout_search',
      description:
        'Search the web (Bing/360 + platform-scoped: 知乎、CSDN、掘金、B站、GitHub、小红书、淘宝等). Query can be omitted: it is derived from the current conversation. Returns titles, URLs, snippets, per-platform status, and browser fallback URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords. Omit to derive from the current conversation.' },
          platforms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Platform ids or Chinese names: bing, so360, zhihu, bilibili, csdn, juejin, github, xiaohongshu, weibo, douyin, taobao, jd, zhihu, wikipedia, npm, stackoverflow ... "auto" expands to defaults.',
          },
          limit: { type: 'number', description: 'Results per platform (1-30).' },
        pages: { type: 'number', description: 'Pages fetched per backend (1-4, default 2).' },
          timeoutMs: { type: 'number', description: 'Per-platform timeout in ms (3000-30000).' },
          context: { type: 'string', description: 'Conversation text to derive the query from when `query` is empty.' },
          open: { type: 'boolean', description: 'Open the first result in the desktop browser.' },
        },
        required: [],
      },
      output: {
        schema: JSON_OBJECT,
        render: (_args, value) => blocks(searchReport(value)),
        presentationMeta: (args, value) => ({ query: value && value.query, count: value && value.results ? value.results.length : 0 }),
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.query ? `联网检索：${args.query}` : '联网检索（按对话内容推断）',
        kind: 'search',
        rawInput: args,
      }),
      presentResult: (_args, result) => {
        const value = result && result.value ? result.value : undefined;
        if (!value || !Array.isArray(value.results)) return { card: 'generic', title: '联网检索完成' };
        return {
          card: 'web',
          kind: 'search',
          title: `搜索「${value.query}」`,
          sources: value.results.slice(0, 12).map((item) => ({ url: item.url, title: item.title, snippet: item.snippet })),
          truncated: value.results.length > 12,
        };
      },
      execute: async (args, exec) => {
        const options = args && typeof args === 'object' ? args : {};
        // provider 层还在加载时最多等 3 秒，避免首个搜索跑在没有外部 provider 的旧表上。
        await Promise.race([startupProviders, new Promise((resolve) => setTimeout(resolve, 3000))]);
        const current = await settings();
        const hint = transcript(ctx, exec);
        const messages = hint.messages;
        const conversation = conversationText(messages);
        let query = cleanQuery(options.query || '');
        if (query === '') query = contextQuery(messages, options.context || '');
        if (query === '') throw new Error('未提供查询词，也无法从当前对话推断');
        const hinted = inferPlatforms(`${options.query || ''} ${conversation} ${options.context || ''}`);
        const platforms = resolvePlatforms(
          Array.isArray(options.platforms) && options.platforms.length > 0 ? options.platforms : ['auto'],
          current.defaultPlatforms.length > 0 ? current.defaultPlatforms : defaults.defaultPlatforms,
          hinted,
        ).slice(0, current.maxPlatforms || defaults.maxPlatforms);
        const limit = Math.min(20, Math.max(1, Number(options.limit) || current.limit || defaults.limit));
        const pages = Math.min(4, Math.max(1, Number(options.pages) || Number(current.pages) || defaults.pages || 2));
        const timeoutMs = Math.min(30000, Math.max(3000, Number(options.timeoutMs) || current.timeoutMs || defaults.timeoutMs));
        const cacheKey = [
          'tool1',
          current.proxy ? 'proxy' : 'direct',
          query.trim().toLowerCase(),
          platforms.join(','),
          String(limit),
          String(pages),
        ].join('::');
        const cached = options.refresh === true ? undefined : cache.get(cacheKey);
        if (cached !== undefined) {
          return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs };
        }
        const result = await runSearch({
          query,
          platforms,
          limit,
          pages,
          timeoutMs,
          proxy: current.proxy || undefined,
          cookies: current.cookies || {},
        });
        store.record({
          at: new Date().toISOString(),
          query: result.query,
          platforms: result.platforms.map((entry) => entry.id),
          count: result.results.length,
          top: result.results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
          origin: 'tool',
          session: hint.id,
        });
        const opened = options.open === true ? openInBrowser(firstBrowserUrl(result) || result.platforms[0]?.browser || 'https://www.bing.com') : undefined;
        const payloadOut = {
          query: result.query,
          mode: result.mode,
          sessionId: hint.id || null,
          platforms: result.platforms.map((entry) => ({
            id: entry.id,
            label: entry.label,
            status: entry.status,
            note: entry.note,
            count: entry.count,
            browser: entry.browser,
            backend: entry.backend,
          })),
          results: result.results.slice(0, Math.max(limit * platforms.length, 12)),
          blocked: result.blocked,
          tunnelSuggested: result.tunnelSuggested,
          opened: opened || null,
          cached: false,
        };
        cache.set(cacheKey, payloadOut, Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(current.cacheTtlMs) || defaults.cacheTtlMs)));
        return payloadOut;
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'web_scout_open',
      description:
        'Open a URL (or a platform search page) in the user\'s desktop browser. Use when a site is unreachable from the server side, or the user wants to look at results themselves.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open. Takes precedence over platform/query.' },
          platform: { type: 'string', description: 'Platform id, e.g. zhihu / bilibili / taobao.' },
          query: { type: 'string', description: 'Keywords for the platform search page.' },
        },
        required: [],
      },
      output: {
        schema: JSON_OBJECT,
        render: (_args, value) => blocks(`已在桌面浏览器打开：${value.url}\n${value.command}`),
      },
      presentCall: (args) => ({ card: 'generic', title: `打开浏览器：${(args && (args.url || args.platform)) || '默认搜索'}`, kind: 'fetch', rawInput: args }),
      presentResult: () => ({ card: 'generic', title: '已调用桌面浏览器' }),
      execute: async (args) => {
        const options = args && typeof args === 'object' ? args : {};
        let url = String(options.url || '').trim();
        if (url === '') {
          const platform = String(options.platform || 'bing');
          url = browserUrlFor(platform, cleanQuery(options.query || '') || String(options.query || ''));
        }
        return openInBrowser(url);
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'web_scout_read',
      description: 'Fetch one web page and return its readable text (title, status, truncated flag). Goes through the configured proxy, unlike a bare fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to read.' },
          maxChars: { type: 'number', description: 'Max characters of extracted text (500-20000, default 6000).' },
        },
        required: ['url'],
      },
      output: {
        schema: JSON_OBJECT,
        render: (_args, value) => blocks(`# ${value.title || value.url}\n${value.url} · HTTP ${value.status} · ${value.chars} chars${value.truncated ? '（已截断）' : ''}\n\n${value.text}`),
      },
      presentCall: (args) => ({ card: 'generic', title: `读取网页：${args && args.url}`, kind: 'fetch', rawInput: args }),
      presentResult: (_args, result) => {
        const value = result && result.value ? result.value : {};
        return { card: 'web', kind: 'fetch', title: value.title || value.url, url: value.url || '', statusCode: value.status || 0, truncated: Boolean(value.truncated) };
      },
      execute: async (args) => {
        const options = args && typeof args === 'object' ? args : {};
        const current = await settings();
        return readPage({
      url: options.url,
      maxChars: options.maxChars,
      proxy: current.proxy || undefined,
      timeoutMs: current.timeoutMs,
      cookies: current.cookies || {},
    });
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'web_scout_evidence',
      description:
        'Search and return an EVIDENCE PACK instead of a raw list: top items scored by relevance / freshness / native backend, each with a quoted excerpt, plus per-platform coverage and gaps. Use when you need citable material rather than 50 titles.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; may be empty only for hot-list platforms.' },
          platforms: { type: 'array', items: { type: 'string' }, description: 'Platform ids; omit for configured defaults.' },
          budgetChars: { type: 'number', description: 'Character budget for the pack (800-20000, default 6000).' },
          maxItems: { type: 'number', description: 'Max items in the pack (1-20, default 10).' },
          perPlatform: { type: 'number', description: 'Max items per platform (1-8, default 3).' },
          excerptChars: { type: 'number', description: 'Max excerpt length per item (80-600, default 240).' },
          limit: { type: 'number', description: 'Raw results per platform before packing (1-30).' },
          pages: { type: 'number', description: 'Pages per backend (1-4).' },
          refresh: { type: 'boolean', description: 'Bypass cache.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: JSON_OBJECT,
        render: (_args, value) => blocks((value && value.text) || value),
      },
      presentCall: (args) => ({ card: 'generic', title: `生成证据包：${(args && (args.query || '(榜单)')) || '(榜单)'}`, kind: 'search', rawInput: args }),
      presentResult: (_args, result) => {
        const value = result && result.value ? result.value : {};
        return {
          card: 'web',
          kind: 'search',
          title: `${value.selected || 0} 条证据 · ${(value.coverage || []).length} 个平台 · ${value.usedChars || 0}/${value.budgetChars || 0} 字`,
          sources: (value.items || []).slice(0, 8).map((item) => ({ url: item.url, title: item.title, snippet: item.excerpt })),
          truncated: false,
        };
      },
      execute: async (args, exec) => {
        const options = args && typeof args === 'object' ? args : {};
        const current = await settings();
        const hint = transcript(ctx, exec);
        const platforms = resolvePlatforms(
          options.platforms && options.platforms.length > 0 ? options.platforms : ['auto'],
          current.defaultPlatforms,
          inferPlatforms(`${options.query || ''} ${conversationText(hint.messages).slice(-400)}`),
        ).slice(0, current.maxPlatforms);
        const feedOnly = platforms.length > 0 && platforms.every((id) => {
          const def = PLATFORMS.get(id);
          return Boolean(def && def.list === true);
        });
        let query = cleanQuery(options.query || '');
        if (query === '' && hint.messages.length > 0 && !feedOnly) query = contextQuery(hint.messages, '');
        if (query === '' && !feedOnly) throw new Error('缺少查询词：关键词检索必须给 query（榜单类平台可留空）');
        const limit = Math.min(30, Math.max(1, Number(options.limit) || current.limit));
        const pages = Math.min(4, Math.max(1, Number(options.pages) || current.pages || 3));
        const packOptions = {
          budgetChars: Math.min(20000, Math.max(800, Number(options.budgetChars) || 6000)),
          maxItems: Math.min(20, Math.max(1, Number(options.maxItems) || 10)),
          perPlatform: Math.min(8, Math.max(1, Number(options.perPlatform) || 3)),
          excerptChars: Math.min(600, Math.max(80, Number(options.excerptChars) || 240)),
        };
        const cacheKey = ['tool-ev1', current.proxy || 'direct', query, platforms.join(','), limit, pages, JSON.stringify(packOptions)].join('::');
        if (options.refresh !== true) {
          const hit = cache.get(cacheKey);
          if (hit) return { ...hit.value, cached: true, cacheAgeMs: hit.ageMs, sessionId: hint.id };
        }
        const result = await runSearch({
          query,
          platforms,
          limit,
          pages,
          timeoutMs: current.timeoutMs,
          proxy: current.proxy || '',
          cookies: current.cookies || {},
        });
        const payload = packEvidence({ query: result.query, results: result.results, platforms: result.platforms, ...packOptions });
        const data = {
          ...payload,
          text: formatEvidence(payload),
          mode: result.mode,
          tunnelSuggested: result.tunnelSuggested,
          cached: false,
          sessionId: hint.id,
        };
        cache.set(cacheKey, data, Math.min(86400000, Math.max(60000, Number(current.cacheTtlMs) || 21600000)));
        return data;
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'web_scout_health',
      description:
        'Probe every native search backend right now and report which ones actually work (ok / empty / blocked / login / error) with latency. Use it before blaming a query when results look thin.',
      parameters: {
        type: 'object',
        properties: {
          platforms: { type: 'array', items: { type: 'string' }, description: 'Only check these platform ids; omit for all native backends.' },
          query: { type: 'string', description: 'Probe keyword (default "cordis").' },
          timeoutMs: { type: 'number', description: 'Per-platform timeout (2000-20000).' },
          deep: { type: 'boolean', description: 'Also probe site: fallback platforms (slower).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: JSON_OBJECT,
        render: (_args, value) => blocks((value && value.text) || value),
      },
      presentCall: () => ({ card: 'generic', title: '体检搜索后端', kind: 'execute' }),
      presentResult: (_args, result) => {
        const value = result && result.value ? result.value : {};
        return { card: 'generic', title: `连通性：${value.ok || 0}/${value.total || 0} 可用` };
      },
      execute: async (args) => {
        const options = args && typeof args === 'object' ? args : {};
        const current = await settings();
        const report = await checkPlatforms({
          platforms: Array.isArray(options.platforms) ? options.platforms : [],
          defaultPlatforms: current.defaultPlatforms,
          query: typeof options.query === 'string' && options.query.trim() !== '' ? options.query : 'cordis',
          timeoutMs: Math.min(20000, Math.max(2000, Number(options.timeoutMs) || 8000)),
          deep: options.deep === true,
          proxy: current.proxy || '',
          cookies: current.cookies || {},
        });
        return { ...report, text: formatHealth(report) };
      },
    }),
  );

  return {
    store,
    route: ROUTE_PATH,
    catalog: platformCatalog,
  };
}
// hmr probe 2026-11-12T10:57:31.1540506+08:00
