import {
  runSearch,
  readPage,
  platformCatalog,
  inferPlatforms,
  cleanQuery,
  resolvePlatforms,
  contextQuery,
  browserUrlFor,
  registerCustomPlatforms,
  customPlatformId,
  packEvidence,
  formatEvidence,
  checkPlatforms,
  formatHealth,
  planQuery,
  planWaves,
  research as runResearch,
  hotSnapshotOf,
  hotTrendOf,
  withHotTrend,
  crossResonance,
  PLATFORMS,
} from './engines.js';
import { openInBrowser } from './open.js';
import { mergeCookies } from './browserCookies.js';
import { checkLogin, loginTarget, cookieMapFromPaste, cookiesForDomain } from './login.js';
import { ensureBrowserSession, captureBrowserCookies, browserStatus, closeBrowserSession } from './browserAuth.js';
import { createCache } from './cache.js';

const MAX_BODY = 256 * 1024;

function messageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ');
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function summarize(result) {
  return {
    query: result.query,
    mode: result.mode,
    tunnelSuggested: result.tunnelSuggested,
    blocked: result.blocked,
    platforms: result.platforms.map((entry) => ({
      id: entry.id,
      label: entry.label,
      status: entry.status,
      note: entry.note,
      count: entry.count,
      browser: entry.browser,
      backend: entry.backend,
      kind: entry.kind || 'web',
      login: entry.login === true,
    })),
    results: result.results.slice(0, 150),
  };
}

/**
 * Creates the JSON endpoint used by the dock widget.
 * Every operation answers `{ ok: true, data }` or `{ ok: false, error: { message } }`.
 */
const SEARCH_CACHE_VERSION = 's1';

function cacheKeyFor(settings, parts) {
  return [SEARCH_CACHE_VERSION, settings.proxy ? 'proxy' : 'direct', parts.join('|')].join('::');
}

function searchCacheKey(settings, query, platforms, limit, pages) {
  return cacheKeyFor(settings, ['search', query.trim().toLowerCase(), platforms.join(','), String(limit), String(pages)]);
}

function evidenceCacheKey(settings, query, platforms, pack) {
  return [
    'ev1',
    settings.proxy || 'direct',
    query,
    platforms.join(','),
    pack.budgetChars,
    pack.maxItems,
    pack.perPlatform,
    pack.excerptChars,
  ].join('::');
}

function readCacheKey(url) {
  return ['p1', url].join('::');
}

const DEFAULT_CACHE_TTL = 6 * 60 * 60 * 1000;
const CACHE_TTL_MIN = 60 * 1000;
const CACHE_TTL_MAX = 24 * 60 * 60 * 1000;

/** 每次写入都按当前配置算 TTL，所以改 cacheTtlMs 立刻生效（不用重启 Host）。 */
function ttlFrom(settings) {
  const raw = Number(settings && settings.cacheTtlMs);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CACHE_TTL;
  return Math.min(CACHE_TTL_MAX, Math.max(CACHE_TTL_MIN, raw));
}

