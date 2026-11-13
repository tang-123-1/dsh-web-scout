// Platform registry + search backends. Every platform resolves to either a JSON/HTML backend or a site-scoped web search.
import crypto from 'node:crypto';
import { absolutize, createClient, decodeEntities, hostOf, htmlToText, stripTags, titleOf } from './net.js';
import { providers } from './providers/registry.js';
import { externalProviderDir, loadExternalProviders } from './providers/external.js';

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

// 展示类型：决定面板里这一条长什么样（视频卡片 / 问答 / 论坛 / 榜单 / 商品 / 文章 / 代码）。
const KIND_BY_ID = {
  bilibili: 'video',
  bilihot: 'video',
  douyin: 'video',
  douyinhot: 'hot',
  youtube: 'video',
  zhihu: 'qa',
  zhihurec: 'qa',
  zhihufollow: 'qa',
  zhihuhot: 'hot',
  stackoverflow: 'qa',
  v2ex: 'forum',
  reddit: 'forum',
  hackernews: 'forum',
  segmentfault: 'forum',
  cnblogs: 'forum',
  oschina: 'forum',
  github: 'code',
  gitee: 'code',
  npm: 'code',
  pypi: 'code',
  mdn: 'doc',
  wikipedia: 'doc',
  taobao: 'shop',
  jd: 'shop',
  '1688': 'shop',
  amazon: 'shop',
  xianyu: 'shop',
  weibohot: 'hot',
  baiduhot: 'hot',
  toutiaohot: 'hot',
  csdn: 'article',
  juejin: 'article',
  toutiao: 'article',
  weixin: 'article',
  sspai: 'article',
  medium: 'article',
  douban: 'article',
  weibo: 'social',
  xiaohongshu: 'social',
};

const KIND_BY_GROUP = {
  video: 'video',
  social: 'social',
  code: 'code',
  shop: 'shop',
  doc: 'doc',
  general: 'web',
  cn: 'article',
};

