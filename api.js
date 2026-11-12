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
  PLATFORMS,
} from './engines.js';
import { openInBrowser } from './open.js';
import { importBrowserCookies, mergeCookies } from './browserCookies.js';
import { checkLogin, loginTarget, cookieMapFromPaste, cookiesForDomain } from './login.js';
import { ensureBrowserSession, captureBrowserCookies, browserStatus } from './browserAuth.js';
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

  function catalogPayload(settings) {
    return {
      platforms: platformCatalog(),
      config: settings,
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
          const data = summarize(cached.value);
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
        store.record({
          at: new Date().toISOString(),
          query: result.query,
          platforms: result.platforms.map((entry) => entry.id),
          count: result.results.length,
          top: result.results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
          origin: 'dock',
        });
        const data = summarize(result);
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
      case 'config': {
        return store.patch(payload.patch || {});
      }
      case 'history': {
        return { history: settings.history.slice(0, Math.max(1, Math.min(40, Number(payload.limit) || 12))) };
      }
      case 'clear': {
        return store.clearHistory();
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
          hint: '已在系统浏览器打开登录页。登录完想在插件里生效：点「本机导入」（要先关掉浏览器）或「插件浏览器」在插件窗口里再登一次。',
        };
      }
      case 'login.import': {
        const target = loginTarget(String(payload.platform || ''));
        if (!target) throw new Error(`未知平台：${payload.platform}`);
        if (target.domain === '') throw new Error('这个站点没有可识别的域名，无法导入登录状态');
        const imported = importBrowserCookies(target.domain);
        const merged = mergeCookies(settings.cookies || {}, imported.cookies);
        if (Object.keys(imported.cookies).length > 0) store.patch({ cookies: merged });
        const verdict = await verify(target.id);
        const lockedLabels = imported.locked.map((item) => item.label).join('/');
        return {
          ...verdict,
          imported: imported.sources,
          errors: imported.errors.slice(0, 4),
          found: Object.keys(imported.cookies).length,
          locked: imported.locked,
          hint:
            Object.keys(imported.cookies).length > 0
              ? ''
              : lockedLabels !== ''
                ? `${lockedLabels} 正在运行，cookie 库被锁住了：全部关掉浏览器窗口后再点一次「导入登录状态」，或者在下面直接粘贴 Cookie`
                : '浏览器里没找到这个站点的登录 cookie，先在浏览器登录一次再导入',
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
      case 'browser.status': {
        return browserStatus();
      }
      case 'login.clear': {
        const removed = dropCookies(String(payload.platform || ''));
        return { ...removed, ok: true };
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