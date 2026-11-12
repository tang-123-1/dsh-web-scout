// Platform registry + search backends. Every platform resolves to either a JSON/HTML backend or a site-scoped web search.
import crypto from 'node:crypto';
import { absolutize, createClient, decodeEntities, hostOf, htmlToText, stripTags, titleOf } from './net.js';

const enc = (value) => encodeURIComponent(value);
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export class EngineBlocked extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EngineBlocked';
    this.blocked = true;
    this.browser = options.browser;
  }
}

const LANDING_PATH = /^\/(?:|index|home|hot|explore|discover|search|topics?|channel|so|s|list|sort)$/i;

/** 站点首页、频道页、站内搜索页本身都不应该出现在结果里（用户抱怨的「给我的信息是个首页」）。 */
function isLandingPage(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/') return true;
    if (LANDING_PATH.test(path)) return true;
    if (/^\/(?:search|so|s)(?:\/|$)/i.test(path)) return true;
    if (/^\/(?:hot|explore|discover|channel|topic|topics|sort|list)(?:\/|$)/i.test(path)) return true;
    return parsed.search === '' && path.split('/').filter(Boolean).length === 0;
  } catch {
    return false;
  }
}

function result(platform, def, item) {
  return {
    platform,
    platformLabel: def.zh,
    title: stripTags(item.title || '').slice(0, 300),
    url: item.url || '',
    snippet: stripTags(item.snippet || '').slice(0, 500),
    source: item.source || def.zh,
    extra: item.extra || undefined,
  };
}