/** 从搜索模板/站点域名猜一个展示类型，供用户自己添加的站点使用。 */
export function inferKindFromUrl(value) {
  const text = String(value || '').toLowerCase();
  if (/youtube\.com|youtu\.be|bilibili\.com|douyin\.com|vimeo\.com|youku\.com|iqiyi\.com|ixigua\.com|kuaishou\.com|huya\.com|douyu\.com|\/video\/|player\./.test(text)) {
    return 'video';
  }
  if (/zhihu\.com|stackoverflow\.com|quora\.com|\/question\//.test(text)) return 'qa';
  if (/v2ex\.com|reddit\.com|news\.ycombinator\.com|segmentfault\.com|cnblogs\.com|tieba\.baidu\.com/.test(text)) {
    return 'forum';
  }
  if (/github\.com|gitee\.com|gitlab\.com|npmjs\.com|pypi\.org/.test(text)) return 'code';
  if (/taobao\.com|tmall\.com|jd\.com|1688\.com|amazon\.|pinduoduo\.com|goofish\.com|xianyu/.test(text)) return 'shop';
  if (/zhihu\.com\/hot|weibo\.com\/top|top\.baidu\.com|hot-board|hotsearch|\/hot\b/.test(text)) return 'hot';
  return 'article';
}

export function kindOf(def) {
  if (!def) return 'web';
  if (def.kind && def.kind !== 'auto') return def.kind;
  if (KIND_BY_ID[def.id]) return KIND_BY_ID[def.id];
  if (def.custom === true) return inferKindFromUrl(def.url || def.site || '');
  return KIND_BY_GROUP[def.group] || 'web';
}

function result(platform, def, item) {
  const extra = item.extra && typeof item.extra === 'object' ? { ...item.extra } : {};
  // 服务端解不开的中转壳（搜狗的 /link?url=… 会被 antispider 拦）：标记出来，面板据此提示。
  if (item.url && isRedirectorUrl(item.url)) extra.shell = true;
  return {
    platform,
    platformLabel: def.zh,
    kind: kindOf(def),
    title: stripTags(item.title || '').slice(0, 300),
    url: item.url || '',
    snippet: stripTags(item.snippet || '').slice(0, 500),
    thumb: String(typeof item.thumb === 'string' ? item.thumb : '').replace(/^http:\/\//i, 'https://'),
    embed: typeof item.embed === 'string' ? item.embed : '',
    source: item.source || def.zh,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
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

/** 去掉空白：必应会把中文标题切开（「7-8 岁儿童绘本」），逐字比对会漏。 */
function squeeze(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '');
}

/** 中文没有分词：用 2-gram 覆盖率判断，长句查询不会再因为"整串没出现"被误杀。 */
function cjkGrams(query) {
  const text = squeeze(query).replace(/[^\u4e00-\u9fff0-9a-z]/gu, '');
  const grams = [];
  for (let index = 0; index + 1 < text.length; index += 1) grams.push(text.slice(index, index + 2));
  return Array.from(new Set(grams));
}

function keepRelevant(items, tokens, query = '') {
  if (items.length === 0) return items;
  if (tokens.length === 0 && String(query).trim() === '') return items;
  const compactQuery = squeeze(query);
  const grams = cjkGrams(query);
  const latin = tokens.filter((token) => /[a-z0-9]/iu.test(token));
  return items.filter((item) => {
    const haystack = squeeze(`${item.title || ''} ${item.snippet || ''}`);
    if (compactQuery !== '' && haystack.includes(compactQuery)) return true;
    if (grams.length > 0) {
      let hit = 0;
      for (const gram of grams) if (haystack.includes(gram)) hit += 1;
      if (hit / grams.length >= 0.5) return true;
    }
    if (latin.length > 0 && latin.every((token) => haystack.includes(token))) return true;
    return false;
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
  { id: 'zhihurec', zh: '知乎推荐', en: 'Zhihu Recommend', group: 'social', backend: 'zhihu-recommend', list: true, needsLogin: 'zhihu', browser: () => 'https://www.zhihu.com/' },
  { id: 'zhihufollow', zh: '知乎关注', en: 'Zhihu Following', group: 'social', backend: 'zhihu-follow', list: true, needsLogin: 'zhihu', browser: () => 'https://www.zhihu.com/follow' },
  { id: 'csdn', zh: 'CSDN', en: 'CSDN', group: 'cn', backend: 'csdn', browser: (q) => `https://so.csdn.net/so/search?q=${enc(q)}` },
  { id: 'juejin', zh: '掘金', en: 'Juejin', group: 'cn', backend: 'juejin', browser: (q) => `https://juejin.cn/search?query=${enc(q)}` },
  { id: 'cnblogs', zh: '博客园', en: 'Cnblogs', group: 'cn', site: 'cnblogs.com', browser: (q) => `https://zzk.cnblogs.com/s?w=${enc(q)}` },
  { id: 'segmentfault', zh: '思否', en: 'SegmentFault', group: 'cn', backend: 'segmentfault', site: 'segmentfault.com', browser: (q) => `https://segmentfault.com/search?q=${enc(q)}` },
  { id: 'oschina', zh: '开源中国', en: 'OSChina', group: 'cn', site: 'oschina.net', browser: (q) => `https://www.oschina.net/search?scope=all&q=${enc(q)}` },
  { id: 'gitee', zh: 'Gitee', en: 'Gitee', group: 'cn', site: 'gitee.com', browser: (q) => `https://search.gitee.com/?skin=rec&type=repository&q=${enc(q)}` },
  { id: 'bilibili', zh: '哔哩哔哩', en: 'Bilibili', group: 'video', backend: 'bilibili', site: 'bilibili.com', browser: (q) => `https://search.bilibili.com/all?keyword=${enc(q)}` },
  // 抖音 PC 端首页现在统一跳「精选」，站内搜索请走 search 页（带 type=video，不会落回精选首页）。
  { id: 'douyin', zh: '抖音', en: 'Douyin', group: 'video', site: 'douyin.com', browser: (q) => `https://www.douyin.com/search/${enc(q)}?type=video&source=normal_search` },
  { id: 'douyinhot', zh: '抖音热榜', en: 'Douyin Hot', group: 'video', backend: 'douyin-hot', list: true, browser: () => 'https://www.douyin.com/hot' },
  { id: 'weibohot', zh: '微博热搜', en: 'Weibo Hot', group: 'social', backend: 'weibo-hot', list: true, browser: () => 'https://s.weibo.com/top/summary' },
  { id: 'bilihot', zh: 'B站热门', en: 'Bilibili Popular', group: 'video', backend: 'bili-hot', list: true, browser: () => 'https://www.bilibili.com/v/popular/rank/all' },
  { id: 'zhihuhot', zh: '知乎热榜', en: 'Zhihu Hot', group: 'social', backend: 'zhihu-hot', list: true, needsLogin: 'zhihu', browser: () => 'https://www.zhihu.com/hot' },
  { id: 'baiduhot', zh: '百度热搜', en: 'Baidu Hot', group: 'general', backend: 'baidu-hot', list: true, browser: () => 'https://top.baidu.com/board?tab=realtime' },
  { id: 'toutiaohot', zh: '头条热榜', en: 'Toutiao Hot', group: 'general', backend: 'toutiao-hot', list: true, browser: () => 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc' },
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
  { id: 'mdn', zh: 'MDN 文档', en: 'MDN', group: 'dev', backend: 'mdn', site: 'developer.mozilla.org', browser: (q) => `https://developer.mozilla.org/zh-CN/search?q=${enc(q)}` },
  { id: 'pypi', zh: 'PyPI', en: 'PyPI', group: 'dev', site: 'pypi.org', browser: (q) => `https://pypi.org/search/?q=${enc(q)}`, needsTunnel: true },
  { id: 'wikipedia', zh: '维基百科', en: 'Wikipedia', group: 'dev', backend: 'wikipedia', browser: (q) => `https://zh.wikipedia.org/w/index.php?search=${enc(q)}`, needsTunnel: true },

  { id: 'taobao', zh: '淘宝', en: 'Taobao', group: 'shop', site: 'item.taobao.com', browser: (q) => `https://s.taobao.com/search?q=${enc(q)}` },
  { id: 'jd', zh: '京东', en: 'JD', group: 'shop', site: 'jd.com', browser: (q) => `https://search.jd.com/Search?keyword=${enc(q)}` },
  { id: '1688', zh: '1688', en: '1688', group: 'shop', site: '1688.com', browser: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${enc(q)}` },
  { id: 'amazon', zh: '亚马逊', en: 'Amazon', group: 'shop', site: 'amazon.com', browser: (q) => `https://www.amazon.com/s?k=${enc(q)}`, needsTunnel: true },
  { id: 'xianyu', zh: '闲鱼', en: 'Xianyu', group: 'shop', site: 'goofish.com', browser: (q) => `https://www.goofish.com/search?q=${enc(q)}` },
  { id: 'douban', zh: '豆瓣', en: 'Douban', group: 'content', backend: 'douban', site: 'douban.com', browser: (q) => `https://www.douban.com/search?q=${enc(q)}` },
  { id: 'sspai', zh: '少数派', en: 'SSPAI', group: 'content', site: 'sspai.com', browser: (q) => `https://sspai.com/search/post/${enc(q)}` },
  { id: 'medium', zh: 'Medium', en: 'Medium', group: 'content', site: 'medium.com', browser: (q) => `https://medium.com/search?q=${enc(q)}`, needsTunnel: true },
];

export const PLATFORMS = new Map(PLATFORM_LIST.map((item) => [item.id, item]));

// 外部 provider 带来的平台定义（v1.15）。自定义站点仍然直接写进 PLATFORM_LIST。
let EXTERNAL_PLATFORMS = [];

/** 按 PLATFORM_LIST + 外部 provider 重建 Map（原地改，保持导出引用有效）。 */
export function rebuildPlatformMap() {
  const next = new Map();
  for (const item of PLATFORM_LIST) next.set(item.id, item);
  for (const item of EXTERNAL_PLATFORMS) next.set(item.id, item);
  PLATFORMS.clear();
  for (const [id, def] of next) PLATFORMS.set(id, def);
  return PLATFORMS.size;
}

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
      kind: item.kind && item.kind !== 'auto' ? String(item.kind) : 'auto',
      url: template,
      site: site || undefined,
      browser: (query) => customUrl(template, query),
    };
    const index = PLATFORM_LIST.findIndex((entry) => entry.id === id);
    if (index >= 0) PLATFORM_LIST[index] = definition;
    else PLATFORM_LIST.push(definition);
  }
  for (let index = PLATFORM_LIST.length - 1; index >= 0; index -= 1) {
    const entry = PLATFORM_LIST[index];
    if (entry && entry.id.startsWith('custom:') && !wanted.has(entry.id)) PLATFORM_LIST.splice(index, 1);
  }
  rebuildPlatformMap();
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
  ['知乎推荐', 'zhihurec'],
  ['知乎关注', 'zhihufollow'],
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
  ['微博热搜', 'weibohot'],
  ['微博', 'weibo'],
  ['b站热门', 'bilihot'],
  ['b站排行榜', 'bilihot'],
  ['知乎热榜', 'zhihuhot'],
  ['百度热搜', 'baiduhot'],
  ['头条热榜', 'toutiaohot'],
  ['抖音热榜', 'douyinhot'],
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
  // 用 PLATFORMS（含外部 provider 与自定义站点），不是只有内置的 PLATFORM_LIST
  return [...PLATFORMS.values()].map((item) => ({
    id: item.id,
    label: item.zh,
    labelEn: item.en,
    group: item.group,
    backend: item.custom ? item.url || '自定义' : item.backend ? item.backend : `site:${item.site}`,
    needsTunnel: item.needsTunnel === true,
    domain: cookieDomainFor(item.id),
    login: loginUrlFor(item.id) || (item.needsLogin ? loginUrlFor(item.needsLogin) : ''),
    custom: item.custom === true,
    list: item.list === true,
    kind: kindOf(item),
    source: item.providerSource || (item.custom ? 'custom' : 'builtin'),
  }));
}

// ---------------------------------------------------------------------------
// query helpers: strip conversational filler, detect platforms
// ---------------------------------------------------------------------------

const PLATFORM_HINTS = [
  [/b\s*站|哔哩|bilibili/i, 'bilibili'],
  [/知乎推荐|推荐流/i, 'zhihurec'],
  [/知乎关注|关注流/i, 'zhihufollow'],
  [/知乎/i, 'zhihu'],
  [/小红书|xhs/i, 'xiaohongshu'],
  [/抖音|douyin/i, 'douyin'],
  [/淘宝|天猫/i, 'taobao'],
  [/京东/i, 'jd'],
  [/闲鱼/i, 'xianyu'],
  [/微博热搜/i, 'weibohot'],
  [/b\s*站热门|b站排行/i, 'bilihot'],
  [/知乎热榜/i, 'zhihuhot'],
  [/百度热搜/i, 'baiduhot'],
  [/头条热榜/i, 'toutiaohot'],
  [/抖音热榜/i, 'douyinhot'],
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

const HINT_GENERIC = {
  weibohot: ['weibo'],
  bilihot: ['bilibili'],
  zhihuhot: ['zhihu'],
  baiduhot: ['baidu'],
  toutiaohot: ['toutiao'],
  douyinhot: ['douyin'],
  zhihurec: ['zhihu'],
  zhihufollow: ['zhihu'],
};

export function inferPlatforms(text) {
  const found = new Set();
  const value = String(text || '');
  for (const [pattern, id] of PLATFORM_HINTS) {
    if (pattern.test(value)) found.add(id);
  }
  for (const id of [...found]) {
    for (const generic of HINT_GENERIC[id] || []) found.delete(generic);
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

/** 跳转壳：搜索引擎把结果包成自己的 /link?url=... 中转页，正文信息为 0。 */
const REDIRECT_PATH = /\/(?:link|url)\?(?:[^#]*\b(?:url|m|k|q)=)|\/s\?[^#]*\bwd=|\/web\?[^#]*query=|\/search\?[^#]*\bq=/i;
const REDIRECT_HOSTS = new Set([
  'baidu.com',
  'so.com',
  'sogou.com',
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'search.brave.com',
]);

/** 典型"没有正文"的标题：聚合卡片、搜索建议、站内搜索壳。 */
const JUNK_TITLE = [
  /的最新相关信息$/u,
  /的最新消息$/u,
  /的最新报道$/u,
  /的搜索结果$/u,
  /^相关搜索/u,
  /^大家都在搜/u,
  /^大家还在搜/u,
  /^百度一下/u,
  /^_?百度搜索$/u,
  /^百度图片$/u,
  /^百度视频$/u,
  /^搜狗搜索$/u,
  /^360搜索$/u,
  /^Search results?$/iu,
  /- Google 搜索$/u,
];

export function isRedirectorUrl(value) {
  const url = String(value || '');
  if (url === '') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./u, '');
  const matched = [...REDIRECT_HOSTS].some((base) => host === base || host.endsWith(`.${base}`));
  if (!matched) return false;
  if (!REDIRECT_PATH.test(parsed.pathname + parsed.search)) return false;
  return true;
}

export function isJunkResult(item, query = '') {
  const title = String((item && item.title) || '').trim();
  const url = String((item && item.url) || '').trim();
  if (title === '' || url === '') return true;
  if (title === query.trim()) return true;
  if (JUNK_TITLE.some((rule) => rule.test(title))) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname.replace(/^www\./u, '');
  // 搜索引擎自己的结果页（/s?wd= / /web?query= / /search?q=）没有正文，属于空壳。
  if (/^(?:baidu|so|sogou|bing|google)\.com$/u.test(host) && /^\/(?:s|web|search)\/?$/u.test(parsed.pathname)) {
    return true;
  }
  return false;
}

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
    // 百度把真实地址放在容器的 mu / data-landurl 上；href 常常只是 /link?url=... 中转壳。
    const head = chunk.slice(0, 2400);
    const pick = /(?:^|\s)(?:mu|data-landurl)="([^"]+)"/i.exec(head);
    const candidate = pick ? decodeEntities(pick[1]) : '';
    const href = absolutize(decodeEntities(anchor[1]), 'https://www.baidu.com');
    const url = /^https?:\/\//i.test(candidate) && !isRedirectorUrl(candidate) ? candidate : href;
    const title = stripTags(anchor[2]);
    if (url === '' || title === '') continue;
    const snippetMatch = /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk) ||
      /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    out.push({ title, url, snippet: snippetMatch ? htmlToText(snippetMatch[1], { scoped: true }) : '' });
  }
  return out;
};

// m.so.com 的移动版结构：<div class="... res-list ..."> + <a class=alink href="https://m.so.com/jump?u=<编码真地址>&m=..">
// + <h3 class="res-title">标题</h3> + <div class="summary">摘要</div>。桌面版被验证码挡住时用它。
function parseSo360Mobile(text, limit) {
  const out = [];
  const blocks = text.split(/<div[^>]*class="[^"]*\bres-list\b/).slice(1);
  for (const chunk of blocks) {
    const titleMatch = /<h3[^>]*class="[^"]*\bres-title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(chunk);
    const hrefMatch = /href="(https?:\/\/m\.so\.com\/jump\?[^"]+)"/i.exec(chunk);
    if (!titleMatch || !hrefMatch) continue;
    const title = stripTags(titleMatch[1]);
    if (title === '') continue;
    let url = '';
    try {
      const parsed = new URL(decodeEntities(hrefMatch[1]));
      url = parsed.searchParams.get('u') || '';
    } catch {
      url = '';
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (isRedirectorUrl(url)) continue;
    const mobileHost = hostOf(url);
    // 360 会在结果流里插自己的推荐/追问（m.so.com/s?q=…&src=own_recommend_top、猜您关注），一律丢掉。
    if (mobileHost === 'so.com' || mobileHost.endsWith('.so.com')) continue;
    const summaryMatch = /<div[^>]*class="[^"]*\bsummary\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    out.push({ title, url, snippet: summaryMatch ? htmlToText(summaryMatch[1], { scoped: true }).slice(0, 300) : '' });
    if (out.length >= limit) break;
  }
  return out;
}

backends.so360 = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const res = await client.request(`https://www.so.com/s?q=${enc(query)}&pn=${page}&rn=${Math.min(30, limit * 2)}`, { timeoutMs });
  const captcha = /请输入验证码|antispider|captcha/i.test(res.text) && !/res-list/.test(res.text);
  if (captcha) {
    // 桌面版按 IP 丢验证码是常态，换移动版顶上（实测同一个 IP 下移动版仍可用）。
    const mobile = await client.request(`https://m.so.com/s?q=${enc(query)}`, { timeoutMs });
    const mobileRows = parseSo360Mobile(mobile.text, Math.min(30, limit * 2));
    if (mobileRows.length > 0) return mobileRows;
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

// registry.npmjs.org 在部分网络下不可达（实测超时），npmmirror 是同一份 v1 搜索协议，直接顶上。
const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

// 豆瓣的联想接口免登录、返回 JSON（title/url/year/type/img），比搜索页面（JS 渲染 + 登录墙）可用。
backends.douban = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const { data } = await client.json(`https://movie.douban.com/j/subject_suggest?q=${enc(query)}`, { timeoutMs });
  const rows = Array.isArray(data) ? data : [];
  return rows.slice(0, Math.max(limit, 10)).map((row) => ({
    title: row.title || '',
    url: row.url || '',
    snippet: [row.sub_title, row.year, row.type].filter(Boolean).join(' · ').slice(0, 200),
    thumb: row.img ? String(row.img).replace(/^http:/, 'https:') : '',
    extra: { type: row.type, year: row.year },
  })).filter((row) => row.url !== '');
};

