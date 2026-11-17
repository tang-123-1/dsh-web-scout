// Minimal dependency-free HTTP client: redirects, cookies, gzip/br/deflate, optional HTTP proxy (CONNECT for https).
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_JSON = 'application/json,text/plain,*/*';

function normalizeProxy(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === '') return undefined;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const auth =
    url.username || url.password
      ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
      : undefined;
  return { host: url.hostname, port, auth };
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

class CookieJar {
  constructor(initial) {
    this.store = new Map();
    if (initial && typeof initial === 'object') {
      for (const [host, value] of Object.entries(initial)) {
        if (typeof value === 'string' && value.trim() !== '') this.store.set(host, value.trim());
      }
    }
  }

  absorb(host, setCookie) {
    if (!Array.isArray(setCookie) || setCookie.length === 0) return;
    const pairs = new Map();
    const existing = this.store.get(host);
    if (existing) {
      for (const part of existing.split(';')) {
        const idx = part.indexOf('=');
        if (idx > 0) pairs.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
      }
    }
    for (const line of setCookie) {
      const head = String(line).split(';')[0];
      const idx = head.indexOf('=');
      if (idx <= 0) continue;
      pairs.set(head.slice(0, idx).trim(), head.slice(idx + 1).trim());
    }
    this.store.set(host, [...pairs].map(([k, v]) => `${k}=${v}`).join('; '));
  }

  header(host) {
    if (this.store.size === 0) return undefined;
    const parts = [];
    const bases = [host];
    const dot = host.indexOf('.');
    if (dot > 0) bases.push(host.slice(dot + 1));
    for (const base of bases) {
      const value = this.store.get(base);
      if (value) parts.push(value);
    }
    return parts.length > 0 ? [...new Set(parts.join('; ').split('; '))].join('; ') : undefined;
  }
}

// ---------------------------------------------------------------------------
// low level request
// ---------------------------------------------------------------------------

function connectTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        host: `${host}:${port}`,
        ...(proxy.auth ? { 'proxy-authorization': `Basic ${proxy.auth}` } : {}),
      },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('proxy connect timeout'));
    }, timeoutMs);
    req.once('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function collect(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    res.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        const over = size - maxBytes;
        chunks.push(over >= chunk.length ? Buffer.alloc(0) : chunk.subarray(0, chunk.length - over));
        finish(Buffer.concat(chunks));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(Buffer.concat(chunks)));
    res.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (buffer.length === 0) return buffer;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
    if (enc.includes('zstd') && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buffer);
    }
  } catch {
    return buffer;
  }
  return buffer;
}

function charsetOf(buffer, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buffer.subarray(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1].toLowerCase();
  return 'utf-8';
}