// 去重键：同一个页面常被不同来源带上不同跟踪参数（utm_*、spm、from…），
// 直接比对 URL 会漏判成两条，所以先剥掉 hash 与常见跟踪参数再比。
const TRACKING_PARAMS = /^(utm_\w+|spm\w*|from|source|ref|refer|share\w*|scene|isappinstalled|share_source|wfr|forcemobile|ivk_sa|sa|ved|usg|wd|eqid|rsv_\w+)$/i;
function dedupeKey(url, title) {
  const raw = String(url || '').trim();
  if (raw !== '') {
    try {
      const parsed = new URL(raw);
      const keep = [...parsed.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key));
      keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const query = keep.map(([key, value]) => `${key}=${value}`).join('&');
      const pathname = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.hostname.replace(/^www\./, '')}${pathname}${query ? `?${query}` : ''}`.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
  return String(title || '').toLowerCase();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = dedupeKey(item.url, item.title);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function relevanceTokens(query) {
  const text = String(query || '').trim().toLowerCase();
  if (text === '') return [];
  const parts = text
    .split(/[\s,，。；;、/|+()（）[\]【】"'“”·]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const tokens = Array.from(new Set(parts)).slice(0, 6);
  if (tokens.length === 0 && text.length >= 2) tokens.push(text);
  return tokens;
}

function keepRelevant(items, tokens) {
  if (tokens.length === 0 || items.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}

// ---------------------------------------------------------------------------
// platform registry
// ---------------------------------------------------------------------------

export const PLATFORM_LIST = [
  { id: 'bing', zh: '必应', en: 'Bing', group: 'general', backend: 'bing', browser: (q) => `https://www.bing.com/search?q=${enc(q)}` },
  { id: 'baidu', zh: '百度', en: 'Baidu', group: 'general', backend: 'baidu', browser: (q) => `https://www.baidu.com/s?wd=${enc(q)}` },
  { id: 'so360', zh: '360搜索', en: '360 Search', group: 'general', backend: 'so360', browser: (q) => `https://www.so.com/s?q=${enc(q)}` },
  { id: 'sogou', zh: '搜狗', en: 'Sogou', group: 'general', backend: 'sogou', browser: (q) => `https://www.sogou.com/web?query=${enc(q)}` },
  { id: 'google', zh: '谷歌', en: 'Google', group: 'general', backend: 'google', browser: (q) => `https://www.google.com/search?q=${enc(q)}`, needsTunnel: true },
  { id: 'ddg', zh: 'DuckDuckGo', en: 'DuckDuckGo', group: 'general', backend: 'ddg', browser: (q) => `https://duckduckgo.com/?q=${enc(q)}`, needsTunnel: true },
  { id: 'brave', zh: 'Brave', en: 'Brave Search', group: 'general', backend: 'brave', browser: (q) => `https://search.brave.com/search?q=${enc(q)}`, needsTunnel: true },

  { id: 'zhihu', zh: '知乎', en: 'Zhihu', group: 'cn', site: 'zhihu.com', browser: (q) => `https://www.zhihu.com/search?type=content&q=${enc(q)}` },
  { id: 'csdn', zh: 'CSDN', en: 'CSDN', group: 'cn', backend: 'csdn', browser: (q) => `https://so.csdn.net/so/search?q=${enc(q)}` },
  { id: 'juejin', zh: '掘金', en: 'Juejin', group: 'cn', backend: 'juejin', browser: (q) => `https://juejin.cn/search?query=${enc(q)}` },
  { id: 'cnblogs', zh: '博客园', en: 'Cnblogs', group: 'cn', site: 'cnblogs.com', browser: (q) => `https://zzk.cnblogs.com/s?w=${enc(q)}` },
  { id: 'segmentfault', zh: '思否', en: 'SegmentFault', group: 'cn', site: 'segmentfault.com', browser: (q) => `https://segmentfault.com/search?q=${enc(q)}` },
  { id: 'oschina', zh: '开源中国', en: 'OSChina', group: 'cn', site: 'oschina.net', browser: (q) => `https://www.oschina.net/search?scope=all&q=${enc(q)}` },
  { id: 'gitee', zh: 'Gitee', en: 'Gitee', group: 'cn', site: 'gitee.com', browser: (q) => `https://search.gitee.com/?skin=rec&type=repository&q=${enc(q)}` },
  { id: 'bilibili', zh: '哔哩哔哩', en: 'Bilibili', group: 'video', backend: 'bilibili', site: 'bilibili.com', browser: (q) => `https://search.bilibili.com/all?keyword=${enc(q)}` },
  { id: 'douyin', zh: '抖音', en: 'Douyin', group: 'video', site: 'douyin.com', browser: (q) => `https://www.douyin.com/search/${enc(q)}` },
  { id: 'douyinhot', zh: '抖音热榜', en: 'Douyin Hot', group: 'video', backend: 'douyin-hot', list: true, browser: () => 'https://www.douyin.com/hot' },
  { id: 'youtube', zh: 'YouTube', en: 'YouTube', group: 'video', site: 'youtube.com', browser: (q) => `https://www.youtube.com/results?search_query=${enc(q)}`, needsTunnel: true },
  { id: 'xiaohongshu', zh: '小红书', en: 'Xiaohongshu', group: 'social', site: 'xiaohongshu.com', browser: (q) => `https://www.xiaohongshu.com/search_result?keyword=${enc(q)}` },
  { id: 'weibo', zh: '微博', en: 'Weibo', group: 'social', site: 'weibo.com', browser: (q) => `https://s.weibo.com/weibo?q=${enc(q)}` },
  { id: 'toutiao', zh: '今日头条', en: 'Toutiao', group: 'social', backend: 'toutiao', site: 'toutiao.com', browser: (q) => `https://so.toutiao.com/search?keyword=${enc(q)}` },
  { id: 'weixin', zh: '微信', en: 'WeChat', group: 'social', backend: 'weixin', browser: (q) => `https://weixin.sogou.com/weixin?type=2&query=${enc(q)}` },
  { id: 'v2ex', zh: 'V2EX', en: 'V2EX', group: 'cn', backend: 'v2ex', site: 'v2ex.com', browser: (q) => `https://www.sov2ex.com/?q=${enc(q)}` },
  { id: 'reddit', zh: 'Reddit', en: 'Reddit', group: 'social', site: 'reddit.com', browser: (q) => `https://www.reddit.com/search/?q=${enc(q)}`, needsTunnel: true },

  { id: 'github', zh: 'GitHub', en: 'GitHub', group: 'dev', backend: 'github', browser: (q) => `https://github.com/search?q=${enc(q)}&type=repositories` },
  { id: 'stackoverflow', zh: 'Stack Overflow', en: 'Stack Overflow', group: 'dev', backend: 'stackexchange', browser: (q) => `https://stackoverflow.com/search?q=${enc(q)}`, needsTunnel: true },
  { id: 'npm', zh: 'npm', en: 'npm', group: 'dev', backend: 'npm', browser: (q) => `https://www.npmjs.com/search?q=${enc(q)}` },
  { id: 'hackernews', zh: 'Hacker News', en: 'Hacker News', group: 'dev', backend: 'hackernews', browser: (q) => `https://hn.algolia.com/?q=${enc(q)}`, needsTunnel: true },
  { id: 'mdn', zh: 'MDN 文档', en: 'MDN', group: 'dev', site: 'developer.mozilla.org', browser: (q) => `https://developer.mozilla.org/zh-CN/search?q=${enc(q)}` },
  { id: 'pypi', zh: 'PyPI', en: 'PyPI', group: 'dev', site: 'pypi.org', browser: (q) => `https://pypi.org/search/?q=${enc(q)}`, needsTunnel: true },
  { id: 'wikipedia', zh: '维基百科', en: 'Wikipedia', group: 'dev', backend: 'wikipedia', browser: (q) => `https://zh.wikipedia.org/w/index.php?search=${enc(q)}`, needsTunnel: true },

  { id: 'taobao', zh: '淘宝', en: 'Taobao', group: 'shop', site: 'item.taobao.com', browser: (q) => `https://s.taobao.com/search?q=${enc(q)}` },
  { id: 'jd', zh: '京东', en: 'JD', group: 'shop', site: 'jd.com', browser: (q) => `https://search.jd.com/Search?keyword=${enc(q)}` },
  { id: '1688', zh: '1688', en: '1688', group: 'shop', site: '1688.com', browser: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${enc(q)}` },
  { id: 'amazon', zh: '亚马逊', en: 'Amazon', group: 'shop', site: 'amazon.com', browser: (q) => `https://www.amazon.com/s?k=${enc(q)}`, needsTunnel: true },
  { id: 'xianyu', zh: '闲鱼', en: 'Xianyu', group: 'shop', site: 'goofish.com', browser: (q) => `https://www.goofish.com/search?q=${enc(q)}` },
  { id: 'douban', zh: '豆瓣', en: 'Douban', group: 'content', site: 'douban.com', browser: (q) => `https://www.douban.com/search?q=${enc(q)}` },
  { id: 'sspai', zh: '少数派', en: 'SSPAI', group: 'content', site: 'sspai.com', browser: (q) => `https://sspai.com/search/post/${enc(q)}` },
  { id: 'medium', zh: 'Medium', en: 'Medium', group: 'content', site: 'medium.com', browser: (q) => `https://medium.com/search?q=${enc(q)}`, needsTunnel: true },
];

export const PLATFORMS = new Map(PLATFORM_LIST.map((item) => [item.id, item]));

// ---------------------------------------------------------------------------
// user-defined sites (抖音风格的自定义站点：给名字 + 搜索地址模板就能用)
// ---------------------------------------------------------------------------

const LOGIN_PAGES = {
  bilibili: 'https://passport.bilibili.com/login',
  zhihu: 'https://www.zhihu.com/signin',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  douyin: 'https://www.douyin.com/',
  weibo: 'https://weibo.com/login.php',
  toutiao: 'https://www.toutiao.com/',
  taobao: 'https://login.taobao.com/',
  jd: 'https://passport.jd.com/new/login.aspx',
  xianyu: 'https://www.goofish.com/',
  '1688': 'https://login.1688.com/',
  github: 'https://github.com/login',
  gitee: 'https://gitee.com/login',
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
  csdn: 'https://passport.csdn.net/login',
  juejin: 'https://juejin.cn/login',
  douban: 'https://accounts.douban.com/passport/login',
  cnblogs: 'https://account.cnblogs.com/signin',
};

/** The page a user must open to sign in, for platforms known to have one. */
export function loginUrlFor(id) {
  const def = PLATFORMS.get(String(id || ''));
  if (!def) return '';
  if (LOGIN_PAGES[def.id]) return LOGIN_PAGES[def.id];
  if (def.site) return `https://${def.site}/`;
  return '';
}

/** Registrable-ish domain: api.bilibili.com → bilibili.com, www.gov.cn → gov.cn. */
export function baseDomain(host) {
  const value = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  if (value === '') return '';
  const parts = value.split('.');
  if (parts.length <= 2) return value;
  const tail = parts.slice(-2).join('.');
  if (/^(com|net|org|gov|edu|co)\.[a-z]{2}$/.test(tail)) return parts.slice(-3).join('.');
  return tail;
}

/** The cookie domain a platform's login state lives on. */
export function cookieDomainFor(id) {
  const def = PLATFORMS.get(String(id || ''));
  if (!def) return '';
  if (def.site) return baseDomain(def.site);
  try {
    const host = hostOf(def.browser ? def.browser('query') : '');
    if (host) return baseDomain(host);
  } catch {
    /* ignore */
  }
  return baseDomain(ENGINE_HOST_FALLBACK[def.backend] || '');
}

const ENGINE_HOST_FALLBACK = { bing: 'bing.com', so360: 'so.com', baidu: 'baidu.com', sogou: 'sogou.com' };

const CUSTOM_GROUP = '自定义站点';

function customId(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `custom:${base || Date.now().toString(36)}`;
}

/** Stable id for a user-defined site, so the store can remember the chip order. */
export function customPlatformId(name) {
  return customId(name);
}

/**
 * Merge user-defined sites into the registry. Each entry is
 * `{name, url, site?}` where `url` is a search template containing `{q}`
 * (or a plain URL that gets `?q=` appended). `site` scopes results to a domain.
 */
export function registerCustomPlatforms(list) {
  const wanted = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || item.zh || '').trim();
    const template = String(item.url || '').trim();
    if (name === '' || template === '') continue;
    const id = String(item.id || '').startsWith('custom:') ? String(item.id) : customId(name);
    wanted.add(id);
    const site = String(item.site || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
    const definition = {
      id,
      zh: name,
      en: name,
      group: CUSTOM_GROUP,
      custom: true,
      url: template,
      site: site || undefined,
      browser: (query) => customUrl(template, query),
    };
    PLATFORMS.set(id, definition);
    const index = PLATFORM_LIST.findIndex((entry) => entry.id === id);
    if (index >= 0) PLATFORM_LIST[index] = definition;
    else PLATFORM_LIST.push(definition);
  }
  for (const id of [...PLATFORMS.keys()]) {
    if (id.startsWith('custom:') && !wanted.has(id)) PLATFORMS.delete(id);
  }
  for (let index = PLATFORM_LIST.length - 1; index >= 0; index -= 1) {
    const entry = PLATFORM_LIST[index];
    if (entry && entry.id.startsWith('custom:') && !wanted.has(entry.id)) PLATFORM_LIST.splice(index, 1);
  }
  return PLATFORM_LIST.length;
}