// 思否的搜索页是服务端渲染的（<a href="/a/<id>"><h5>标题</h5>），站内检索可靠；site: 兜底在必应上已失效。
backends.segmentfault = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const res = await client.request(`https://segmentfault.com/search?q=${enc(query)}`, {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    timeoutMs,
  });
  const out = [];
  const seen = new Set();
  const pattern = /<a[^>]+href="(\/(?:a|q)\/\d+[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(res.text)) !== null) {
    const href = match[1];
    if (seen.has(href)) continue;
    const title = stripTags(match[2]);
    if (title === '' || title.length < 4) continue;
    seen.add(href);
    out.push({
      title,
      url: `https://segmentfault.com${href}`,
      snippet: '',
    });
    if (out.length >= Math.max(limit, 8)) break;
  }
  if (out.length === 0 && /验证|security check/i.test(res.text)) {
    throw new EngineBlocked('segmentfault blocked', { browser: `https://segmentfault.com/search?q=${enc(query)}` });
  }
  return out;
};

// MDN 有官方搜索 API（documents[]：mdn_url/title/summary），比 site: 兜底可靠得多。
backends.mdn = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  const { data } = await client.json(
    `https://developer.mozilla.org/api/v1/search?q=${enc(query)}&locale=zh-CN`,
    { timeoutMs },
  );
  const docs = data && Array.isArray(data.documents) ? data.documents : [];
  return docs.slice(0, Math.max(limit, 8)).map((doc) => ({
    title: doc.title || doc.slug || '',
    url: doc.mdn_url ? `https://developer.mozilla.org${doc.mdn_url}` : 'https://developer.mozilla.org/',
    snippet: String(doc.summary || '').slice(0, 300),
    extra: { score: doc.score, popularity: doc.popularity },
  }));
};

backends.npm = async (ctx) => {
  const { client, query, limit, timeoutMs } = ctx;
  // 并发打两个 registry：本机 registry.npmjs.org 常常直接超时，串行会白等一整个超时窗口。
  const attempts = NPM_REGISTRIES.map((registry) =>
    client
      .json(`${registry}/-/v1/search?text=${enc(query)}&size=${Math.min(25, limit)}`, {
        timeoutMs: Math.min(timeoutMs, 6000),
      })
      .then((response) => ({ data: response.data }))
      .catch((error) => ({ error })),
  );
  // 谁先成功用谁：不要等那个一定会超时的 registry 把整次搜索拖满 6 秒。
  const data = await new Promise((resolve, reject) => {
    let pending = attempts.length;
    let lastError;
    for (const attempt of attempts) {
      attempt.then((result) => {
        if (result.data !== undefined) {
          resolve(result.data);
          return;
        }
        lastError = result.error;
        pending -= 1;
        if (pending === 0) reject(lastError || new Error('npm registry unreachable'));
      });
    }
  });
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

// ---- 榜单/热搜：微博、B站、知乎、百度、头条（v1.8）----
// 这些是「不需要关键词」的信息流，平台定义带 list: true，只在用户点选时出现。

const HOT_MIN_ROWS = 12;
const HOT_MAX_ROWS = 50;

function hotCount(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}w`;
  return String(number);
}

function hotTaken(limit) {
  return Math.max(HOT_MIN_ROWS, Math.min(HOT_MAX_ROWS, Number(limit) || HOT_MIN_ROWS));
}

function zhihuQuestionUrl(id, url) {
  const value = String(url || '');
  const match = /\/questions\/(\d+)/.exec(value);
  const qid = match ? match[1] : String(id || '');
  return qid === '' ? '' : `https://www.zhihu.com/question/${qid}`;
}

backends['weibo-hot'] = async ({ client, limit, timeoutMs }) => {
  const body = (await client.json('https://weibo.com/ajax/side/hotSearch', { headers: { referer: 'https://weibo.com/' }, timeoutMs })).data;
  const list = body && body.data && Array.isArray(body.data.realtime) ? body.data.realtime : [];
  if (list.length === 0) throw new EngineBlocked('weibo hot list is empty', 'https://s.weibo.com/top/summary');
  return list.filter((row) => row && row.word).slice(0, hotTaken(limit)).map((row, index) => {
    const rank = Number(row.realpos) || index + 1;
    const tag = String(row.label_name || row.icon_desc || '');
    return {
      title: String(row.word),
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(row.word_scheme || `#${row.word}#`)}`,
      snippet: `热搜第 ${rank} 名 · 热度 ${hotCount(row.num)}${tag ? ` · ${tag}` : ''}`,
      source: '微博热搜',
      extra: { rank, hot: Number(row.num) || 0, label: tag },
    };
  });
};

backends['bili-hot'] = async ({ client, limit, timeoutMs }) => {
  const body = (await client.json('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', { headers: { referer: 'https://www.bilibili.com/' }, timeoutMs })).data;
  const list = body && body.data && Array.isArray(body.data.list) ? body.data.list : [];
  if (list.length === 0) throw new EngineBlocked('bilibili ranking is empty', 'https://www.bilibili.com/v/popular/rank/all');
  return list.slice(0, hotTaken(limit)).map((row, index) => {
    const stat = (row && row.stat) || {};
    const bvid = String((row && row.bvid) || `av${(row && row.aid) || ''}`);
    const author = (row && row.owner && row.owner.name) || '';
    const cover = String((row && row.pic) || '');
    return {
      title: String((row && row.title) || ''),
      url: `https://www.bilibili.com/video/${bvid}`,
      snippet: `热门第 ${index + 1} 名 · ${hotCount(stat.view)} 播放 · ${hotCount(stat.like)} 赞${author ? ` · @${author}` : ''}`,
      thumb: cover.startsWith('//') ? `https:${cover}` : cover,
      embed: /^BV/.test(bvid) ? `https://player.bilibili.com/player.html?bvid=${bvid}&autoplay=1&high_quality=1&danmaku=0` : '',
      source: 'B站热门',
      extra: { rank: index + 1, view: Number(stat.view) || 0, like: Number(stat.like) || 0, author },
    };
  });
};

backends['zhihu-hot'] = async ({ client, limit, timeoutMs }) => {
  const cookie = client.jar.header('www.zhihu.com') || '';
  if (!/(^|;\s*)z_c0=/.test(cookie)) {
    const error = new Error('还没登录知乎：在面板「登录与账号 → 插件浏览器」里登录一次，再点「读取登录」');
    error.login = true;
    error.blocked = true;
    throw error;
  }
  const body = (await client.json('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50&desktop=true', { headers: { referer: 'https://www.zhihu.com/hot' }, timeoutMs })).data;
  const list = body && Array.isArray(body.data) ? body.data : [];
  if (list.length === 0) throw new EngineBlocked('zhihu hot list is empty', 'https://www.zhihu.com/hot');
  const rows = [];
  for (const item of list) {
    const target = (item && item.target) || {};
    const url = zhihuQuestionUrl(target.id, target.url);
    if (!url) continue;
    rows.push({
      title: String(target.title || ''),
      url,
      snippet: `热榜第 ${rows.length + 1} 名 · ${hotCount(target.answer_count)} 回答 · ${hotCount(target.follower_count)} 关注`,
      source: '知乎热榜',
      extra: { rank: rows.length + 1, answers: target.answer_count, followers: target.follower_count, detail: item.detail_text },
    });
    if (rows.length >= hotTaken(limit)) break;
  }
  if (rows.length === 0) throw new EngineBlocked('zhihu hot list has no questions', 'https://www.zhihu.com/hot');
  return rows;
};

backends['baidu-hot'] = async ({ client, limit, timeoutMs }) => {
  const body = (await client.json('https://top.baidu.com/api/board?platform=wise&tab=realtime', { headers: { referer: 'https://top.baidu.com/board?tab=realtime' }, timeoutMs })).data;
  const cards = (body && body.data && Array.isArray(body.data.cards) && body.data.cards) || [];
  const rows = [];
  for (const card of cards) {
    for (const block of (card && card.content) || []) {
      const items = Array.isArray(block.content) ? block.content : block.word ? [block] : [];
      for (const item of items) {
        if (!item || !item.word) continue;
        rows.push({
          title: String(item.word),
          url: `https://www.baidu.com/s?wd=${encodeURIComponent(String(item.word || item.query || ''))}`,
          snippet: `热搜第 ${rows.length + 1} 名${item.desc ? ` · ${String(item.desc).slice(0, 60)}` : ''}`,
          source: '百度热搜',
          extra: { rank: rows.length + 1, desc: item.desc || '', hot: item.hotScore || '' },
        });
        if (rows.length >= hotTaken(limit)) return rows;
      }
    }
  }
  if (rows.length === 0) throw new EngineBlocked('baidu board is empty', 'https://top.baidu.com/board?tab=realtime');
  return rows;
};