export function createApi({ store, defaults, readMessages, clientGraph, cache: injectedCache, providers: providerBridge }) {
  const cache =
    injectedCache ||
    createCache({
      ttlMs: Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(defaults.cacheTtlMs) || 6 * 60 * 60 * 1000)),
    });
  function syncCustomPlatforms() {
    registerCustomPlatforms(store.get('customPlatforms'));
  }

  // cookie 是凭据：面板只需要知道「哪些域名有登录态」，不能拿到原始值。
  function redactSettings(settings) {
    const cookies = settings.cookies || {};
    const hosts = {};
    for (const [host, raw] of Object.entries(cookies)) {
      const count = String(raw)
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair !== '').length;
      hosts[host] = count;
    }
    return { ...settings, cookies: undefined, cookieHosts: hosts, cookieCount: Object.keys(hosts).length };
  }

  // 榜单类平台的「上一次」快照：用来算名次变化、新上榜、热度涨幅，以及跨榜同题共振。
  // 只碰 list:true 的平台；关键词搜索不受影响。
  function decorateHot(result) {
    const entries = Array.isArray(result && result.platforms) ? result.platforms : [];
    const snapshots = { ...(store.get('hotSnapshot') || {}) };
    const trendsByUrl = new Map();
    const resonanceRows = [];
    const intel = {};
    let touched = false;

    for (const entry of entries) {
      if (!entry || entry.status !== 'ok' || !Array.isArray(entry.results) || entry.results.length === 0) continue;
      const def = PLATFORMS.get(entry.id);
      if (!def || def.list !== true) continue;
      const prev = snapshots[entry.id];
      const trends = hotTrendOf(prev, entry.results);
      trends.forEach((trend) => {
        if (trend && trend.url) trendsByUrl.set(trend.url, trend);
      });
      snapshots[entry.id] = hotSnapshotOf(entry.results);
      touched = true;
      const fresh = trends.filter((trend) => trend.isNew).length;
      const moved = trends.filter((trend) => trend.rankDelta !== 0).length;
      intel[entry.id] = { at: snapshots[entry.id].at, size: trends.length, fresh, moved };
      entry.results.forEach((item) => resonanceRows.push(item));
    }

    if (!touched) return { result, intel };

    // 快照只留最近 8 个平台，别把 store 撑爆
    const ids = Object.keys(snapshots);
    if (ids.length > 8) {
      const keep = new Set(ids.slice(-8));
      for (const id of ids) if (!keep.has(id)) delete snapshots[id];
    }
    store.patch({ hotSnapshot: snapshots });

    const withTrend = (item) => {
      const trend = trendsByUrl.get(item && item.url);
      if (!trend) return item;
      return {
        ...item,
        extra: {
          ...(item.extra || {}),
          trend: {
            rank: trend.rank,
            prevRank: trend.prevRank,
            rankDelta: trend.rankDelta,
            hot: trend.hot,
            hotDelta: trend.hotDelta,
            isNew: trend.isNew,
          },
        },
      };
    };

    const decoratedFlat = (result.results || []).map(withTrend);
    const resonated = crossResonance(decoratedFlat);
    const decoratedEntries = entries.map((entry) =>
      entry && Array.isArray(entry.results) ? { ...entry, results: entry.results.map(withTrend) } : entry,
    );
    return { result: { ...result, platforms: decoratedEntries, results: resonated }, intel };
  }

  function catalogPayload(settings) {
    return {
      platforms: platformCatalog(),
      config: redactSettings(settings),
      defaults,
      chips: Array.isArray(settings.chips) ? settings.chips : defaults.chips,
      accounts: settings.accounts || {},
      customPlatforms: settings.customPlatforms || [],
    };
  }

  async function verify(platform) {
    const settings = store.snapshot();
    const verdict = await checkLogin({
      platform,
      cookies: settings.cookies || {},
      proxy: settings.proxy || undefined,
      timeoutMs: Math.min(20000, settings.timeoutMs),
    });
    const accounts = { ...(settings.accounts || {}) };
    accounts[verdict.platform] = {
      loggedIn: verdict.loggedIn,
      name: verdict.name,
      note: verdict.note,
      checkedAt: verdict.checkedAt,
    };
    store.patch({ accounts });
    return verdict;
  }

  function dropCookies(platform) {
    const target = loginTarget(platform);
    if (!target) throw new Error(`未知平台：${platform}`);
    const settings = store.snapshot();
    const cookies = { ...(settings.cookies || {}) };
    const want = String(target.domain || '').replace(/^\./, '').toLowerCase();
    for (const host of Object.keys(cookies)) {
      const clean = host.replace(/^\./, '').toLowerCase();
      if (clean === want || clean.endsWith(`.${want}`)) delete cookies[host];
    }
    const accounts = { ...(settings.accounts || {}) };
    delete accounts[target.id];
    store.patch({ cookies, accounts });
    return { platform: target.id, removed: Object.keys(settings.cookies || {}).length - Object.keys(cookies).length };
  }

  async function perform(op, payload) {
    const settings = store.snapshot();
    const proxy = settings.proxy || undefined;

    switch (op) {
      case 'catalog': {
        return catalogPayload(settings);
      }
      case 'search': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        let messages = [];
        if (sessionId !== '' && typeof readMessages === 'function') {
          try {
            messages = readMessages(sessionId) || [];
          } catch {
            messages = [];
          }
        }
        const context = typeof payload.context === 'string' ? payload.context : '';
        const hinted = inferPlatforms(`${payload.query || ''} ${context} ${messages.slice(-6).map(messageText).join(' ').slice(-600)}`);
        // 「自动」= 默认平台 + 从这句话/上下文里识别出的站点；只用默认两个引擎时结果会显得很少。
        const platforms = resolvePlatforms(
          payload.platforms && payload.platforms.length > 0 ? payload.platforms : ['auto'],
          settings.defaultPlatforms,
          hinted,
        ).slice(0, settings.maxPlatforms);
        // 纯信息流（抖音热榜 / 知乎推荐 / 知乎关注）与关键词无关，别把对话内容硬塞成查询词。
        const feedOnly = platforms.length > 0 && platforms.every((id) => {
          const def = PLATFORMS.get(id);
          return Boolean(def && def.list === true);
        });
        let query = cleanQuery(payload.query || '');
        if (query === '' && messages.length > 0 && !feedOnly) query = contextQuery(messages, context);
        if (query === '' && context !== '' && !feedOnly) query = cleanQuery(context).split(/\s+/).slice(0, 12).join(' ');
        if (query === '' && !feedOnly) throw new Error('缺少查询词');
        const limit = Math.min(30, Math.max(1, Number(payload.limit) || settings.limit));
        const pages = Math.min(4, Math.max(1, Number(payload.pages) || Number(settings.pages) || 3));
        const timeoutMs = Math.min(30000, Math.max(3000, Number(payload.timeoutMs) || settings.timeoutMs));
        const key = searchCacheKey(settings, query, platforms, limit, pages);
        const cached = payload.refresh === true ? undefined : cache.get(key);
        if (cached !== undefined) {
          const hot = decorateHot(cached.value);
          const data = summarize(hot.result);
          data.trend = hot.intel;
          data.cached = true;
          data.cacheAgeMs = cached.ageMs;
          data.cacheSource = cached.source;
          if (payload.open === true) {
            const first = data.results.find((item) => /^https?:\/\//i.test(item.url));
            if (first) data.opened = openInBrowser(first.url);
          }
          return data;
        }
        const result = await runSearch({
          query,
          platforms,
          limit,
          pages,
          timeoutMs,
          proxy,
          cookies: settings.cookies || {},
        });
        cache.set(key, result, ttlFrom(settings));
        const hot = decorateHot(result);
        const data = summarize(hot.result);
        data.trend = hot.intel;
        data.cached = false;
        if (payload.open === true) {
          const first = data.results.find((item) => /^https?:\/\//i.test(item.url));
          if (first) data.opened = openInBrowser(first.url);
        }
        return data;
      }
      case 'open': {
        const explicit = String(payload.url || '').trim();
        const url =
          explicit !== ''
            ? explicit
            : browserUrlFor(
                String(payload.platform || settings.defaultPlatforms[0] || 'bing'),
                String(payload.query || ''),
              );
        if (url === '') throw new Error('缺少 url');
        return openInBrowser(url);
      }
      case 'read': {
        const url = String(payload.url || '').trim();
        if (url === '') throw new Error('缺少 url');
        const maxChars = Math.min(20000, Math.max(500, Number(payload.maxChars) || 6000));
        const key = readCacheKey(url) + '::' + String(maxChars);
        const cached = payload.refresh === true ? undefined : cache.get(key);
        if (cached !== undefined) {
          return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs, cacheSource: cached.source };
        }
        const page = await readPage({ url, proxy, maxChars, timeoutMs: settings.timeoutMs });
        cache.set(key, page, ttlFrom(settings));
        return { ...page, cached: false };
      }
      case 'evidence': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        let messages = [];
        if (sessionId !== '' && typeof readMessages === 'function') {
          try {
            messages = readMessages(sessionId) || [];
          } catch {
            messages = [];
          }
        }
        const context = typeof payload.context === 'string' ? payload.context : '';
        const hinted = inferPlatforms(`${payload.query || ''} ${context} ${messages.slice(-6).map(messageText).join(' ').slice(-600)}`);
        const platforms = resolvePlatforms(
          payload.platforms && payload.platforms.length > 0 ? payload.platforms : ['auto'],
          settings.defaultPlatforms,
          hinted,
        ).slice(0, settings.maxPlatforms);
        const feedOnly = platforms.length > 0 && platforms.every((id) => {
          const def = PLATFORMS.get(id);
          return Boolean(def && def.list === true);
        });
        let query = cleanQuery(payload.query || '');
        if (query === '' && messages.length > 0 && !feedOnly) query = contextQuery(messages, context);
        if (query === '' && context !== '' && !feedOnly) query = cleanQuery(context).split(/\s+/).slice(0, 12).join(' ');
        if (query === '' && !feedOnly) throw new Error('缺少查询词');
        const limit = Math.min(30, Math.max(1, Number(payload.limit) || settings.limit));
        const pages = Math.min(4, Math.max(1, Number(payload.pages) || Number(settings.pages) || 3));
        const timeoutMs = Math.min(30000, Math.max(3000, Number(payload.timeoutMs) || settings.timeoutMs));
        const packOptions = {
          budgetChars: Math.min(20000, Math.max(800, Number(payload.budgetChars) || 6000)),
          maxItems: Math.min(20, Math.max(1, Number(payload.maxItems) || 10)),
          perPlatform: Math.min(8, Math.max(1, Number(payload.perPlatform) || 3)),
          excerptChars: Math.min(600, Math.max(80, Number(payload.excerptChars) || 240)),
        };
        const key = evidenceCacheKey(settings, query, platforms, packOptions);
        const cached = payload.refresh === true ? undefined : cache.get(key);
        if (cached !== undefined) {
          return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs, cacheSource: cached.source };
        }
        const result = await runSearch({ query, platforms, limit, pages, timeoutMs, proxy, cookies: settings.cookies || {} });
        const packed = packEvidence({
          query: result.query,
          results: result.results,
          platforms: result.platforms,
          ...packOptions,
        });
        const data = {
          ...packed,
          text: formatEvidence(packed),
          tunnelSuggested: result.tunnelSuggested,
          mode: result.mode,
          sessionId,
          cached: false,
        };
        cache.set(key, data, ttlFrom(settings));
        return data;
      }
      case 'plan': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        let messages = [];
        if (sessionId !== '' && typeof readMessages === 'function') {
          try {
            messages = readMessages(sessionId) || [];
          } catch {
            messages = [];
          }
        }
        const context = typeof payload.context === 'string' ? payload.context : '';
        const hinted = inferPlatforms(`${payload.query || ''} ${context}`);
        let planQueryText = cleanQuery(payload.query || '');
        if (planQueryText === '') planQueryText = contextQuery(messages, context);
        const plan = planQuery({
          query: planQueryText,
          platforms: Array.isArray(payload.platforms) ? payload.platforms : [],
          hints: hinted,
          maxPlatforms: settings.maxPlatforms,
        });
        const waves = planWaves(plan, { maxRounds: payload.maxRounds, maxPlatforms: settings.maxPlatforms });
        return { ...plan, waves, sessionId };
      }
      case 'research': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        let messages = [];
        if (sessionId !== '' && typeof readMessages === 'function') {
          try {
            messages = readMessages(sessionId) || [];
          } catch {
            messages = [];
          }
        }
        const context = typeof payload.context === 'string' ? payload.context : '';
        const hinted = inferPlatforms(`${payload.query || ''} ${context} ${messages.slice(-6).map(messageText).join(' ').slice(-600)}`);
        const platforms = resolvePlatforms(
          payload.platforms && payload.platforms.length > 0 ? payload.platforms : ['auto'],
          settings.defaultPlatforms,
          hinted,
        ).slice(0, settings.maxPlatforms);
        let query = cleanQuery(payload.query || '');
        const feedOnly = platforms.length > 0 && platforms.every((id) => {
          const def = PLATFORMS.get(id);
          return Boolean(def && def.list === true);
        });
        if (query === '' && messages.length > 0 && !feedOnly) query = contextQuery(messages, context);
        if (query === '' && context !== '' && !feedOnly) query = cleanQuery(context).split(/\s+/).slice(0, 12).join(' ');
        const budgetMs = Math.min(60000, Math.max(3000, Number(payload.budgetMs) || 12000));
        const maxRounds = Math.min(3, Math.max(1, Number(payload.maxRounds) || 3));
        const minItems = Math.min(20, Math.max(1, Number(payload.minItems) || 6));
        const quorumPlatforms = Math.min(8, Math.max(1, Number(payload.quorumPlatforms) || 3));
        const quorumKinds = Math.min(6, Math.max(1, Number(payload.quorumKinds) || 2));
        const limit = Math.min(30, Math.max(1, Number(payload.limit) || settings.limit));
        const pages = Math.min(4, Math.max(1, Number(payload.pages) || Number(settings.pages) || 3));
        const timeoutMs = Math.min(30000, Math.max(3000, Number(payload.timeoutMs) || settings.timeoutMs));
        const packOptions = {
          budgetChars: Math.min(20000, Math.max(800, Number(payload.budgetChars) || 6000)),
          maxItems: Math.min(20, Math.max(1, Number(payload.maxItems) || 10)),
          perPlatform: Math.min(8, Math.max(1, Number(payload.perPlatform) || 3)),
          excerptChars: Math.min(600, Math.max(80, Number(payload.excerptChars) || 240)),
        };
        const key = [
          'rs1',
          proxy || 'direct',
          query,
          platforms.join(','),
          limit,
          pages,
          budgetMs,
          maxRounds,
          minItems,
          quorumPlatforms,
          quorumKinds,
          JSON.stringify(packOptions),
        ].join('::');
        const cached = payload.refresh === true ? undefined : cache.get(key);
        if (cached !== undefined) {
          return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs, cacheSource: cached.source };
        }
        const result = await runResearch({
          query,
          platforms,
          budgetMs,
          maxRounds,
          minItems,
          quorumPlatforms,
          quorumKinds,
          limit,
          pages,
          timeoutMs,
          proxy,
          cookies: settings.cookies || {},
          ...packOptions,
        });
        const data = { ...result, sessionId, cached: false };
        // 空结果不写缓存：一次风控/超时不该把 6 小时的查询钉成「没结果」。
        if ((result.quality && result.quality.items) > 0) cache.set(key, data, ttlFrom(settings));
        return data;
      }
      case 'health.check': {
        const report = await checkPlatforms({
          platforms: Array.isArray(payload.platforms) ? payload.platforms : [],
          defaultPlatforms: settings.defaultPlatforms,
          query: typeof payload.query === 'string' && payload.query.trim() !== '' ? payload.query : 'cordis',
          timeoutMs: Math.min(20000, Math.max(2000, Number(payload.timeoutMs) || 8000)),
          deep: payload.deep === true,
          concurrency: Math.min(8, Math.max(1, Number(payload.concurrency) || 4)),
          proxy,
          cookies: settings.cookies || {},
        });
        return { ...report, text: formatHealth(report) };
      }
      case 'config': {
        return redactSettings(store.patch(payload.patch || {}));
      }
      case 'provider.list': {
        const state = providerBridge && typeof providerBridge.state === 'function' ? providerBridge.state() : { report: null, error: '' };
        return {
          providers: providerBridge && typeof providerBridge.list === 'function' ? providerBridge.list() : [],
          platforms: providerBridge && typeof providerBridge.platformCount === 'function' ? providerBridge.platformCount() : 0,
          dir: state.report ? state.report.dir : '',
          external: state.report ? state.report.external : [],
          skipped: state.report ? state.report.skipped : true,
          errors: state.report ? state.report.errors : [],
          initError: state.error || '',
        };
      }
      case 'provider.reload': {
        if (!providerBridge || typeof providerBridge.reload !== 'function') throw new Error('provider 层没有启用');
        const report = await providerBridge.reload();
        return { ...report, providers: providerBridge.list(), platforms: providerBridge.platformCount() };
      }
      case 'cache.stats': {
        return cache.stats();
      }
      case 'cache.clear': {
        return cache.clear();
      }
      case 'graph': {
        return typeof clientGraph === 'function' ? clientGraph() : { available: false };
      }
      case 'platform.add': {
        const name = String(payload.name || '').trim();
        const url = String(payload.url || '').trim();
        if (name === '' || url === '') throw new Error('站点名称和搜索地址都要填');
        if (!/^https?:\/\//i.test(url)) throw new Error('搜索地址必须以 http:// 或 https:// 开头');
        const site = String(payload.site || '')
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '');
        const list = [...(settings.customPlatforms || [])];
        if (list.some((item) => item.name === name && item.url === url)) throw new Error('这个站点已经添加过了');
        list.push({ id: customPlatformId(name), name, url, site, kind: String(payload.kind || 'auto') });
        const next = store.patch({ customPlatforms: list });
        syncCustomPlatforms();
        return catalogPayload(next);
      }
      case 'platform.remove': {
        const id = String(payload.id || '');
        const label = String(payload.name || '');
        const list = (settings.customPlatforms || []).filter(
          (item) => item.id !== id && !(label !== '' && item.name === label),
        );
        const next = store.patch({
          customPlatforms: list,
          chips: [
            ...new Set(
              (settings.chips || []).filter((chip) => !String(chip).startsWith('custom:') || list.some((item) => item.id === chip)),
            ),
          ],
        });
        syncCustomPlatforms();
        return catalogPayload(next);
      }
      case 'chips': {
        const chips = Array.isArray(payload.chips) ? payload.chips.map((item) => String(item)).slice(0, 12) : [];
        const next = store.patch({ chips });
        return catalogPayload(next);
      }
      case 'login.open': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target || target.url === '') throw new Error('这个站点没有可用的登录入口');
        return {
          ...openInBrowser(target.url),
          target,
          hint: '已在系统浏览器打开登录页。想让插件用上这个登录态：点「插件浏览器」在插件自己的窗口里再登一次，回来点「读取登录」。',
        };
      }
      case 'login.paste': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target) throw new Error(`未知平台：${payload.platform}`);
        const map = cookieMapFromPaste(target.id, payload.cookie);
        store.patch({ cookies: mergeCookies(settings.cookies || {}, map) });
        return verify(target.id);
      }
      case 'login.check': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target) throw new Error(`未知平台：${payload.platform}`);
        // 插件浏览器里已经登录了的话，直接读过来再校验——不用手动点「读取登录」
        try {
          const captured = await captureBrowserCookies({ domain: target.domain });
          if (captured.count > 0) {
            store.patch({ cookies: mergeCookies(store.snapshot().cookies || {}, captured.cookies) });
            const verdict = await verify(target.id);
            return { ...verdict, captured: captured.count, source: 'browser' };
          }
        } catch {
          /* 没开插件浏览器就按已存的 cookie 校验 */
        }
        return verify(target.id);
      }
      case 'login.browser': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target || target.url === '') throw new Error('这个站点没有可用的登录入口');
        const session = await ensureBrowserSession({ url: target.url });
        return {
          platform: target.id,
          url: target.url,
          port: session.port,
          profile: session.profile,
          reused: session.reused,
          browser: session.browser,
          hint: session.reused
            ? '已经在插件浏览器里打开登录页，登录完点「读取登录」'
            : '插件浏览器已启动（独立 profile，和你日常浏览器互不影响），登录完点「读取登录」',
        };
      }
      case 'login.capture': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target) throw new Error(`未知平台：${payload.platform}`);
        if (target.domain === '') throw new Error('这个站点没有可识别的域名，无法读取登录状态');
        const captured = await captureBrowserCookies({ domain: target.domain });
        if (captured.count === 0) {
          const verdict = await verify(target.id);
          return {
            ...verdict,
            found: 0,
            hint: '插件浏览器里还没有这个站点的 Cookie：点「插件浏览器」在打开的窗口里登录一次，再点「读取登录」',
          };
        }
        store.patch({ cookies: mergeCookies(settings.cookies || {}, captured.cookies) });
        const verdict = await verify(target.id);
        return { ...verdict, found: captured.count, hosts: Object.keys(captured.cookies), source: 'browser' };
      }
      case 'browser.close': {
        const closed = await closeBrowserSession();
        return { ...closed, ...(await browserStatus()) };
      }
      case 'browser.status': {
        return browserStatus();
      }
      case 'login.clear': {
        const platform = String(payload.platform || '');
        const removed = dropCookies(platform);
        // 清呆 cookie 之后重新判一次，前端直接拿 loggedIn/cookies/note 更新状态点。
        let verdict = null;
        try {
          verdict = await verify(platform);
        } catch {
          verdict = null;
        }
        return { ...removed, ...(verdict || {}), cleared: true, ok: true };
      }
      case 'login.status': {
        const cookies = settings.cookies || {};
        return {
          accounts: settings.accounts || {},
          domains: Object.fromEntries(
            Object.keys(cookies).map((host) => [host, cookiesForDomain(cookies, host).split(';').filter(Boolean).length]),
          ),
        };
      }
      default: {
        throw new Error(`unknown op: ${op}`);
      }
    }
  }

  async function handler(req, res) {
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: { message: 'POST only' } });
      return;
    }
    let payload;
    try {
      payload = await readBody(req);
    } catch (error) {
      send(res, 400, { ok: false, error: { message: String(error && error.message ? error.message : error) } });
      return;
    }
    const op = String(payload.op || '').trim();
    try {
      if (!store.loaded) await store.load();
      syncCustomPlatforms();
      const data = await perform(op, payload);
      send(res, 200, { ok: true, data });
    } catch (error) {
      send(res, 200, { ok: false, error: { message: String((error && error.message) || error) } });
    }
  }

  return { handler, perform };
}