function customUrl(template, query) {
  const value = String(template || '');
  if (value.includes('{q}')) return value.replace(/\{q\}/g, encodeURIComponent(query));
  const joiner = value.includes('?') ? '&' : '?';
  return `${value}${joiner}q=${encodeURIComponent(query)}`;
}

/** Pull result-like anchors out of an arbitrary HTML page. */
export function parseAnchors(html, base, limit = 12) {
  const rows = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const attrs = match[1];
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[2] || hrefMatch[3] || hrefMatch[4] || '');
    if (href === '' || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    const url = absolutize(href, base);
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    const title = stripTags(match[2]).replace(/\s+/g, ' ').trim();
    if (title.length < 4 || title.length > 160) continue;
    if (/^(更多|登录|注册|首页|下一页|上一页|查看|详情|下载|打开|返回)$/.test(title)) continue;
    seen.add(url);
    rows.push({ title, url, snippet: '' });
    if (rows.length >= limit) break;
  }
  return rows;
}

async function fetchCustom({ client, def, query, limit }) {
  const url = customUrl(def.url, query);
  const page = await client.request(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
  if (page.status >= 400) {
    const error = new Error(`HTTP ${page.status}`);
    if (page.status === 401 || page.status === 403 || page.status === 412) error.blocked = true;
    throw error;
  }
  const base = page.url || url;
  const rows = parseAnchors(page.text, base, limit * 4);
  const scoped = def.site
    ? rows.filter((row) => {
        const host = hostOf(row.url);
        return host === def.site || host.endsWith(`.${def.site}`);
      })
    : rows;
  const host = hostOf(base);
  return (scoped.length > 0 ? scoped : rows.filter((row) => hostOf(row.url) === host)).slice(0, limit);
}

const ALIASES = new Map([
  ['必应', 'bing'],
  ['bing', 'bing'],
  ['百度', 'baidu'],
  ['360', 'so360'],
  ['360搜索', 'so360'],
  ['so', 'so360'],
  ['搜狗', 'sogou'],
  ['谷歌', 'google'],
  ['google', 'google'],
  ['duckduckgo', 'ddg'],
  ['知乎', 'zhihu'],
  ['掘金', 'juejin'],
  ['博客园', 'cnblogs'],
  ['思否', 'segmentfault'],
  ['开源中国', 'oschina'],
  ['哔哩哔哩', 'bilibili'],
  ['b站', 'bilibili'],
  ['bilibili', 'bilibili'],
  ['抖音', 'douyin'],
  ['小红书', 'xiaohongshu'],
  ['微博', 'weibo'],
  ['头条', 'toutiao'],
  ['今日头条', 'toutiao'],
  ['微信', 'weixin'],
  ['公众号', 'weixin'],
  ['weixin', 'weixin'],
  ['wechat', 'weixin'],
  ['v2ex', 'v2ex'],
  ['v站', 'v2ex'],
  ['github', 'github'],
  ['git', 'github'],
  ['stackoverflow', 'stackoverflow'],
  ['so', 'stackoverflow'],
  ['npm', 'npm'],
  ['hn', 'hackernews'],
  ['mdn', 'mdn'],
  ['维基', 'wikipedia'],
  ['维基百科', 'wikipedia'],
  ['淘宝', 'taobao'],
  ['天猫', 'taobao'],
  ['京东', 'jd'],
  ['jd', 'jd'],
  ['1688', '1688'],
  ['阿里巴巴', '1688'],
  ['亚马逊', 'amazon'],
  ['amazon', 'amazon'],
  ['闲鱼', 'xianyu'],
  ['豆瓣', 'douban'],
  ['少数派', 'sspai'],
  ['medium', 'medium'],
  ['youtube', 'youtube'],
  ['油管', 'youtube'],
  ['reddit', 'reddit'],
  ['pypi', 'pypi'],
  ['gitee', 'gitee'],
]);

export function platformCatalog() {
  return PLATFORM_LIST.map((item) => ({
    id: item.id,
    label: item.zh,
    labelEn: item.en,
    group: item.group,
    backend: item.custom ? item.url || '自定义' : item.backend ? item.backend : `site:${item.site}`,
    needsTunnel: item.needsTunnel === true,
    domain: cookieDomainFor(item.id),
    login: loginUrlFor(item.id),
    custom: item.custom === true,
  }));
}

// ---------------------------------------------------------------------------
// query helpers: strip conversational filler, detect platforms
// ---------------------------------------------------------------------------

const PLATFORM_HINTS = [
  [/b\s*站|哔哩|bilibili/i, 'bilibili'],
  [/知乎/i, 'zhihu'],
  [/小红书|xhs/i, 'xiaohongshu'],
  [/抖音|douyin/i, 'douyin'],
  [/淘宝|天猫/i, 'taobao'],
  [/京东/i, 'jd'],
  [/闲鱼/i, 'xianyu'],
  [/微博/i, 'weibo'],
  [/微信|公众号|weixin|wechat/i, 'weixin'],
  [/掘金/i, 'juejin'],
  [/csdn/i, 'csdn'],
  [/博客园/i, 'cnblogs'],
  [/github/i, 'github'],
  [/gitlab/i, 'github'],
  [/gitee|码云/i, 'gitee'],
  [/stack\s*overflow/i, 'stackoverflow'],
  [/npm/i, 'npm'],
  [/pypi|pip\s*包/i, 'pypi'],
  [/mdn|前端文档/i, 'mdn'],
  [/维基|wiki/i, 'wikipedia'],
  [/百度/i, 'baidu'],
  [/必应|bing/i, 'bing'],
  [/谷歌|google/i, 'google'],
  [/搜狗/i, 'sogou'],
  [/360/i, 'so360'],
  [/youtube|油管/i, 'youtube'],
  [/reddit/i, 'reddit'],
  [/豆瓣/i, 'douban'],
  [/少数派/i, 'sspai'],
  [/亚马逊|amazon/i, 'amazon'],
  [/1688|阿里巴巴/i, '1688'],
  [/头条/i, 'toutiao'],
  [/\bv2ex\b/i, 'v2ex'],
  [/medium/i, 'medium'],
];

export function inferPlatforms(text) {
  const found = new Set();
  const value = String(text || '');
  for (const [pattern, id] of PLATFORM_HINTS) {
    if (pattern.test(value)) found.add(id);
  }
  return [...found];
}

// Words that only name a platform; they are stripped from the derived query so the
// platform choice does not pollute the keywords sent to the engines.
const PLATFORM_WORDS = [
  '哔哩哔哩', 'B站', 'b站', '小破站', '知乎', '掘金', '小红书', '微博', '抖音', '淘宝', '天猫', '京东', '闲鱼',
  '豆瓣', '头条', 'v2ex', 'V2EX', '油管', '维基百科', '博客园', '思否', '开源中国', '码云', '少数派', '谷歌', '必应', '百度', '搜狗',
  'Bilibili', 'bilibili', 'GitHub', 'YouTube', 'Reddit', 'Stack Overflow', 'StackOverflow', 'SegmentFault',
  'OSChina', 'Gitee', 'Medium', 'Wikipedia', 'Google', 'DuckDuckGo', 'Brave', 'CSDN', 'Zhihu',
];

const PLATFORM_WORD_RULES = PLATFORM_WORDS.map(
  (word) => new RegExp(`[在从去用上和与及跟、,\\s]*${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:上面|上|里面|里|中|的)?`, 'g'),
);

export function stripPlatformMentions(text) {
  let value = String(text || '');
  for (const rule of PLATFORM_WORD_RULES) value = value.replace(rule, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

const FILLERS = [
  /^(请问|麻烦|帮我|帮忙|请|能不能|可以|能否|我想|我要|我需要|想要|给我)(一下)?/,
  /^(制作|开发|实现|编写|写|做一个|搭建|搞一个)(一个|个)?/,
  /^(一个|个)/,
  /(搜索一下|搜一下|搜一搜|查找一下|查一下|查询一下|搜索|查找|查询|找一下|找找|看看)(关于|有关)?/g,
  /(上面的|上述|刚才|之前|上面说的|前面提到|这个|那个)/g,
  /(是什么|怎么样|怎么|如何|为什么|有哪些|有什么)/g,
  /(相关的|有关|的资料|的内容|的信息|的文章|的教程)/g,
  /(^|\s)(?:搜|查|找)(?=\s|$)/g,
];

export function cleanQuery(text) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  value = value.replace(/[，。！？、；：""''（）【】《》…]+$/g, '').trim();
  for (const rule of FILLERS) value = value.replace(rule, ' ');
  value = stripPlatformMentions(value)
    .replace(/[，。！？；：]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value === '' ? String(text || '').trim() : value;
}

/** Extract the last user message text plus a short slice of the assistant reply as conversation context. */
export function contextQuery(messages, fallback = '') {
  const list = Array.isArray(messages) ? messages : [];
  const texts = [];
  for (let i = list.length - 1; i >= 0 && texts.length < 6; i -= 1) {
    const message = list[i];
    const role = message && message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = typeof message.text === 'string' ? message.text : extractText(message);
    if (!text || text.trim() === '') continue;
    if (isHarnessNoise(text)) continue;
    texts.unshift({ role, text: text.trim() });
  }
  const lastUser = [...texts].reverse().find((item) => item.role === 'user');
  if (!lastUser) return cleanQuery(fallback);
  const lastAssistant = [...texts].reverse().find((item) => item.role === 'assistant' && item !== lastUser);
  const base = lastUser.text.length > 80 ? lastUser.text.slice(0, 80) : lastUser.text;
  if (base.length < 40 && lastAssistant && lastAssistant.text.length > 40) {
    return cleanQuery(`${base} ${lastAssistant.text.slice(0, 100)}`);
  }
  return cleanQuery(base);
}

/**
 * The transcript also carries injected harness notes (timestamps, runtime context,
 * memory snapshots, tool reminders). Those are never what the user wants searched,
 * so skip any message that looks like one of them.
 */
const NOISE_RULES = [
  /time sampled while preparing/i,
  /elapsed since the (preceding|previous)/i,
  /browser time zone for this request/i,
  /mnemon runtime memory snapshot/i,
  /mnemon\]/i,
  /current runtime context/i,
  /current working directory:/i,
  /^\[[A-Za-z][A-Za-z0-9 _-]{1,30}\]/,
  /^<\/?(system|project_instructions|available_skills)/i,
];

function isHarnessNoise(text) {
  const value = String(text || '').trim();
  if (value === '') return true;
  for (const rule of NOISE_RULES) if (rule.test(value)) return true;
  return false;
}

function extractText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// backends
// ---------------------------------------------------------------------------

function unwrapBing(href) {
  const raw = decodeEntities(String(href || ''));
  if (raw === '') return '';
  if (!/bing\.com\/ck\/a/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const encoded = url.searchParams.get('u');
    if (!encoded || !encoded.startsWith('a1')) return raw;
    const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return raw;
  }
}

export function parseBing(html, base = 'https://www.bing.com') {
  const out = [];
  const blocks = String(html).split(/<li class="b_algo"/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk) ||
      /<a[^>]*class="[^"]*tilk[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk) ||
      /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(unwrapBing(anchor[1]), base);
    if (url === '' || hostOf(url).endsWith('bing.com')) continue;
    const title = stripTags(anchor[2]);
    if (title === '') continue;
    const snippetMatch = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk) ||
      /<div[^>]*class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    out.push({ title, url, snippet: snippetMatch ? htmlToText(snippetMatch[1], { scoped: true }) : '' });
  }
  return out;
}