backends['toutiao-hot'] = async ({ client, limit, timeoutMs }) => {
  const body = (await client.json('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', { headers: { referer: 'https://www.toutiao.com/' }, timeoutMs })).data;
  const list = body && Array.isArray(body.data) ? body.data : [];
  if (list.length === 0) throw new EngineBlocked('toutiao hot board is empty', 'https://www.toutiao.com/hot-event/hot-board/');
  return list.filter((row) => row && row.Title).slice(0, hotTaken(limit)).map((row, index) => {
    const tag = String(row.LabelDesc || row.Label || '');
    return {
      title: String(row.Title),
      url: String(row.Url || `https://so.toutiao.com/search?keyword=${encodeURIComponent(row.Title)}`),
      snippet: `热榜第 ${index + 1} 名 · 热度 ${hotCount(row.HotValue)}${tag ? ` · ${tag}` : ''}`,
      source: '头条热榜',
      extra: { rank: index + 1, hot: Number(row.HotValue) || 0, label: tag },
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

/** 搜狗的 /link?url=... 会 302 到 mp.weixin.qq.com；解析失败就保留原壳（至少能点开）。 */
async function resolveSogouLink(client, url, timeoutMs) {
  if (!/weixin\.sogou\.com\/link\?url=/u.test(url)) return url;
  try {
    const res = await client.request(url, {
      headers: { referer: 'https://weixin.sogou.com/' },
      timeoutMs: Math.min(timeoutMs, 3000),
    });
    const finalUrl = String(res.url || '');
    if (/^https:\/\/(?:mp\.)?weixin\.qq\.com\//u.test(finalUrl)) return finalUrl;
    const jumped = /window\.location\.replace\(["']([^"']+)["']\)/u.exec(res.text);
    if (jumped) {
      const next = absolutize(decodeEntities(jumped[1]), 'https://weixin.sogou.com');
      if (/^https:\/\/(?:mp\.)?weixin\.qq\.com\//u.test(next)) return next;
    }
  } catch {
    /* 解析失败就用原链接 */
  }
  return url;
}

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
  // 搜狗的 /link?url=… 会被 antispider 拦（实测 302 到验证页），解不出来就保留原链：
  // 在真实浏览器里点开是能跳的，只是服务端拿不到最终地址，所以打一个标记让面板显示「中转」。
  return items.slice(0, Math.max(limit, 10)).map((item) => ({ ...item, extra: { ...(item.extra || {}), shell: true } }));
};

// ---- 知乎信息流（v1.7）：按页取「推荐 / 关注」，与关键词无关，需要登录 cookie（z_c0） ----

const ZHIHU_FEED_URL = {
  'zhihu-recommend': (page) =>
    `https://www.zhihu.com/api/v3/feed/topstory/recommend?action=down&ad_interval=-1&desktop=true&page_number=${page}&limit=10`,
  'zhihu-follow': (page) => `https://www.zhihu.com/api/v3/feed/topstory?limit=10&desktop=true&page_number=${page}`,
};

function zhihuFeedRow(target) {
  if (!target || typeof target !== 'object') return undefined;
  const type = String(target.type || '');
  const author = (target.author && target.author.name) || '';
  const created = Number(target.created_time || 0);
  const date = created > 0 ? new Date(created * 1000).toISOString().slice(0, 10) : '';
  const text = (html, max = 180) => stripTags(String(html || '')).replace(/\s+/g, ' ').trim().slice(0, max);
  const extra = (kind) => ({ kind, author, votes: target.voteup_count, comments: target.comment_count, date });

  if (type === 'answer' && target.question) {
    return {
      title: target.question.title || target.question.name || '',
      url: `https://www.zhihu.com/question/${target.question.id}/answer/${target.id}`,
      snippet: text(target.excerpt),
      source: '知乎',
      extra: extra('回答'),
    };
  }
  if (type === 'article') {
    return {
      title: target.title || '',
      url: `https://zhuanlan.zhihu.com/p/${target.id}`,
      snippet: text(target.excerpt),
      source: '知乎',
      extra: extra('文章'),
    };
  }
  if (type === 'zvideo') {
    return {
      title: target.title || '',
      url: target.url || `https://www.zhihu.com/zvideo/${target.id}`,
      snippet: text(target.description || target.excerpt),
      source: '知乎',
      extra: extra('视频'),
    };
  }
  if (type === 'pin') {
    const body = target.content || {};
    return {
      title: text(body.title || body.content, 60) || '想法',
      url: target.url || `https://www.zhihu.com/pin/${target.id}`,
      snippet: text(body.content),
      source: '知乎',
      extra: extra('想法'),
    };
  }
  const fallback = target.title || (target.question && target.question.title) || '';
  if (!fallback) return undefined;
  return { title: fallback, url: target.url || '', snippet: text(target.excerpt), source: '知乎', extra: extra(type || '内容') };
}

for (const name of Object.keys(ZHIHU_FEED_URL)) {
  backends[name] = async (ctx) => {
    const { client, limit, timeoutMs, page = 1, pages = 1 } = ctx;
    const cookie = client.jar.header('www.zhihu.com') || '';
    if (!/(^|;\s*)z_c0=/.test(cookie)) {
      const error = new Error('还没登录知乎：在面板「登录与账号 → 插件浏览器」里登录一次，再点「读取登录」');
      error.login = true;
      error.blocked = true;
      throw error;
    }
    const collected = [];
    const last = Math.min(4, page + Math.max(1, pages) - 1);
    for (let current = page; current <= last; current += 1) {
      const { data } = await client.json(ZHIHU_FEED_URL[name](current), {
        headers: { referer: 'https://www.zhihu.com/' },
        timeoutMs,
      });
      const items = Array.isArray(data && data.data) ? data.data : [];
      for (const item of items) {
        const row = zhihuFeedRow(item.target || item);
        if (row) collected.push(row);
      }
      if (items.length === 0) break;
      if (dedupe(collected).length >= limit) break;
    }
    return dedupe(collected).slice(0, Math.max(limit, 6));
  };
}

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
  // client.json() 已经把响应体放进 .data，接口自己的载荷在 .data.data 里。
  const spiData = (spi.data && spi.data.data) || {};
  const cookieParts = [];
  if (typeof spiData.b_3 === 'string' && spiData.b_3 !== '') cookieParts.push(`buvid3=${spiData.b_3}`);
  if (typeof spiData.b_4 === 'string' && spiData.b_4 !== '') cookieParts.push(`buvid4=${spiData.b_4}`);
  if (cookieParts.length > 0) client.jar.store.set('bilibili.com', cookieParts.join('; '));
  const nav = await client.json('https://api.bilibili.com/x/web-interface/nav', { timeoutMs });
  const navBody = (nav.data && nav.data.data) || nav.data || {};
  const img = navBody.wbi_img || {};
  const pick = (url) => String(url || '').split('/').pop().split('.')[0];
  const raw = `${pick(img.img_url)}${pick(img.sub_url)}`;
  if (raw.length < 32) return '';
  const key = MIXIN_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
  wbiCache = { at: Date.now(), key };
  return key;
}

// ---------------------------------------------------------------------------
// 视频站点增强（v1.11）：作者名 + 他在作者作品里的序号
// ---------------------------------------------------------------------------
const authorTotalCache = new Map();
const spacePageCache = new Map();
// B 站空间接口按 IP 风控：连打几页就 -412/-799。命中过一次就静默一段时间，
// 免得每个搜索都去撞墙，把风控越撞越久。
let spaceBanUntil = 0;

const SPACE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SPACE_BAN_MS = 10 * 60 * 1000;

async function biliSpacePage(client, mid, page, timeoutMs) {
  const cacheKey = `${mid}:${page}`;
  const hit = spacePageCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.rows;
  if (Date.now() < spaceBanUntil) return [];
  const headers = { referer: `https://space.bilibili.com/${mid}/video`, origin: 'https://space.bilibili.com', 'user-agent': SPACE_UA };
  // 老接口不需要签名，先用它；不行再退回 wbi 签名接口。
  const legacy = await client
    .json(`https://api.bilibili.com/x/space/arc/search?mid=${enc(String(mid))}&ps=20&pn=${enc(String(page))}&order=pubdate`, { headers, timeoutMs })
    .catch(() => null);
  const readRows = (body) => (body && body.code === 0 && body.data && body.data.list ? body.data.list.vlist || [] : []);
  let rows = readRows(legacy && legacy.data);
  if (rows.length > 0) {
    spacePageCache.set(cacheKey, { at: Date.now(), rows });
    return rows;
  }
  const legacyCode = legacy && legacy.data ? Number(legacy.data.code) : 0;
  if (legacyCode === -412 || legacyCode === -799 || legacyCode === -352) {
    spaceBanUntil = Date.now() + SPACE_BAN_MS;
    return [];
  }
  const mixin = await bilibiliKey(client, timeoutMs);
  const params = { mid: String(mid), ps: '20', pn: String(page), order: 'pubdate', platform: 'web', web_location: '1550101' };
  if (mixin !== '') {
    const wts = String(Math.floor(Date.now() / 1000));
    const sorted = Object.keys(params)
      .sort()
      .map((key) => `${enc(key)}=${enc(String(params[key]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    params.wts = wts;
    params.w_rid = md5(`${sorted}&wts=${wts}${mixin}`);
  }
  const search = Object.keys(params).map((key) => `${enc(key)}=${enc(String(params[key]))}`).join('&');
  const { data } = await client.json(`https://api.bilibili.com/x/space/wbi/arc/search?${search}`, { headers, timeoutMs });
  rows = readRows(data);
  const code = data ? Number(data.code) : 0;
  if (code === -412 || code === -799 || code === -352) spaceBanUntil = Date.now() + SPACE_BAN_MS;
  if (rows.length > 0) spacePageCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

async function biliAuthorTotal(client, mid, timeoutMs) {
  const cached = authorTotalCache.get(String(mid));
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.total;
  const { data } = await client.json(`https://api.bilibili.com/x/space/navnum?mid=${enc(String(mid))}`, {
    headers: { referer: `https://space.bilibili.com/${mid}` },
    timeoutMs,
  });
  const total = Number((data && data.data && data.data.video) || 0);
  if (total > 0) authorTotalCache.set(String(mid), { at: Date.now(), total });
  return total;
}

/**
 * 二分 locates the author's投稿 page that contains this video, then converts the
 * newest-first position into "第 k 个（从最早算起）".
 */
async function biliAuthorRank(client, { mid, bvid, pubdate, total, timeoutMs }) {
  if (!mid || !total || total < 2) return null;
  const per = 20;
  const lastPage = Math.max(1, Math.ceil(total / per));
  let lo = 1;
  let hi = lastPage;
  let found = null;
  let budget = 6;
  while (lo <= hi && budget > 0) {
    const page = Math.floor((lo + hi) / 2);
    budget -= 1;
    let rows = [];
    try {
      rows = await biliSpacePage(client, mid, page, timeoutMs);
    } catch {
      return null;
    }
    if (rows.length === 0) return null;
    // 空间投稿接口的字段是 created（秒），搜索接口给的是 pubdate，两个都要认。
    const stamp = (row) => Number(row.created || row.pubdate || 0);
    const newest = stamp(rows[0]);
    const oldest = stamp(rows[rows.length - 1]);
    if (pubdate > newest) {
      hi = page - 1;
      continue;
    }
    if (pubdate < oldest) {
      lo = page + 1;
      continue;
    }
    let idx = rows.findIndex((row) => String(row.bvid || '') === bvid);
    if (idx < 0) idx = rows.findIndex((row) => stamp(row) <= pubdate);
    if (idx < 0) return null;
    found = { page, idx };
    break;
  }
  if (!found) return null;
  const fromNewest = (found.page - 1) * per + found.idx;
  return { rank: Math.max(1, total - fromNewest), total };
}

async function biliAuthorEnrich(client, mapped, timeoutMs) {
  const deadline = Date.now() + Math.min(3000, timeoutMs);
  const targets = mapped.filter((row) => row.extra && row.extra.mid).slice(0, 6);
  // 序号要翻作者投稿分页，最容易被风控；只给第一条争取一下，其余只显示「共 N 个视频」。
  const rankFor = targets.length > 0 ? targets[0] : null;
  await Promise.all(
    targets.map(async (row) => {
      try {
        const remain = deadline - Date.now();
        if (remain < 400) return;
        const total = await biliAuthorTotal(client, row.extra.mid, Math.min(timeoutMs, remain));
        if (!total) return;
        row.extra.authorTotal = total;
        if (row !== rankFor) return;
        const remain2 = deadline - Date.now();
        if (remain2 < 600) return;
        const rank = await biliAuthorRank(client, {
          mid: row.extra.mid,
          bvid: row.extra.bvid,
          pubdate: row.extra.pubdate,
          total,
          timeoutMs: Math.min(timeoutMs, remain2),
        });
        if (rank) {
          row.extra.rank = rank.rank;
          row.extra.authorTotal = rank.total;
        }
      } catch {
        /* 序号只是加分项，失败就当没有 */
      }
    }),
  );
  return mapped;
}

const DOUYIN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function douyinRouterData(html) {
  const marker = '_ROUTER_DATA = ';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const json = sliceBalanced(html, at + marker.length);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 抖音分享页（iesdouyin H5）是唯一免验证码的版本，顺手带回作者与数据。 */
async function douyinShareInfo(client, id, timeoutMs) {
  const { text } = await client.request(`https://www.iesdouyin.com/share/video/${id}/`, {
    headers: { 'user-agent': DOUYIN_UA, referer: 'https://www.douyin.com/' },
    timeoutMs: Math.min(timeoutMs, 8000),
  });
  const data = douyinRouterData(String(text || ''));
  const page = data && data.loaderData ? data.loaderData['video_(id)/page'] : null;
  const item = page && page.videoInfoRes && Array.isArray(page.videoInfoRes.item_list) ? page.videoInfoRes.item_list[0] : null;
  if (!item) return null;
  const cover = item.video && item.video.cover && Array.isArray(item.video.cover.url_list) ? item.video.cover.url_list[0] : '';
  return {
    author: String((item.author && item.author.nickname) || ''),
    desc: String(item.desc || ''),
    digg: Number((item.statistics && item.statistics.digg_count) || 0),
    createTime: Number(item.create_time || 0),
    cover: cover ? (cover.startsWith('//') ? `https:${cover}` : cover) : '',
    shareUrl: `https://www.iesdouyin.com/share/video/${id}/`,
  };
}

/** 抖音结果行改走分享页：用户点开看到的是能播的 H5，而不是「抖音精选」落地页。 */
async function douyinEnrich(client, items, timeoutMs) {
  const deadline = Date.now() + Math.min(6000, timeoutMs);
  const targets = items
    .filter((item) => /douyin\.com\/video\/\d{15,25}/.test(item.url))
    .slice(0, 4);
  // 先无条件换链接：PC 版 www.douyin.com/video/<id> 会跳「精选」并弹 APP 引导，
  // 分享页 iesdouyin 是免验证码的 H5，浏览器里能直接播。
  for (const item of targets) {
    const id = (item.url.match(/\/video\/(\d{15,25})/) || [])[1];
    if (!id) continue;
    item.extra = { ...(item.extra || {}), webUrl: item.url };
    item.url = `https://www.iesdouyin.com/share/video/${id}/`;
  }
  await Promise.all(
    targets.map(async (item) => {
      try {
        const remain = deadline - Date.now();
        if (remain < 600) return;
        const id = (String(item.extra.webUrl || '').match(/\/video\/(\d{15,25})/) || [])[1];
        if (!id) return;
        const info = await douyinShareInfo(client, id, Math.min(timeoutMs, remain));
        if (!info) return;
        item.extra = { ...item.extra, author: info.author, digg: info.digg, createTime: info.createTime };
        if (info.desc) item.snippet = info.desc;
        if (info.cover) item.thumb = info.cover;
      } catch {
        /* 元数据拿不到就只保留换过的链接 */
      }
    }),
  );
  return items;
}

backends.bilibili = async (ctx) => {
  const { client, query, limit, timeoutMs, page = 1 } = ctx;
  const target = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
  const base = {
    search_type: 'video',
    keyword: query,
    page: String(Math.max(1, Number(page) || 1)),
    page_size: String(Math.min(50, Math.max(10, limit))),
  };
  let rows = [];
  let lastCode = 0;
  // wbi 的 key 会过期，也可能被限流：第一次拿不到结果就换一把 key 再试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const mixin = await bilibiliKey(client, timeoutMs);
    const params = { ...base };
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
      // 搜索接口是匿名的：带上 store 里的旧 cookie 反而会被判风控（-412），所以明确不带。
      noCookies: true,
    });
    lastCode = data && data.code ? Number(data.code) : 0;
    rows = data && data.data && Array.isArray(data.data.result) ? data.data.result : [];
    if (rows.length > 0) break;
    wbiCache = { at: 0, key: '' };
  }
  if (rows.length === 0) {
    if (lastCode === -412 || lastCode === -352 || lastCode === -401) {
      throw new EngineBlocked(`bilibili ${lastCode}: 请求被风控`, { browser: `https://search.bilibili.com/all?keyword=${enc(query)}` });
    }
    return [];
  }
  const mapped = rows.slice(0, limit).map((row) => {
    const bvid = String(row.bvid || '');
    const cover = String(row.pic || row.cover || '');
    return {
      title: stripTags(row.title),
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${row.aid || ''}`,
      snippet: stripTags(row.description || ''),
      thumb: cover.startsWith('//') ? `https:${cover}` : cover,
      embed: bvid ? `https://player.bilibili.com/player.html?bvid=${bvid}&autoplay=1&high_quality=1&danmaku=0` : '',
      extra: {
        author: stripTags(row.author || ''),
        authorUrl: row.mid ? `https://space.bilibili.com/${row.mid}` : '',
        mid: row.mid ? Number(row.mid) : 0,
        bvid,
        pubdate: Number(row.pubdate || 0),
        play: row.play,
        duration: row.duration,
      },
    };
  });
  // 作者作品总数 / 这是他的第几个视频（失败就只显示作者）
  return biliAuthorEnrich(client, mapped, timeoutMs);
};

export const BACKENDS = backends;

// ---------------------------------------------------------------------------
// providers（v1.15）：把「平台定义 + 后端调用」收成一个 provider 对象
// ---------------------------------------------------------------------------

/** 内置平台 → provider（search 直接转调旧后端，行为与 v1.14 完全一致）。 */
function providerFor(def) {
  const backend = def.backend ? BACKENDS[def.backend] : null;
  const singlePage = def.list === true || !def.backend || !PAGED_BACKENDS.has(def.backend);
  return {
    id: def.id,
    label: def.zh || def.id,
    labelEn: def.en || '',
    group: def.group || 'general',
    kind: def.kind || 'auto',
    list: def.list === true,
    needsLogin: def.needsLogin || '',
    needsTunnel: def.needsTunnel === true,
    site: def.site || '',
    backend: def.backend || '',
    singlePage,
    browser: typeof def.browser === 'function' ? def.browser : null,
    source: 'builtin',
    async search(ctx) {
      const { client, query, limit, timeoutMs, page } = ctx;
      if (backend) return backend({ client, query, limit, timeoutMs, page, pages: ctx.pages });
      if (def.url) return fetchCustom({ client, def, query, limit });
      if (def.site) return siteSearch({ client, query, site: def.site, limit, timeoutMs });
      return BACKENDS.bing({ client, query, limit, timeoutMs, page });
    },
  };
}

/** 外部 provider → 平台定义（catalog / chips / inferPlatforms 都靠这张表）。 */
function platformDefFor(provider) {
  return {
    id: provider.id,
    zh: provider.label,
    en: provider.labelEn || provider.label,
    group: provider.group,
    kind: provider.kind,
    list: provider.list,
    needsLogin: provider.needsLogin || undefined,
    needsTunnel: provider.needsTunnel || undefined,
    site: provider.site || undefined,
    providerSource: provider.source,
    browser: provider.browser || ((query) => (provider.site ? `https://${provider.site}/` : `https://www.bing.com/search?q=${enc(query)}`)),
  };
}

export const PROVIDERS = providers;

/** 内置 provider 注册（幂等，重复调用只覆盖）。 */
export function registerBuiltinProviders() {
  const results = [];
  for (const def of PLATFORM_LIST) {
    if (def.id.startsWith('custom:')) continue;
    results.push(providers.register(providerFor(def), { replace: true, source: 'builtin' }));
  }
  return results;
}

/**
 * 初始化 provider 层：内置 → 外部目录 → 重建平台表。
 * 外部目录读不到/写错都不抛，错误进 report.errors。
 */
export async function initProviders(options = {}) {
  registerBuiltinProviders();
  const report = await loadExternalProviders({ dir: options.directory || externalProviderDir(), registry: providers });
  const added = providers.bySource('external');
  EXTERNAL_PLATFORMS = added.map(platformDefFor);
  rebuildPlatformMap();
  return {
    builtin: providers.bySource('builtin').length,
    external: added.map((provider) => provider.id),
    platforms: PLATFORMS.size,
    dir: report.dir,
    skipped: report.skipped,
    errors: report.errors,
  };
}

/** provider 概览（HTTP op provider.list 用）。 */
export function providerCatalog() {
  return providers.list().map((provider) => ({
    id: provider.id,
    label: provider.label,
    labelEn: provider.labelEn,
    source: provider.source,
    kind: provider.kind,
    list: provider.list,
    site: provider.site,
    needsLogin: provider.needsLogin,
    searchable: typeof provider.search === 'function',
  }));
}


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
  const { query, site, limit, stats } = ctx;
  const scoped = `${query} site:${site}`;
  const rows = [];
  const attempts = [
    () => BACKENDS.bing({ ...ctx, query: scoped }),
    () => BACKENDS.so360({ ...ctx, query: scoped }),
    // 百度放在最后兜底：它的 href 是 /link?url=… 中转壳，mu 属性才是真地址（v1.13 已改用 mu）。
    () => BACKENDS.baidu({ ...ctx, query: scoped }),
  ];
  for (const attempt of attempts) {
    let found = [];
    try {
      found = await attempt();
    } catch {
      // 这个引擎挡了（验证码 / 反爬），换下一个
      continue;
    }
    let matched = 0;
    for (const row of found) {
      const url = absolutize(row.url, `https://${site}`);
      const host = hostOf(url);
      if (host === site || host.endsWith(`.${site}`)) {
        rows.push({ ...row, url });
        matched += 1;
      }
    }
    // 引擎返回了一堆结果却一条都不属于这个站点，说明它压根没执行 site: —— 再问下一个引擎也一样，直接收手。
    if (matched === 0 && found.length >= 3) {
      if (stats && typeof stats === 'object') {
        stats.ignored = true;
        stats.engine = (ctx.engine || '') || (stats.engine || '');
      }
      break;
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
const PAGED_BACKENDS = new Set(['csdn', 'v2ex', 'github', 'stackexchange', 'hackernews', 'bilibili', 'so360', 'baidu', 'weixin', 'segmentfault']);

export async function runSearch(options) {
  const query = String(options.query || '').trim();
  const fallback = Array.isArray(options.defaultPlatforms) && options.defaultPlatforms.length > 0 ? options.defaultPlatforms : ['bing', 'so360'];
  const ids = resolvePlatforms(options.platforms, fallback, options.hints).slice(0, Math.min(14, Math.max(1, Number(options.maxPlatforms) || 10)));
  // 信息流平台（抖音热榜 / 知乎推荐 / 知乎关注）与关键词无关，允许空查询。
  const feedOnly = ids.length > 0 && ids.every((id) => {
    const def = PLATFORMS.get(id);
    return Boolean(def && def.list === true);
  });
  if (query === '' && !feedOnly) throw new Error('query is empty');
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
      const provider = providers.get(id);
      if (provider && typeof provider.search === 'function') {
        rows = await collectPages(
          (page) => provider.search({ client, query, limit: fetchLimit, timeoutMs: platformTimeout, page, pages }),
          { pages, limit: fetchLimit, singlePage: provider.singlePage === true || def.list === true },
        );
      } else if (def.backend && BACKENDS[def.backend]) {
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
      let dropped = 0;
      const collected = dedupe(
        (rows || [])
          .map((row) => result(id, def, row))
          .filter((item) => {
            const host = hostOf(item.url);
            if (host === '') {
              dropped += 1;
              return false;
            }
            if (selfHost && (host === selfHost || host.endsWith(`.${selfHost}`))) {
              dropped += 1;
              return false;
            }
            if (def.list !== true && isJunkResult(item, query)) {
              dropped += 1;
              return false;
            }
            if (def.backend === undefined && isLandingPage(item.url)) {
              dropped += 1;
              return false;
            }
            return true;
          }),
      );
      const items0 = def.list === true ? collected : keepRelevant(collected, relevanceTokens(query), query);
      // 抓到了内容但全被判为不相关：多半是搜索引擎返回了降级/风控页（比如整页都是 7-Zip），
      // 这时候说「没结果」不准确，明确告诉用户是被过滤掉的。
      const offTopic = def.list !== true && collected.length > 0 && items0.length === 0;
      if (offTopic) dropped += collected.length;
      let items = items0.slice(0, limit);
      if (id === 'douyin' && items.length > 0) {
        items = await douyinEnrich(client, items, platformTimeout);
      }
      // 站内兜底：一条都没留下，或者少得可怜（< 3 条）时，用 site: 站内检索补一批再合并去重。
      // 单平台抓取本身有上限（bing 只有 10 条），不补的话「B 站只剩 1 条」这种会白白丢掉条数。
      let siteIgnored = false;
      if (def.list !== true && def.site && items.length < Math.min(3, limit)) {
        const siteStats = {};
        const extra = await siteSearch({ client, query, site: def.site, limit: fetchLimit, timeoutMs: platformTimeout, stats: siteStats });
        const more = (extra || [])
          .map((row) => result(id, def, row))
          .filter((item) => !isLandingPage(item.url) && !isJunkResult(item, query));
        siteIgnored = siteStats.ignored === true;
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
        status: items.length > 0 ? 'ok' : offTopic ? 'blocked' : 'empty',
        note: items.length > 0
          ? items.length === 1 && items[0].extra && items[0].extra.inSite
            ? '只给站内搜索入口（正文结果需要站内渲染）'
            : `${Date.now() - started}ms${dropped > 0 ? ` · 滤掉 ${dropped} 条空壳` : ''}`
          : offTopic
            ? `抓到的 ${collected.length} 条都不含查询词，已过滤`
            : def.custom
            ? '没从页面里解析到结果（该站点可能依赖浏览器渲染，可直接在浏览器打开）'
            : def.site
              ? siteIgnored
                ? '搜索引擎忽略了 site: 过滤（该站点不支持服务端检索），已给站内入口'
                : '站点内没抓到正文结果（首页/频道页已过滤），可直接在浏览器打开'
              : 'no results',
        count: items.length,
        browser: browserUrl,
        backend: def.backend || `site:${def.site}`,
        kind: kindOf(def),
        login: def.needsLogin !== undefined,
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
          ? error.login === true
            ? `需要登录：${error.message}`
            : `需要浏览器：${error.message}`
          : def.needsTunnel
            ? `${summarizeError(error)}（该站点通常需要代理，已给出浏览器入口）`
            : summarizeError(error),
        count: 0,
        browser: browserUrl,
        backend: def.backend || `site:${def.site}`,
        kind: kindOf(def),
        login: def.needsLogin !== undefined,
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

// ---------------------------------------------------------------- 证据包（v1.17）
const EVIDENCE_DEFAULTS = {
  budgetChars: 6000,
  maxItems: 10,
  perPlatform: 3,
  excerptChars: 240,
};

const KIND_LABELS = {
  video: '视频',
  article: '文章',
  qa: '问答',
  forum: '论坛',
  hot: '榜单',
  shop: '商品',
  code: '代码',
  doc: '文档',
  social: '动态',
  web: '网页',
};

/** 把一句文本切成句子（中英标点都切），用于挑「最相关的那句」当摘录。 */
function sentenceSplit(text) {
  return String(text || '')
    .replace(/\s+/gu, ' ')
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function tokenHits(haystack, tokens, grams) {
  const compact = squeeze(haystack);
  if (compact === '') return 0;
  let hits = 0;
  for (const token of tokens) if (compact.includes(token)) hits += 1;
  if (grams.length > 0) {
    let gramHits = 0;
    for (const gram of grams) if (compact.includes(gram)) gramHits += 1;
    hits += (gramHits / grams.length) * Math.min(2, tokens.length || 1);
  }
  return hits;
}

function freshnessScore(extra) {
  if (!extra || typeof extra !== 'object') return 0;
  const raw = extra.pubdate || extra.publishedAt || extra.createTime || extra.date || extra.ctime || 0;
  let stamp = Number(raw);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    const parsed = Date.parse(String(raw));
    stamp = Number.isFinite(parsed) ? parsed : 0;
  }
  if (!stamp) return 0;
  if (stamp < 1e11) stamp *= 1000; // 秒 → 毫秒
  const days = (Date.now() - stamp) / 86400000;
  if (days < 0) return 0.3;
  if (days <= 7) return 1;
  if (days <= 30) return 0.6;
  if (days <= 365) return 0.3;
  return 0.1;
}

function backendWeight(item) {
  const platform = String(item.platform || '');
  if (platform.startsWith('custom:')) return 0.7;
  const def = PLATFORMS.get(platform);
  if (!def) return 0.5;
  if (def.list === true) return 0.55;
  if (def.backend !== undefined) return 1;
  if (def.url !== undefined) return 0.8;
  return 0.6; // site: 兜底
}

function pickExcerpt(item, tokens, grams, excerptChars) {
  const pool = [item.snippet, item.description, item.extra && item.extra.desc]
    .filter((value) => typeof value === 'string' && value.trim() !== '');
  if (pool.length === 0) return '';
  const sentences = pool.flatMap((value) => sentenceSplit(value));
  let best = '';
  let bestScore = 0;
  for (const sentence of sentences) {
    const score = tokenHits(sentence, tokens, grams);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  const chosen = best === '' ? sentences[0] || pool[0] : best;
  const clean = chosen.replace(/\s+/gu, ' ').trim();
  return clean.length > excerptChars ? `${clean.slice(0, excerptChars - 1)}…` : clean;
}

/**
 * 把一次搜索的原始结果压成「证据包」：评分 + 摘录 + 覆盖面 + 缺口，带字符预算。
 * 目的：给模型的不是 90 条标题，而是 10 条有理由、有引用、能追溯的东西。
 */
export function packEvidence(options = {}) {
  const query = String(options.query || '');
  const budgetChars = Math.min(20000, Math.max(800, Number(options.budgetChars) || EVIDENCE_DEFAULTS.budgetChars));
  const maxItems = Math.min(20, Math.max(1, Number(options.maxItems) || EVIDENCE_DEFAULTS.maxItems));
  const perPlatform = Math.min(8, Math.max(1, Number(options.perPlatform) || EVIDENCE_DEFAULTS.perPlatform));
  const excerptChars = Math.min(600, Math.max(80, Number(options.excerptChars) || EVIDENCE_DEFAULTS.excerptChars));

  const tokens = relevanceTokens(query);
  const grams = cjkGrams(query);
  const raw = Array.isArray(options.results) ? options.results : [];
  const total = raw.length;

  const seen = new Set();
  const scored = [];
  raw.forEach((item, index) => {
    if (!item || typeof item.url !== 'string' || item.url === '') return;
    const key = dedupeKey(item.url, item.title);
    if (seen.has(key)) return;
    seen.add(key);

    const titleHits = tokenHits(item.title || '', tokens, grams);
    const snippetHits = tokenHits(`${item.snippet || ''} ${(item.extra && item.extra.desc) || ''}`, tokens, grams);
    const positionScore = 1 - index / Math.max(1, total);
    const score =
      0.42 * Math.min(1, titleHits / Math.max(1, tokens.length || 1)) +
      0.22 * Math.min(1, snippetHits / Math.max(1, tokens.length || 1)) +
      0.16 * positionScore +
      0.12 * backendWeight(item) +
      0.08 * freshnessScore(item.extra);

    scored.push({ item, index, score, titleHits, snippetHits });
  });

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  const used = new Map();
  const items = [];
  const droppedByBudget = [];
  const droppedByPlatform = [];
  let usedChars = 0;

  for (const entry of scored) {
    const platform = entry.item.platform || '';
    const taken = used.get(platform) || 0;
    if (taken >= perPlatform) {
      droppedByPlatform.push(entry.item);
      continue;
    }
    if (items.length >= maxItems) {
      droppedByBudget.push(entry.item);
      continue;
    }
    const excerpt = pickExcerpt(entry.item, tokens, grams, excerptChars);
    const cost = (entry.item.title || '').length + (entry.item.url || '').length + excerpt.length + 48;
    if (usedChars + cost > budgetChars) {
      droppedByBudget.push(entry.item);
      continue;
    }
    usedChars += cost;
    used.set(platform, taken + 1);
    items.push({
      title: entry.item.title || entry.item.url,
      url: entry.item.url,
      platform,
      platformLabel: entry.item.platformLabel || platform,
      kind: entry.item.kind || 'article',
      score: Number(entry.score.toFixed(3)),
      excerpt,
      thumb: entry.item.thumb || '',
      embed: entry.item.embed || '',
      extra: entry.item.extra || undefined,
      why: [
        entry.titleHits > 0 ? '标题命中查询词' : '',
        entry.snippetHits > 0 ? '摘要命中查询词' : '',
        entry.index < 3 ? `原始排名第 ${entry.index + 1}` : '',
        backendWeight(entry.item) >= 1 ? '原生接口' : '',
      ].filter(Boolean).join(' · '),
    });
  }

  const coverage = [];
  const byPlatform = new Map();
  for (const item of raw) {
    const platform = item.platform || '';
    if (!byPlatform.has(platform)) byPlatform.set(platform, { platform, platformLabel: item.platformLabel || platform, kind: item.kind || 'article', count: 0 });
    byPlatform.get(platform).count += 1;
  }
  for (const value of byPlatform.values()) {
    coverage.push({ ...value, selected: used.get(value.platform) || 0 });
  }
  coverage.sort((left, right) => right.count - left.count);

  const selectedKinds = new Set(items.map((item) => item.kind));
  const gaps = [];
  for (const value of byPlatform.values()) {
    if (!selectedKinds.has(value.kind)) {
      gaps.push({ kind: value.kind, label: KIND_LABELS[value.kind] || value.kind, reason: `有 ${value.count} 条${KIND_LABELS[value.kind] || value.kind}结果未纳入（预算/配额）`, platform: value.platform });
    }
  }
  const platformNotes = (Array.isArray(options.platforms) ? options.platforms : [])
    .filter((entry) => entry && entry.status !== 'ok')
    .map((entry) => ({ id: entry.id, label: entry.label, status: entry.status, note: entry.note || '' }));

  return {
    query,
    generatedAt: new Date().toISOString(),
    budgetChars,
    usedChars,
    excerptChars,
    perPlatform,
    total,
    selected: items.length,
    items,
    coverage,
    gaps,
    platformNotes,
    dropped: {
      budget: droppedByBudget.length,
      perPlatform: droppedByPlatform.length,
      duplicates: total - scored.length,
    },
  };
}

/** 证据包的纯文本形态：给模型/输入框用，已按预算压好。 */
export function formatEvidence(pack, options = {}) {
  const title = String(options.title || '证据包');
  const lines = [];
  lines.push(`${title}｜查询：${pack.query === '' ? '（榜单/信息流）' : pack.query}`);
  lines.push(`来源 ${pack.coverage.length} 个平台 · 选中 ${pack.selected}/${pack.total} 条 · 预算 ${pack.usedChars}/${pack.budgetChars} 字`);
  lines.push('');
  pack.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   ${item.platformLabel} · ${KIND_LABELS[item.kind] || item.kind} · ${item.url}`);
    if (item.excerpt) lines.push(`   > ${item.excerpt}`);
    if (item.why) lines.push(`   依据：${item.why}`);
  });
  if (pack.gaps.length > 0) {
    lines.push('');
    lines.push(`缺口：${pack.gaps.map((gap) => `${gap.label}（${gap.reason}）`).join('；')}`);
  }
  if (pack.platformNotes.length > 0) {
    lines.push(`未纳入的平台：${pack.platformNotes.map((note) => `${note.label}（${note.status}${note.note ? `：${note.note}` : ''}）`).join('；')}`);
  }
  return lines.join('\n');
}

/** 跑一次搜索然后直接出证据包（给面板/MCP 用，缓存由调用方负责）。 */
export async function checkPlatforms(options = {}) {
  const timeoutMs = Math.min(20000, Math.max(2000, Number(options.timeoutMs) || 8000));
  const query = String(options.query || 'cordis').trim() || 'cordis';
  const deep = options.deep === true;
  const concurrency = Math.min(8, Math.max(1, Number(options.concurrency) || 4));

  const requestedRaw = Array.isArray(options.platforms) ? options.platforms.filter((id) => typeof id === 'string' && id !== '') : [];
  const explicitUnknown = requestedRaw.filter((id) => !PLATFORMS.has(id) && id !== 'auto' && id !== 'all');
  const requested = requestedRaw.length > 0
    ? resolvePlatforms(requestedRaw, options.defaultPlatforms || [], [])
    : Array.from(PLATFORMS.keys());

  const targets = [];
  const skipped = explicitUnknown.map((id) => ({ id, reason: 'unknown', note: '没有这个平台' }));
  for (const id of requested) {
    const def = PLATFORMS.get(id);
    if (!def) {
      if (!skipped.some((entry) => entry.id === id)) skipped.push({ id, reason: 'unknown', note: '没有这个平台' });
      continue;
    }
    const provider = providers.get(id);
    const native = Boolean((provider && typeof provider.search === 'function') || def.backend !== undefined || def.url !== undefined);
    if (!native) {
      if (def.site && !deep) {
        skipped.push({ id, label: def.label || def.zh || id, reason: 'site-fallback', note: '站内兜底，依赖 bing/so360' });
        continue;
      }
    }
    targets.push({ id, def, provider });
  }

  const cookies = options.cookies && typeof options.cookies === 'object' ? options.cookies : {};
  const client = createClient({ proxy: options.proxy, cookies, timeoutMs });

  const items = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const { id, def, provider } = targets[index];
      const label = def.label || def.zh || id;
      const started = Date.now();
      try {
        let rows = [];
        if (provider && typeof provider.search === 'function') {
          rows = await provider.search({ client, query, limit: 2, timeoutMs, page: 1, pages: 1 });
        } else if (def.backend !== undefined && BACKENDS[def.backend]) {
          rows = await BACKENDS[def.backend]({ client, query, limit: 2, timeoutMs, page: 1, pages: 1 });
        } else if (def.url !== undefined) {
          rows = await fetchCustom({ client, def, query, limit: 2, timeoutMs });
        }
        const ms = Date.now() - started;
        const list = Array.isArray(rows) ? rows : [];
        const usable = def.list === true ? list : keepRelevant(list, relevanceTokens(query), query);
        items.push({
          id,
          label,
          kind: def.kind || 'article',
          status: usable.length > 0 ? 'ok' : 'empty',
          ms,
          count: list.length,
          usable: usable.length,
          note: usable.length > 0 ? `${ms}ms` : `${ms}ms · 没返回可用结果`,
        });
      } catch (error) {
        const ms = Date.now() - started;
        const message = String((error && error.message) || error);
        const status = error && error.login === true ? 'login' : error instanceof EngineBlocked ? 'blocked' : 'error';
        items.push({
          id,
          label,
          kind: def.kind || 'article',
          status,
          ms,
          count: 0,
          usable: 0,
          note: status === 'login' ? `需要登录：${message}` : message.slice(0, 160),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));

  items.sort((left, right) => left.id.localeCompare(right.id));
  const tally = { ok: 0, empty: 0, blocked: 0, login: 0, error: 0 };
  for (const item of items) tally[item.status] = (tally[item.status] || 0) + 1;
  return {
    checkedAt: new Date().toISOString(),
    query,
    timeoutMs,
    total: items.length,
    ok: tally.ok,
    tally,
    items,
    skipped,
    healthy: tally.ok > 0,
  };
}

/** 体检结果的纯文本形态。 */
export function formatHealth(report) {
  const lines = [];
  const { tally } = report;
  lines.push(`连通性体检｜可用 ${tally.ok} · 空结果 ${tally.empty} · 被拦 ${tally.blocked} · 需登录 ${tally.login} · 出错 ${tally.error}`);
  lines.push('');
  const icon = (status) => (status === 'ok' ? '✓' : status === 'empty' ? '·' : status === 'blocked' ? '!' : status === 'login' ? '🔑' : '×');
  for (const item of report.items) {
    lines.push(`${icon(item.status)} ${item.label}（${item.id}）· ${item.status} · ${item.ms}ms${item.note && item.status !== 'ok' ? ` · ${item.note}` : ''}`);
  }
  if (report.skipped.length > 0) {
    lines.push('');
    lines.push(`跳过：${report.skipped.map((entry) => entry.label || entry.id).join('、')}（站内兜底，跟着 bing/360 走）`);
  }
  return lines.join('\n');
}

export function browserUrlFor(platformId, query) {
  const def = PLATFORMS.get(platformId);
  if (def && def.browser) return def.browser(query);
  return `https://www.bing.com/search?q=${enc(query)}`;
}


// ---------------------------------------------------------------- 查询规划 + 研究模式（v1.18）

const INTENT_LABELS = {
  code: '代码/报错',
  doc: '文档/API',
  academic: '论文/研究',
  news: '新闻/热榜',
  howto: '教程/怎么做',
  compare: '对比/选型',
  product: '商品/价格',
  general: '通用',
};

const INTENT_RULES = [
  { intent: 'code', pattern: /报错|异常|堆栈|崩溃|编译|语法|类型错误|空指针|undefined|nan|stack ?trace|exception|traceback|segfault|error|regex|正则|\bsql\b|\bsdk\b|cve-\d|漏洞/i },
  { intent: 'doc', pattern: /官方文档|文档|手册|说明书|参考|reference|manual|\bapi\b|参数说明|配置项|迁移指南|changelog|release notes/i },
  { intent: 'academic', pattern: /论文|文献|综述|研究|实验|数据集|arxiv|paper|survey|citation|引用量|benchmark/i },
  { intent: 'news', pattern: /新闻|最新|今天|昨天|本周|发布|官宣|公告|热搜|头条|榜单|排行|release|announce/i },
  { intent: 'howto', pattern: /怎么|如何|怎样|教程|入门|指南|步骤|手把手|how ?to|tutorial|guide|setup|install/i },
  { intent: 'compare', pattern: /对比|区别|差异|哪个好|优缺点|选型|\bvs\.?\b|versus|比较|替代/i },
  { intent: 'product', pattern: /价格|多少钱|购买|在哪买|测评|优惠|折扣|券|淘宝|京东|闲鱼|拼多多|开箱/i },
];

const INTENT_ROUTES = {
  code: ['github', 'stackoverflow', 'csdn', 'juejin', 'v2ex'],
  doc: ['github', 'stackoverflow', 'csdn', 'mdn', 'bing'],
  academic: ['wikipedia', 'stackexchange', 'zhihu', 'medium', 'bing'],
  news: ['toutiao', 'weibohot', 'baiduhot', 'toutiaohot', 'bing'],
  howto: ['zhihu', 'csdn', 'juejin', 'bilibili', 'bing'],
  compare: ['zhihu', 'v2ex', 'csdn', 'bing'],
  product: ['taobao', 'jd', 'zhihu', 'xianyu', 'bing'],
  general: ['bing', 'zhihu', 'csdn', 'juejin', 'v2ex', 'toutiao'],
};

const TERM_MAP = {
  插件: 'plugin',
  报错: 'error',
  错误: 'error',
  依赖: 'dependency',
  部署: 'deploy',
  缓存: 'cache',
  接口: 'api',
  文档: 'docs',
  性能: 'performance',
  并发: 'concurrency',
  数据库: 'database',
  测试: 'test',
  配置: 'config',
  安装: 'install',
  教程: 'tutorial',
  对比: 'vs',
  优化: 'optimization',
  内存: 'memory',
  线程: 'thread',
  异步: 'async',
  类型: 'type',
  编译: 'compile',
  打包: 'bundle',
  镜像: 'image',
  容器: 'container',
  权限: 'permission',
  登录: 'login',
  搜索: 'search',
  爬虫: 'crawler',
  正则: 'regex',
  函数: 'function',
  数组: 'array',
  对象: 'object',
  反射: 'reflection',
  源码: 'source code',
  框架: 'framework',
  组件: 'component',
  库: 'library',
  版本: 'version',
  升级: 'upgrade',
};

const CODE_TOKEN_PATTERN = /`([^`]{2,60})`|"([^"]{2,60})"|'([^']{2,60})'|(\b[A-Z][A-Z0-9_]{2,}\b|\b[a-z]+[A-Z][a-zA-Z0-9]+\b|\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z]{2,5}\b)/g;
const HOST_PATTERN = /\b((?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|ai|co|me|app|site|xyz|so|top))\b/i;

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** 中文技术词 → 英文，用来生成「换个说法再搜一次」的变体。 */
function latinVariant(query) {
  const parts = [];
  let rest = String(query);
  for (const [zh, en] of Object.entries(TERM_MAP)) {
    if (rest.includes(zh)) {
      parts.push(en);
      rest = rest.split(zh).join(' ');
    }
  }
  if (parts.length === 0) return '';
  const leftover = rest
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{Script=Latin}\p{Number}._-]/gu, ''))
    .filter((token) => token.length >= 2);
  const latin = [...parts, ...leftover].join(' ').replace(/\s+/g, ' ').trim();
  return /\p{Script=Latin}/u.test(latin) ? latin : '';
}

/** 从查询里抠出代码样式的 token（报错名、函数名、文件名），加引号提升命中率。 */
function quotedVariant(query) {
  CODE_TOKEN_PATTERN.lastIndex = 0;
  if (/[`"']/.test(query)) return '';
  let match = CODE_TOKEN_PATTERN.exec(query);
  while (match) {
    const token = (match[1] || match[2] || match[3] || match[4] || '').trim();
    const usable = token !== '' && token.length <= 60 && /[A-Za-z\u4e00-\u9fa5]/.test(token);
    const looksLikeHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|dev|ai|co|me|app|site|xyz|so|top)$/i.test(token);
    if (usable && !looksLikeHost) {
      return query.replace(token, `"${token}"`);
    }
    match = CODE_TOKEN_PATTERN.exec(query);
  }
  return '';
}

/** 查询里已经带了域名 → 生成 site: 变体，让搜索引擎直接限定站点。 */
function domainVariant(query) {
  const match = HOST_PATTERN.exec(query);
  if (!match) return '';
  const host = match[1].toLowerCase();
  const rest = query.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
  if (rest === '') return '';
  return `${rest} site:${host}`;
}

/**
 * 查询规划：判断意图、生成 1–4 个检索变体、挑出该去的平台。
 * 纯函数，不发请求；面板/工具/MCP 都用它决定「这次该问谁」。
 */
export function planQuery(options = {}) {
  const query = String(options.query || '').trim();
  const explicitInput = Array.isArray(options.platforms)
    ? options.platforms.filter((id) => typeof id === 'string' && id !== '' && id !== 'auto' && id !== 'all' && PLATFORMS.has(id))
    : [];
  const hintInput = Array.isArray(options.hints)
    ? options.hints.filter((id) => PLATFORMS.has(id))
    : inferPlatforms(query);

  const reasons = [];
  let intent = 'general';
  let confidence = 0.4;
  if (query !== '') {
    for (const rule of INTENT_RULES) {
      if (rule.pattern.test(query)) {
        intent = rule.intent;
        confidence = 0.72;
        reasons.push(`命中意图关键词：${INTENT_LABELS[rule.intent]}`);
        break;
      }
    }
  }
  if (intent === 'general' && query.length <= 12 && query !== '') {
    confidence = 0.5;
    reasons.push('查询很短，先按通用检索');
  }

  const variants = [];
  const push = (value, why) => {
    const text = String(value || '').trim();
    if (text === '' || text === query) return;
    if (variants.some((item) => item.text === text)) return;
    variants.push({ text, why });
  };
  if (query !== '') {
    const latin = latinVariant(query);
    if (latin !== '') push(latin, '中文技术词转英文术语');
    const scoped = domainVariant(query);
    if (scoped !== '') push(scoped, '限定到查询里的域名');
    const quoted = quotedVariant(query);
    if (quoted !== '') push(quoted, '代码/报错 token 加引号');
  }

  const route = INTENT_ROUTES[intent] || INTENT_ROUTES.general;
  const routed = route.filter((id) => PLATFORMS.has(id));
  const focusInput = [...hintInput, ...explicitInput];
  // 只点了榜单/信息流：不要往里面掺关键词引擎，否则空查询会把整波检索拖挂。
  const feedFocus = focusInput.length > 0 && focusInput.every((id) => {
    const def = PLATFORMS.get(id);
    return Boolean(def && def.list === true);
  });
  const platforms = [];
  for (const id of [...focusInput, ...(feedFocus ? [] : routed)]) {
    if (!platforms.includes(id) && PLATFORMS.has(id)) platforms.push(id);
  }
  if (hintInput.length > 0) reasons.push(`查询里点名了 ${hintInput.length} 个站点`);
  if (explicitInput.length > 0) reasons.push('调用方指定了平台');

  const maxPlatforms = clampNumber(options.maxPlatforms, 1, 10, 6);
  return {
    query,
    intent,
    intentLabel: INTENT_LABELS[intent] || INTENT_LABELS.general,
    confidence,
    reasons,
    variants: [{ text: query, why: '原始查询' }, ...variants].filter((item) => item.text !== ''),
    platforms: platforms.slice(0, maxPlatforms),
    explicit: explicitInput.length > 0,
    explicitPlatforms: explicitInput,
    hintPlatforms: hintInput,
    hints: hintInput,
  };
}

/** 把一次研究拆成最多 3 波：主平台 → 换说法再来一轮 → 剩余平台补漏。 */
export function planWaves(plan, options = {}) {
  const maxWaves = clampNumber(options.maxRounds, 1, 3, 3);
  const maxPlatforms = clampNumber(options.maxPlatforms, 1, 10, 6);
  const primary = plan.platforms.slice(0, 4);
  const rest = plan.platforms.slice(4, maxPlatforms);
  const waves = [];
  if (primary.length > 0) waves.push({ variant: plan.variants[0] ? plan.variants[0].text : plan.query, platforms: primary, why: '主平台' });
  if (plan.variants.length > 1) {
    waves.push({ variant: plan.variants[1].text, platforms: primary.slice(0, 3), why: plan.variants[1].why });
  }
  if (rest.length > 0) {
    waves.push({ variant: plan.variants[0] ? plan.variants[0].text : plan.query, platforms: rest, why: '补漏平台' });
  }
  return waves.slice(0, maxWaves);
}

/**
 * 研究模式：按规划分波检索 → 累积去重 → 每波结束评估「质量是否够用」→ 够了就停。
 * 与单次搜索的区别：会用不同措辞重试、按 intent 换平台、有时间预算与质量门槛。
 */
export async function research(options = {}) {
  const started = Date.now();
  const budgetMs = clampNumber(options.budgetMs, 3000, 60000, 12000);
  const maxRounds = clampNumber(options.maxRounds, 1, 3, 3);
  const minItems = clampNumber(options.minItems, 1, 20, 6);
  const quorumPlatforms = clampNumber(options.quorumPlatforms, 1, 8, 3);
  const quorumKinds = clampNumber(options.quorumKinds, 1, 6, 2);

  const plan = planQuery({
    query: options.query,
    platforms: options.platforms,
    hints: options.hints,
    maxPlatforms: options.maxPlatforms,
  });

  const focus = plan.hintPlatforms.length > 0 ? plan.hintPlatforms : plan.explicitPlatforms;
  const feedScope = focus.length > 0 ? focus : plan.platforms;
  const feedOnly = feedScope.length > 0 && feedScope.every((id) => {
    const def = PLATFORMS.get(id);
    return def && def.list === true;
  });
  if (plan.query === '' && !feedOnly) throw new Error('缺少查询词');

  const searchFn = options.deps && typeof options.deps.search === 'function' ? options.deps.search : runSearch;
  const waves = planWaves(plan, { maxRounds, maxPlatforms: options.maxPlatforms });
  const rounds = [];
  const collected = [];
  const seen = new Set();

  const evaluate = () => {
    const pack = packEvidence({
      query: plan.query || '热点榜单',
      results: collected,
      platforms: [],
      budgetChars: options.budgetChars,
      maxItems: options.maxItems,
      perPlatform: options.perPlatform,
      excerptChars: options.excerptChars,
    });
    const platformsHit = new Set(pack.items.map((item) => item.platform)).size;
    const kinds = new Set(pack.items.map((item) => item.kind)).size;
    const topScore = pack.items.reduce((max, item) => Math.max(max, Number(item.score) || 0), 0);
    const met = pack.items.length >= minItems && platformsHit >= quorumPlatforms && kinds >= quorumKinds;
    return { pack, platformsHit, kinds, topScore, met };
  };

  const platformNotes = [];
  let current = null;
  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index];
    const elapsed = Date.now() - started;
    const remaining = budgetMs - elapsed;
    if (index > 0 && remaining < 1500) {
      rounds.push({ round: index + 1, variant: wave.variant, platforms: wave.platforms, why: wave.why, took: 0, skipped: 'budget' });
      break;
    }
    const timeoutMs = Math.max(1500, Math.min(Number(options.timeoutMs) || 12000, remaining > 0 ? remaining : 3000));
    const t0 = Date.now();
    let search;
    try {
      search = await searchFn({
        query: wave.variant,
        platforms: wave.platforms,
        limit: options.limit,
        pages: options.pages,
        timeoutMs,
        proxy: options.proxy,
        cookies: options.cookies,
        defaultPlatforms: plan.platforms,
        maxPlatforms: wave.platforms.length,
      });
    } catch (error) {
      rounds.push({ round: index + 1, variant: wave.variant, platforms: wave.platforms, why: wave.why, took: Date.now() - t0, error: String((error && error.message) || error) });
      continue;
    }
    let added = 0;
    for (const item of (search && search.results) || []) {
      if (!item || typeof item.url !== 'string' || item.url === '') continue;
      const key = dedupeKey(item.url, item.title);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      added += 1;
    }
    for (const entry of (search && search.platforms) || []) {
      if (entry && entry.note && (entry.status === 'blocked' || entry.status === 'error')) platformNotes.push(`${entry.label || entry.id}：${entry.note}`);
    }
    current = evaluate();
    rounds.push({
      round: index + 1,
      variant: wave.variant,
      why: wave.why,
      platforms: wave.platforms,
      added,
      total: collected.length,
      platformsHit: current.platformsHit,
      kinds: current.kinds,
      topScore: Number(current.topScore.toFixed(3)),
      met: current.met,
      took: Date.now() - t0,
    });
    if (current.met) break;
  }

  const final = current || evaluate();
  const pack = final.pack;
  pack.platformNotes = [...new Set([...pack.platformNotes, ...platformNotes])].slice(0, 8);
  const took = Date.now() - started;
  const quality = {
    items: pack.items.length,
    selected: pack.selected,
    total: pack.total,
    platforms: final.platformsHit,
    kinds: final.kinds,
    topScore: Number(final.topScore.toFixed(3)),
    met: final.met,
    minItems,
    quorumPlatforms,
    quorumKinds,
  };
  const text = [
    formatEvidence(pack, { title: '研究报告' }).replace(/\n?$/, ''),
    '',
    `规划：${plan.intentLabel}（置信度 ${plan.confidence.toFixed(2)}）· 变体 ${plan.variants.length} 个 · 平台 ${plan.platforms.length} 个`,
    `检索：${rounds.length} 轮 / ${took}ms · 累积 ${collected.length} 条 · 入选 ${quality.items} 条 · 覆盖 ${quality.platforms} 平台 / ${quality.kinds} 类型`,
    `质量：${quality.met ? '达到门槛' : '未达门槛（结果可能不够，可放宽 minItems 或换平台）'}`,
  ].join('\n');

  return {
    query: plan.query,
    plan,
    rounds,
    pack,
    quality,
    met: quality.met,
    took,
    budgetMs,
    text,
  };
}