function decodeBody(buffer, contentType) {
  const charset = charsetOf(buffer, contentType);
  const normalized =
    charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030' ? 'gbk' : charset === 'utf8' ? 'utf-8' : charset;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

export function createClient(options = {}) {
  const jar = new CookieJar(options.cookies);
  const proxy = normalizeProxy(options.proxy);
  const defaultTimeout = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const defaultLanguage = typeof options.language === "string" && options.language !== "" ? options.language : "zh-CN,zh;q=0.9,en;q=0.8";

  async function once(target, init) {
    const url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const headers = {
      'user-agent': init.userAgent || DEFAULT_UA,
      'accept-language': init.language || defaultLanguage,
      accept: init.accept || ACCEPT_HTML,
      'accept-encoding': 'gzip, deflate, br',
      ...(init.headers || {}),
    };
    const cookie = init.noCookies === true ? '' : jar.header(url.hostname);
    if (cookie) headers.cookie = cookie;
    if (init.referer) headers.referer = init.referer;
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    if (body) headers['content-length'] = String(body.length);
    const path = `${url.pathname}${url.search}`;
    const timeout = init.timeoutMs > 0 ? init.timeoutMs : defaultTimeout;

    let req;
    if (proxy && isHttps) {
      const socket = await connectTunnel(proxy, url.hostname, Number(url.port) || 443, timeout);
      const secure = tls.connect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
      });
      req = https.request({
        host: url.hostname,
        port: Number(url.port) || 443,
        path,
        method: init.method || 'GET',
        headers,
        agent: false,
        createConnection: () => secure,
      });
    } else if (proxy) {
      req = http.request({
        host: proxy.host,
        port: proxy.port,
        path: url.toString(),
        method: init.method || 'GET',
        headers: { ...headers, host: url.host },
        ...(proxy.auth ? { headers: { ...headers, host: url.host, 'proxy-authorization': `Basic ${proxy.auth}` } } : {}),
      });
    } else {
      const mod = isHttps ? https : http;
      req = mod.request({
        host: url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path,
        method: init.method || 'GET',
        headers,
        agent: false,
        ...(isHttps ? { servername: url.hostname } : {}),
      });
    }

    const killer = setTimeout(() => {
      req.destroy(new Error(`timeout after ${timeout}ms`));
    }, timeout);
    const pending = new Promise((resolve, reject) => {
      req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
      req.once('response', (res) => {
        const maxBytes = init.maxBytes > 0 ? init.maxBytes : 4_000_000;
        collect(res, maxBytes).then(
          (buffer) => {
            const text = decodeBody(decompress(buffer, res.headers['content-encoding']), res.headers['content-type']);
            resolve({ status: res.statusCode || 0, headers: res.headers, text, url });
          },
          reject,
        );
      });
      req.once('error', reject);
    });
    if (body) req.write(body);
    req.end();
    return pending.finally(() => clearTimeout(killer));
  }

  async function request(target, init = {}) {
    let current = target;
    const maxRedirects = Number.isInteger(init.redirects) ? init.redirects : 5;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await once(current, init);
      jar.absorb(res.url.hostname, res.headers['set-cookie']);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
        current = new URL(location, res.url).toString();
        continue;
      }
      return { ...res, finalUrl: res.url.toString() };
    }
    throw new Error('too many redirects');
  }

  async function json(target, init = {}) {
    const res = await request(target, { ...init, accept: ACCEPT_JSON });
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      data = undefined;
    }
    return { ...res, data };
  }

  return { request, json, jar, proxy };
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  times: '×',
  deg: '°',
  euro: '€',
  yen: '¥',
  pound: '£',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hairsp: ' ',
  zwnj: '',
  zwj: '',
  shy: '',
  bull: '•',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  harr: '↔',
  le: '≤',
  ge: '≥',
  ne: '≠',
  infin: '∞',
};

export function decodeEntities(input) {
  return String(input || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      if (Number.isFinite(value) && value > 0 && value <= 0x10ffff) {
        try {
          return String.fromCodePoint(value);
        } catch {
          return match;
        }
      }
      return match;
    }
    const mapped = ENTITIES[code] ?? ENTITIES[code.toLowerCase()];
    return mapped === undefined ? match : mapped;
  });
}

export function stripTags(input) {
  let out = String(input || '').replace(/<[^>]*>/g, ' ');
  // 搜索引擎常把摘要多重转义（&amp;amp;ensp;），一次不干净就再解，最多 3 轮。
  for (let round = 0; round < 3; round += 1) {
    const decoded = decodeEntities(out);
    if (decoded === out) break;
    out = decoded;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function absolutize(href, base) {
  const raw = decodeEntities(String(href || '').trim());
  if (raw === '') return '';
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function htmlToText(html, options = {}) {
  let text = String(html || '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|canvas|form)\b[\s\S]*?<\/\1>/gi, ' ');
  if (options.scoped !== true) {
    const main = /<article\b[\s\S]*?<\/article>/i.exec(text) || /<main\b[\s\S]*?<\/main>/i.exec(text);
    if (main && main[0].length > 400) text = main[0];
  }
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = stripTags(text.replace(/\n{3,}/g, '\n\n'));
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return match ? stripTags(match[1]) : '';
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
// ---- 输出净化：Harness 的工具返回值必须是「无损 JSON」---------------------
// 引擎抓到的行里常有 undefined 字段、NaN 分数、Date/Map 之类，direct 返回给
// Host 时会被判 invalid output: value is not lossless JSON。这里统一洗成纯数据。
export function plain(value, depth = 0) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return String(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (depth > 12) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = plain(item, depth + 1);
      return next === undefined ? null : next;
    });
  }
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value) {
      const next = plain(item, depth + 1);
      if (next !== undefined) out[String(key)] = next;
    }
    return out;
  }
  if (value instanceof Set) return [...value].map((item) => plain(item, depth + 1) ?? null);
  if (typeof value.toJSON === 'function') return plain(value.toJSON(), depth + 1);
  const out = {};
  for (const key of Object.keys(value)) {
    const next = plain(value[key], depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}