const backends = {};

backends.bing = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const res = await client.request(
    `https://www.bing.com/search?q=${enc(query)}&count=${Math.min(30, limit * 2)}&setlang=zh-Hans`,
    { headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, timeoutMs },
  );
  if (/<title>\s*(?:Just a moment|Attention Required)/i.test(res.text)) {
    throw new EngineBlocked('bing challenge page', { browser: `https://www.bing.com/search?q=${enc(query)}` });
  }
  const items = parseBing(res.text);
  if (items.length === 0) {
    const cn = await client.request(`https://cn.bing.com/search?q=${enc(query)}&ensearch=0`, { timeoutMs });
    items.push(...parseBing(cn.text, 'https://cn.bing.com'));
  }
  return items;
};

backends.baidu = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const res = await client.request(`https://www.baidu.com/s?ie=utf-8&rn=${Math.min(30, limit * 2)}&pn=${(page - 1) * 10}&wd=${enc(query)}`, {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    timeoutMs,
  });
  if (/百度安全验证|wappass\.baidu\.com|security-verify/i.test(res.text) && !/class="result/.test(res.text)) {
    throw new EngineBlocked('baidu security verification', { browser: `https://www.baidu.com/s?wd=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<div[^>]*class="result[^"]*c-container/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(decodeEntities(anchor[1]), 'https://www.baidu.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    const snippetMatch = /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk) ||
      /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    out.push({ title, url, snippet: snippetMatch ? htmlToText(snippetMatch[1], { scoped: true }) : '' });
  }
  return out;
};

backends.so360 = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const res = await client.request(`https://www.so.com/s?q=${enc(query)}&pn=${page}&rn=${Math.min(30, limit * 2)}`, { timeoutMs });
  if (/请输入验证码|antispider|captcha/i.test(res.text) && !/res-list/.test(res.text)) {
    throw new EngineBlocked('so.com captcha', { browser: `https://www.so.com/s?q=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<li[^>]*class="res-list/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<h3[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const tag = /<a[^>]*data-mdurl="([^"]+)"/i.exec(chunk);
    const url = absolutize(decodeEntities(tag ? tag[1] : anchor[1]), 'https://www.so.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    const snippetMatch = /<span[^>]*class="[^"]*res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk) ||
      /data-result-summary[^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(chunk);
    out.push({ title, url, snippet: snippetMatch ? htmlToText(snippetMatch[1], { scoped: true }) : '' });
  }
  return out;
};

backends.sogou = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const res = await client.request(`https://www.sogou.com/web?query=${enc(query)}&num=${Math.min(30, limit * 2)}`, { timeoutMs });
  if (/antispider|请输入验证码|seccode/i.test(res.text) && !/vrwrap|rb/.test(res.text)) {
    throw new EngineBlocked('sogou anti-spider', { browser: `https://www.sogou.com/web?query=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<div[^>]*class="(?:vrwrap|rb)"/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(decodeEntities(anchor[1]), 'https://www.sogou.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    out.push({ title, url, snippet: htmlToText(chunk, { scoped: true }).slice(0, 400) });
  }
  return out;
};

backends.google = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const res = await client.request(`https://www.google.com/search?num=${Math.min(20, limit * 2)}&hl=zh-CN&q=${enc(query)}`, {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    timeoutMs,
  });
  if (/captcha|unusual traffic|sorry\/index/i.test(res.text)) {
    throw new EngineBlocked('google captcha', { browser: `https://www.google.com/search?q=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<div class="g"/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<a[^>]*href="(?:https?:\/\/www\.google\.com\/url\?q=)?([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(decodeURIComponent(decodeEntities(anchor[1])), 'https://www.google.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '' || hostOf(url).endsWith('google.com')) continue;
    out.push({ title, url, snippet: htmlToText(chunk, { scoped: true }).slice(0, 400) });
  }
  return out;
};

backends.ddg = async (ctx) => {
  const { client, query, timeoutMs } = ctx;
  const res = await client.request(`https://html.duckduckgo.com/html/?q=${enc(query)}`, { timeoutMs });
  if (/anomaly-modal|unusual traffic/i.test(res.text)) {
    throw new EngineBlocked('duckduckgo anomaly check', { browser: `https://duckduckgo.com/?q=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<div class="result results_links/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(unwrapBing(decodeEntities(anchor[1])), 'https://duckduckgo.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    out.push({ title, url, snippet: snippet ? htmlToText(snippet[1], { scoped: true }) : '' });
  }
  return out;
};

backends.brave = async (ctx) => {
  const { client, query, timeoutMs } = ctx;
  const res = await client.request(`https://search.brave.com/search?q=${enc(query)}&source=web`, { timeoutMs });
  if (/captcha|challenge/i.test(res.text) && !/snippet/.test(res.text)) {
    throw new EngineBlocked('brave challenge', { browser: `https://search.brave.com/search?q=${enc(query)}` });
  }
  const out = [];
  const blocks = res.text.split(/<div class="snippet/).slice(1);
  for (const chunk of blocks) {
    const anchor = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!anchor) continue;
    const url = absolutize(decodeEntities(anchor[1]), 'https://search.brave.com');
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    out.push({ title, url, snippet: htmlToText(chunk, { scoped: true }).slice(0, 400) });
  }
  return out;
};

backends.github = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const { data } = await client.json(
    `https://api.github.com/search/repositories?q=${enc(query)}&sort=stars&order=desc&per_page=${Math.min(30, limit)}&page=${page}`,
    { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, timeoutMs },
  );
  const items = (data && Array.isArray(data.items) ? data.items : []).map((repo) => ({
    title: `${repo.full_name}${repo.language ? ` · ${repo.language}` : ''}`,
    url: repo.html_url,
    snippet: repo.description || '',
    extra: { stars: repo.stargazers_count, updated: repo.pushed_at, topics: repo.topics },
  }));
  return items;
};

backends.stackexchange = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const { data } = await client.json(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${enc(query)}&site=stackoverflow&pagesize=${Math.min(30, limit)}&page=${page}&filter=default`,
    { timeoutMs },
  );
  const items = (data && Array.isArray(data.items) ? data.items : []).map((post) => ({
    title: stripTags(post.title),
    url: post.link,
    snippet: `${post.is_answered ? '已解决' : '未解决'} · 评分 ${post.score} · 回答 ${post.answer_count}`,
    extra: { score: post.score, answers: post.answer_count },
  }));
  return items;
};

backends.npm = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const { data } = await client.json(
    `https://registry.npmjs.org/-/v1/search?text=${enc(query)}&size=${Math.min(25, limit)}`,
    { timeoutMs },
  );
  const items = (data && Array.isArray(data.objects) ? data.objects : []).map((entry) => ({
    title: `${entry.package.name}@${entry.package.version}`,
    url: `https://www.npmjs.com/package/${entry.package.name}`,
    snippet: entry.package.description || '',
    extra: { score: entry.score && entry.score.final, date: entry.package.date },
  }));
  return items;
};

backends.hackernews = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const { data } = await client.json(
    `https://hn.algolia.com/api/v1/search?query=${enc(query)}&hitsPerPage=${Math.min(25, limit)}&page=${page - 1}&tags=story`,
    { timeoutMs },
  );
  const items = (data && Array.isArray(data.hits) ? data.hits : []).map((hit) => ({
    title: hit.title || hit.story_title || '(untitled)',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    snippet: `${hit.points || 0} points · ${hit.num_comments || 0} comments`,
    extra: { points: hit.points, comments: hit.num_comments, created: hit.created_at },
  }));
  return items;
};

backends.csdn = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const { data } = await client.json(
    `https://so.csdn.net/api/v3/search?q=${enc(query)}&t=all&p=${page}&s=0&tm=0&lv=-1&ft=0&l=&u=&ct=-1&pnt=-1&ry=-1&ss=-1&dct=-1&vco=-1&cc=-1&sc=-1&akt=-1&art=-1&ca=-1&prs=&pre=&ecc=-1&ebc=-1&urw=&ia=1&dId=&cl=-1&scl=-1&tcl=-1&platform=pc&ab_test_code_overlap=&app_id=&cert=&ex_id=`,
    { timeoutMs },
  );
  const rows = data && Array.isArray(data.result_vos) ? data.result_vos : [];
  return rows.slice(0, limit).map((row) => {
    const url = String(row.url || '').split('?')[0];
    const body = row.digest || row.description || row.body || '';
    return {
      title: stripTags(row.title),
      url,
      snippet: htmlToText(String(body), { scoped: true }).slice(0, 400),
      extra: { author: row.author ? stripTags(row.author) : undefined, views: row.view_num },
    };
  });
};

backends.juejin = async (ctx) => {
  const { client, query, limit, timeoutMs, pages = 1 } = ctx;
  const collected = [];
  let cursor = '0';
  const rounds = Math.min(4, Math.max(1, Number(pages) || 1));
  for (let round = 0; round < rounds; round += 1) {
    const { data } = await client.json('https://api.juejin.cn/search_api/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: 'https://juejin.cn/' },
      body: JSON.stringify({ key_word: query, id_type: 0, cursor, limit: Math.min(20, Math.max(10, limit)), search_type: 0, sort_type: 0, version: 1, uuid: '0' }),
      timeoutMs,
    });
    const rows = data && Array.isArray(data.data) ? data.data : [];
    collected.push(...rows);
    if (!data || data.has_more !== true || typeof data.cursor !== 'string' || data.cursor === '') break;
    cursor = data.cursor;
    if (collected.length >= limit) break;
  }
  const rows = collected;
  return rows.slice(0, limit).map((row) => {
    const info = (row.result_model && row.result_model.article_info) || {};
    return {
      title: stripTags(info.title),
      url: info.article_id ? `https://juejin.cn/post/${info.article_id}` : '',
      snippet: stripTags(info.brief_content),
      extra: { views: info.view_count, likes: info.digg_count },
    };
  });
};

const HOT_LABEL_BITS = [[16, '首发'], [8, '挑战'], [2, '热'], [1, '新']];

function hotLabel(value) {
  if (typeof value === 'string' && value !== '' && !/^\d+$/.test(value)) return value;
  const bits = Number(value) || 0;
  const words = HOT_LABEL_BITS.filter(([bit]) => (bits & bit) === bit).map(([, word]) => word);
  return words.join('·');
}

backends['douyin-hot'] = async (ctx) => {
  const { client, limit, timeoutMs } = ctx;
  const { data } = await client.json('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { timeoutMs });
  const list = data && Array.isArray(data.word_list) ? data.word_list : [];
  const activeTime = (data && data.active_time) || '';
  return list.slice(0, Math.max(12, limit)).map((row, index) => {
    const word = String((row && row.word) || '');
    const hot = Number((row && row.hot_value) || 0);
    const hotText = hot >= 10000 ? `${(hot / 10000).toFixed(0)}w` : String(hot);
    const tag = hotLabel(row && row.label);
    return {
      title: word,
      url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
      snippet: `热榜第 ${index + 1} 名 · 热度 ${hotText}${tag ? ` · ${tag}` : ''}${activeTime ? ` · 更新 ${activeTime}` : ''}`,
      extra: { rank: index + 1, hot, label: tag, activeTime },
    };
  });
};

// ---- 站内搜索：头条 / V2EX（v1.5）----
// 这两个站点的搜索页是客户端渲染的，`site:` 只能拿到频道页或首页；直接解析它们的搜索数据才是真·站内结果。

/** 按花括号/方括号配平切一段文本（跳过字符串里的括号）。 */
function sliceBalanced(text, start, open = '{', close = '}') {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

/** 收集页面里 `<script type="application/json">` 的数据块（头条的 SSR 结果就藏在这里）。 */
function scriptDataBlocks(html) {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1].trim();
    if (raw === '' || raw.length > 4000000) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // 畸形块直接跳过
    }
  }
  return blocks;
}

/** 深度遍历对象树，收集命中的节点（深度与数量都有上限，避免大 JSON 卡死）。 */
function walkObjects(root, predicate, out, depth = 0) {
  if (out.length >= 80 || depth > 9 || root === null || typeof root !== 'object') return;
  if (!Array.isArray(root) && predicate(root)) out.push(root);
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    if (value !== null && typeof value === 'object') walkObjects(value, predicate, out, depth + 1);
    if (out.length >= 80) return;
  }
}

function toutiaoRow(node) {
  const url = String(node.article_url || node.seo_url || '');
  const title = String(node.title || '').trim();
  if (title === '' || !/^https?:\/\//.test(url)) return undefined;
  return {
    title,
    url,
    snippet: String(node.abstract || node.summary_content || node.hot_board_summary || '').replace(/\s+/g, ' ').slice(0, 300),
    source: String(node.media_name || node.source || '今日头条'),
  };
}

backends.toutiao = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const res = await client.request(
    `https://so.toutiao.com/search?keyword=${enc(query)}&pd=information&source=input&dvpf=pc&_=${Date.now()}`,
    {
      // 注意：带上 referer 会拿到只有骨架、没有结果的 CSR 版本，所以这里刻意不带。
      headers: {
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: Math.max(timeoutMs, 15000),
    },
  );
  const html = res.text || '';
  const nodes = [];
  for (const block of scriptDataBlocks(html)) walkObjects(block, (node) => Boolean(node.article_url && node.title), nodes);
  const rows = dedupe(nodes.map(toutiaoRow).filter(Boolean));
  if (rows.length === 0) {
    if (!/"article_url"/.test(html)) {
      throw new EngineBlocked('toutiao returned the CSR shell', { browser: `https://so.toutiao.com/search?keyword=${enc(query)}` });
    }
    throw new EngineBlocked('toutiao markup changed', { browser: `https://so.toutiao.com/search?keyword=${enc(query)}` });
  }
  return rows.slice(0, Math.max(limit, 10));
};

backends.v2ex = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const { data } = await client.json(
    `https://www.sov2ex.com/api/search?q=${enc(query)}&size=${Math.min(20, Math.max(limit, 10))}&sort=sumup`,
    { timeoutMs },
  );
  const hits = data && Array.isArray(data.hits) ? data.hits : [];
  if (hits.length === 0) return [];
  return hits.map((hit) => {
    const source = (hit && hit._source) || {};
    const created = String(source.created || '').slice(0, 10);
    return {
      title: String(source.title || '').trim(),
      url: `https://www.v2ex.com/t/${source.id}`,
      snippet: stripTags(String(source.content || '')).replace(/\s+/g, ' ').slice(0, 200),
      source: 'V2EX',
      extra: { node: source.node, replies: source.replies, member: source.member, created },
    };
  }).filter((row) => row.title !== '' && row.url.includes('/t/'));
};

backends.weixin = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  // 搜狗微信搜索：每页 10 条公众号文章，链接是 /link?url=…&token=… 的跳转，需要补全域名。
  const res = await client.request(
    `https://weixin.sogou.com/weixin?type=2&query=${enc(query)}&page=${Math.max(1, Number(page) || 1)}`,
    { headers: { referer: 'https://weixin.sogou.com/' }, timeoutMs },
  );
  if (/请输入验证码|antispider|\/verify/i.test(res.text) && !/txt-box/.test(res.text)) {
    throw new EngineBlocked('sogou weixin captcha', { browser: `https://weixin.sogou.com/weixin?type=2&query=${enc(query)}` });
  }
  const blocks = res.text.split('class="txt-box"').slice(1);
  const items = [];
  for (const chunk of blocks) {
    const title = /<h3>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    const href = /<h3>[\s\S]*?<a[^>]*href="([^"]+)"/.exec(chunk);
    if (!title || !href) continue;
    const summary = /<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
    const account = /class="account"[^>]*>([\s\S]*?)<\/a>/.exec(chunk) || /<span class="all-time-y2">([\s\S]*?)<\/span>/.exec(chunk);
    items.push({
      title: stripTags(decodeEntities(title[1])),
      url: absolutize(decodeEntities(href[1]), 'https://weixin.sogou.com'),
      snippet: summary ? stripTags(decodeEntities(summary[1])).slice(0, 200) : '',
      extra: { account: account ? stripTags(decodeEntities(account[1])) : '' },
    });
  }
  return items.slice(0, Math.max(limit, 10));
};

backends.wikipedia = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const { data } = await client.json(
    `https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${Math.min(20, limit)}&srsearch=${enc(query)}`,
    { timeoutMs },
  );
  const rows = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
  return rows.map((row) => ({
    title: row.title,
    url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, '_'))}`,
    snippet: stripTags(row.snippet),
  }));
};

// ---- bilibili (wbi signed) ----

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let wbiCache = { at: 0, key: '' };

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

async function bilibiliKey(client, timeoutMs) {
  if (wbiCache.key !== '' && Date.now() - wbiCache.at < 10 * 60 * 1000) return wbiCache.key;
  const spi = await client.json('https://api.bilibili.com/x/frontend/finger/spi', { timeoutMs });
  const cookieParts = [];
  if (spi.data && typeof spi.data.b_3 === 'string' && spi.data.b_3 !== '') cookieParts.push(`buvid3=${spi.data.b_3}`);
  if (spi.data && typeof spi.data.b_4 === 'string' && spi.data.b_4 !== '') cookieParts.push(`buvid4=${spi.data.b_4}`);
  if (cookieParts.length > 0) client.jar.store.set('bilibili.com', cookieParts.join('; '));
  const nav = await client.json('https://api.bilibili.com/x/web-interface/nav', { timeoutMs });
  const img = (nav.data && nav.data.wbi_img) || {};
  const pick = (url) => String(url || '').split('/').pop().split('.')[0];
  const raw = `${pick(img.img_url)}${pick(img.sub_url)}`;
  if (raw.length < 32) return '';
  const key = MIXIN_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
  wbiCache = { at: Date.now(), key };
  return key;
}

backends.bilibili = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const mixin = await bilibiliKey(client, timeoutMs);
  const params = {
    search_type: 'video',
    keyword: query,
    page: String(Math.max(1, Number(page) || 1)),
    page_size: String(Math.min(50, Math.max(10, limit))),
  };
  let target = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
  if (mixin !== '') {
    const wts = String(Math.floor(Date.now() / 1000));
    const sorted = Object.keys(params)
      .sort()
      .map((key) => `${enc(key)}=${enc(String(params[key]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    params.wts = wts;
    params.w_rid = md5(`${sorted}&wts=${wts}${mixin}`);
  }
  const search = Object.keys(params)
    .map((key) => `${enc(key)}=${enc(String(params[key]))}`)
    .join('&');
  const { data } = await client.json(`${target}?${search}`, {
    headers: { referer: 'https://search.bilibili.com/', origin: 'https://search.bilibili.com' },
    timeoutMs,
  });
  if (data && (data.code === -412 || data.code === -352 || data.code === -401)) {
    throw new EngineBlocked(`bilibili ${data.code}: ${data.message || ''}`, { browser: `https://search.bilibili.com/all?keyword=${enc(query)}` });
  }
  const rows = data && data.data && Array.isArray(data.data.result) ? data.data.result : [];
  return rows.slice(0, limit).map((row) => ({
    title: stripTags(row.title),
    url: row.bvid ? `https://www.bilibili.com/video/${row.bvid}` : `https://www.bilibili.com/video/av${row.aid || ''}`,
    snippet: stripTags(row.description || ''),
    extra: { author: stripTags(row.author || ''), play: row.play, duration: row.duration },
  }));
};

export const BACKENDS = backends;

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

const ENGINE_SELF_HOST = {
  bing: 'bing.com',
  so360: 'so.com',
  sogou: 'sogou.com',
  google: 'google.com',
  ddg: 'duckduckgo.com',
  brave: 'brave.com',
};

async function siteSearch(ctx) {
  const { query, site, limit } = ctx;
  const scoped = `${query} site:${site}`;
  const rows = [];
  const attempts = [
    () => BACKENDS.bing({ ...ctx, query: scoped }),
    () => BACKENDS.so360({ ...ctx, query: scoped }),
  ];
  for (const attempt of attempts) {
    try {
      const found = await attempt();
      for (const row of found) {
        const url = absolutize(row.url, `https://${site}`);
        const host = hostOf(url);
        if (host === site || host.endsWith(`.${site}`)) rows.push({ ...row, url });
      }
    } catch {
      // fall through to the next engine
    }
    if (rows.length >= limit) break;
  }
  return dedupe(rows);
}

export function resolvePlatforms(input, fallback, hints) {
  const auto = [];
  for (const id of Array.isArray(fallback) ? fallback : []) if (!auto.includes(id)) auto.push(id);
  for (const id of Array.isArray(hints) ? hints : []) if (!auto.includes(id)) auto.push(id);
  const raw = Array.isArray(input) ? input : typeof input === 'string' && input.trim() !== '' ? [input] : [];
  const wanted = [];
  for (const entry of raw) {
    const key = String(entry).trim().toLowerCase();
    if (key === '') continue;
    if (key === 'auto' || key === 'all' || key === '自动') {
      // 「自动」= 默认平台 + 从这句话里识别出来的站点，否则只有必应/360 两个引擎，结果自然少。
      for (const id of auto) if (!wanted.includes(id)) wanted.push(id);
      continue;
    }
    const mapped = ALIASES.get(key) || ALIASES.get(String(entry).trim()) || (PLATFORMS.has(key) ? key : undefined);
    if (mapped && !wanted.includes(mapped)) wanted.push(mapped);
  }
  if (wanted.length === 0) for (const id of auto) if (!wanted.includes(id)) wanted.push(id);
  return wanted;
}

/**
 * 多页抓取（v1.6）：同一个后端按 page 翻页，合并去重；某页返回空/不足 3 条就停。
 * 只有真正支持翻页的后端会产出新内容，其余后端重复请求同一页会被 dedupe 吃掉，但为省时间仍按 singlePage 跳过。
 */
async function collectPages(fetchPage, { pages = 1, limit = 20, singlePage = false } = {}) {
  const total = singlePage ? 1 : Math.min(4, Math.max(1, Number(pages) || 1));
  const all = [];
  for (let page = 1; page <= total; page += 1) {
    let rows;
    try {
      rows = await fetchPage(page);
    } catch (error) {
      // 后续页被反爬挡下来是常态：保留已抓到的，别把整个平台判成失败
      if (page === 1) throw error;
      break;
    }
    if (!Array.isArray(rows)) break;
    all.push(...rows);
    const unique = dedupe(all);
    if (unique.length >= limit) return unique;
    if (rows.length < 3) break;
  }
  return dedupe(all);
}

/** 真正支持 page 参数的后端；其余后端重复请求同一页只会被 dedupe 吃掉。 */
const PAGED_BACKENDS = new Set(['csdn', 'v2ex', 'github', 'stackexchange', 'hackernews', 'bilibili', 'so360', 'baidu', 'weixin']);

export async function runSearch(options) {
  const query = String(options.query || '').trim();
  if (query === '') throw new Error('query is empty');
  const fallback = Array.isArray(options.defaultPlatforms) && options.defaultPlatforms.length > 0 ? options.defaultPlatforms : ['bing', 'so360'];
  const ids = resolvePlatforms(options.platforms, fallback, options.hints).slice(0, Math.min(14, Math.max(1, Number(options.maxPlatforms) || 10)));
  const limit = Math.min(30, Math.max(1, Number(options.limit) || 8));
  // 一个平台可以抓多页（v1.6）：超量抓取后再过滤，否则相关性过滤会把结果削掉一半。
  const pages = Math.min(4, Math.max(1, Number(options.pages) || 2));
  const fetchLimit = Math.min(60, limit * pages * 2);
  const timeoutMs = Math.min(30000, Math.max(3000, Number(options.timeoutMs) || 12000));
  const client = createClient({ proxy: options.proxy, cookies: options.cookies, timeoutMs });
  const perPlatform = [];
  const errors = [];

  const tasks = ids.map(async (id) => {
    const def = PLATFORMS.get(id);
    if (!def) return { id, label: id, status: 'error', note: 'unknown platform', count: 0, browser: '', results: [] };
    const browserUrl = def.browser ? def.browser(query) : `https://www.bing.com/search?q=${enc(query)}`;
    const started = Date.now();
    const platformTimeout = def.needsTunnel ? Math.min(timeoutMs, 6000) : timeoutMs;
    try {
      let rows;
      if (def.backend && BACKENDS[def.backend]) {
        rows = await collectPages((page) => BACKENDS[def.backend]({ client, query, limit: fetchLimit, timeoutMs: platformTimeout, page, pages }), { pages, limit: fetchLimit, singlePage: def.list === true || !PAGED_BACKENDS.has(def.backend) });
      } else if (def.url) {
        rows = await fetchCustom({ client, def, query, limit: fetchLimit });
        if ((!rows || rows.length === 0) && def.site) {
          rows = await siteSearch({ client, query, site: def.site, limit: fetchLimit, timeoutMs: platformTimeout });
        } else if (rows && rows.length < 2 && def.site) {
          const extra = await siteSearch({ client, query, site: def.site, limit: fetchLimit, timeoutMs: platformTimeout });
          const seen = new Set(rows.map((row) => row.url));
          rows = rows.concat((extra || []).filter((row) => !seen.has(row.url)));
        }
      } else if (def.site) {
        rows = await siteSearch({ client, query, site: def.site, limit: fetchLimit, timeoutMs: platformTimeout });
      } else {
        rows = await BACKENDS.bing({ client, query, limit: fetchLimit, timeoutMs: platformTimeout });
      }
      const selfHost = def.backend ? ENGINE_SELF_HOST[def.backend] : undefined;
      const collected = dedupe(
        (rows || [])
          .map((row) => result(id, def, row))
          .filter((item) => {
            const host = hostOf(item.url);
            if (host === '') return false;
            if (selfHost && (host === selfHost || host.endsWith(`.${selfHost}`))) return false;
            if (def.backend === undefined && isLandingPage(item.url)) return false;
            return true;
          }),
      );
      const items0 = def.list === true ? collected : keepRelevant(collected, relevanceTokens(query));
      let items = items0.slice(0, limit);
      // 站内兜底：一条都没留下，或者少得可怜（< 3 条）时，用 site: 站内检索补一批再合并去重。
      // 单平台抓取本身有上限（bing 只有 10 条），不补的话「B 站只剩 1 条」这种会白白丢掉条数。
      if (def.list !== true && def.site && items.length < Math.min(3, limit)) {
        const extra = await siteSearch({ client, query, site: def.site, limit: fetchLimit, timeoutMs: platformTimeout });
        const more = (extra || [])
          .map((row) => result(id, def, row))
          .filter((item) => !isLandingPage(item.url));
        items = dedupe(items.concat(more)).slice(0, limit);
      }
      if (def.list !== true && def.site && query !== '' && items.length < limit) {
        const entry = def.browser(query);
        if (!items.some((item) => item.url === entry)) {
          items = items.concat({
            platform: id,
            platformLabel: def.zh,
            title: `在${def.zh}里直接搜索「${query}」`,
            url: entry,
            snippet: '打开该站自己的搜索页，按站内排序浏览全部结果',
            source: def.zh,
            extra: { inSite: true },
          }).slice(0, limit + 1);
        }
      }
      return {
        id,
        label: def.zh,
        status: items.length > 0 ? 'ok' : 'empty',
        note: items.length > 0
          ? items.length === 1 && items[0].extra && items[0].extra.inSite
            ? '只给站内搜索入口（正文结果需要站内渲染）'
            : `${Date.now() - started}ms`
          : def.custom
            ? '没从页面里解析到结果（该站点可能依赖浏览器渲染，可直接在浏览器打开）'
            : def.site
              ? '站点内没抓到正文结果（首页/频道页已过滤），可直接在浏览器打开'
              : 'no results',
        count: items.length,
        browser: browserUrl,
        backend: def.backend || `site:${def.site}`,
        results: items,
      };
    } catch (error) {
      const blocked = error && error.blocked === true;
      errors.push({ platform: id, message: String((error && error.message) || error) });
      return {
        id,
        label: def.zh,
        status: blocked ? 'blocked' : 'error',
        note: blocked
          ? `需要浏览器：${error.message}`
          : def.needsTunnel
            ? `${summarizeError(error)}（该站点通常需要代理，已给出浏览器入口）`
            : summarizeError(error),
        count: 0,
        browser: browserUrl,
        backend: def.backend || `site:${def.site}`,
        results: [],
      };
    }
  });

  for (const entry of await Promise.all(tasks)) perPlatform.push(entry);

  const merged = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const entry of perPlatform) {
      if (entry.results[index]) {
        merged.push(entry.results[index]);
        added = true;
      }
    }
    index += 1;
  }

  // 跨平台去重：同一个页面常被「站点自己的后端」和「搜索引擎站内检索」各抓到一次，
  // 这里按规范化 URL 再收一遍，保留先出现的那条（顺序上站点后端排在前面）。
  const unique = dedupe(merged);
  if (unique.length !== merged.length) {
    for (const entry of perPlatform) {
      entry.count = unique.filter((item) => item.platform === entry.id).length;
    }
  }

  return {
    query,
    mode: ids.length > 1 ? 'multi' : 'single',
    platforms: perPlatform,
    results: unique,
    errors,
    blocked: perPlatform.filter((entry) => entry.status === 'blocked').map((entry) => entry.id),
    tunnelSuggested: perPlatform.some((entry) => entry.status !== 'ok' && PLATFORMS.get(entry.id) && PLATFORMS.get(entry.id).needsTunnel === true),
  };
}

function summarizeError(error) {
  const message = String((error && error.message) || error || 'unknown error');
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(message)) return '网络不可达（可能需要代理）';
  if (/timeout/i.test(message)) return '超时';
  if (/HTTP 4\d\d/.test(message)) return message.slice(0, 80);
  return message.slice(0, 120);
}

export function collectLinks(html, base, max = 40) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const attr = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    if (!attr) continue;
    const href = absolutize(attr[1] ?? attr[2] ?? attr[3] ?? '', base);
    if (href === '') continue;
    const text = stripTags(match[2]);
    if (text.length < 2) continue;
    const key = href.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href, text: text.slice(0, 90) });
    if (out.length >= max) break;
  }
  return out;
}

export async function readPage(options) {
  const target = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('url must start with http(s)://');
  const maxChars = Math.min(20000, Math.max(500, Number(options.maxChars) || 6000));
  const client = createClient({ proxy: options.proxy, cookies: options.cookies, timeoutMs: options.timeoutMs });
  const res = await client.request(target, { timeoutMs: Math.min(30000, Math.max(3000, Number(options.timeoutMs) || 15000)) });
  const contentType = String(res.headers['content-type'] || '');
  const raw = res.text;
  let text;
  if (contentType.includes('json') || /^\s*[[{]/.test(raw.slice(0, 200)) && contentType === '') {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2).slice(0, maxChars);
    } catch {
      text = htmlToText(raw).slice(0, maxChars);
    }
  } else if (contentType.includes('html') || contentType === '') {
    text = htmlToText(raw).slice(0, maxChars);
  } else {
    text = raw.slice(0, maxChars);
  }
  return {
    url: target,
    finalUrl: res.finalUrl,
    status: res.status,
    title: titleOf(raw),
    contentType,
    chars: text.length,
    truncated: text.length >= maxChars,
    links: contentType.includes('html') || contentType === '' ? collectLinks(raw, res.finalUrl || target, 40) : [],
    text,
  };
}

export function browserUrlFor(platformId, query) {
  const def = PLATFORMS.get(platformId);
  if (def && def.browser) return def.browser(query);
  return `https://www.bing.com/search?q=${enc(query)}`;
}

export const MOBILE_UA = UA_MOBILE;