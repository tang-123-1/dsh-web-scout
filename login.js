// Login state for platforms the search can borrow a session from.
// The plugin owns a dedicated browser profile (browserAuth.js) or accepts pasted cookies;
// either way the cookies land in the plugin's own jar and are verified here.
import { createClient, hostOf } from './net.js';
import { PLATFORMS, loginUrlFor, cookieDomainFor } from './engines.js';

const PROBES = {
  bilibili: {
    url: 'https://api.bilibili.com/x/web-interface/nav',
    require: ['SESSDATA'],
    read: (json) => ({
      loggedIn: Boolean(json && json.data && json.data.isLogin === true),
      name: (json && json.data && (json.data.uname || '')) || '',
      detail: json && json.data && json.data.isLogin ? `等级 LV${json.data.level_info?.current_level ?? '-'}` : 'SESSDATA 未生效',
    }),
  },
  zhihu: {
    url: 'https://www.zhihu.com/api/v4/me',
    // 知乎 v4 接口要 x-zse 签名，未登录/签名缺失都会回 AuthenticationInvalidRequest，
    // 所以登录态以 z_c0（登录后才有的授权 cookie）为准，接口只用来取昵称。
    require: ['z_c0'],
    read: (json) => ({
      loggedIn: Boolean(json && (json.name || json.id || json.url_token)),
      name: (json && (json.name || json.url_token)) || '',
      detail: json && json.error ? String(json.error.message || json.error) : '',
    }),
  },
  github: {
    url: 'https://api.github.com/user',
    require: ['user_session', 'logged_in'],
    read: (json) => ({
      loggedIn: Boolean(json && json.login),
      name: (json && (json.login || json.name)) || '',
      detail: json && json.message ? String(json.message) : '',
    }),
  },
};

function cookiePairs(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='));
}

/** Which configured cookie buckets belong to a platform's domain. */
export function cookiesForDomain(cookies, domain) {
  const want = String(domain || '').replace(/^\./, '').toLowerCase();
  if (want === '') return '';
  const parts = [];
  for (const [host, value] of Object.entries(cookies || {})) {
    const clean = String(host).replace(/^\./, '').toLowerCase();
    if (clean === want || clean.endsWith(`.${want}`)) parts.push(String(value || ''));
  }
  return parts.filter(Boolean).join('; ');
}

export function loginTarget(platformId) {
  const def = PLATFORMS.get(String(platformId || ''));
  if (!def) return undefined;
  return {
    id: def.id,
    label: def.zh,
    url: loginUrlFor(def.id),
    domain: cookieDomainFor(def.id),
    probe: PROBES[def.id] ? true : false,
  };
}

/**
 * Verify the stored cookies for one platform.
 * `require` lists the cookies that only exist after a real sign-in, so a cookie
 * that the site issues to anonymous visitors can never be mistaken for a login.
 */
export async function checkLogin({ platform, cookies, proxy, timeoutMs = 10000 }) {
  const target = loginTarget(platform);
  if (!target) throw new Error(`未知平台：${platform}`);
  const header = cookiesForDomain(cookies, target.domain);
  const names = cookiePairs(header).map((pair) => pair.slice(0, pair.indexOf('=')));
  const base = {
    platform: target.id,
    label: target.label,
    domain: target.domain,
    cookies: cookiePairs(header).length,
    names: names.slice(0, 12),
    checkedAt: new Date().toISOString(),
  };
  if (cookiePairs(header).length === 0) {
    return { ...base, loggedIn: false, name: '', note: '还没有导入登录状态' };
  }
  const probe = PROBES[target.id];
  const require = probe && Array.isArray(probe.require) ? probe.require : [];
  const marked = require.filter((name) => names.includes(name));
  if (require.length > 0 && marked.length === 0) {
    return {
      ...base,
      loggedIn: false,
      name: '',
      note: `Cookie 里没有 ${require.join('/')}：浏览器里还是未登录状态`,
    };
  }
  if (!probe) {
    return { ...base, loggedIn: true, name: '', note: '已导入 Cookie（该站点无校验接口，按存在判定）' };
  }
  const viaCookie = marked.length > 0 ? `，按 ${marked.join('/')} 判定` : '';
  const client = createClient({ proxy, cookies: { [target.domain]: header }, timeoutMs });
  try {
    const res = await client.json(probe.url, {
      headers: { referer: `https://${target.domain}/`, accept: 'application/json' },
      timeoutMs,
    });
    const verdict = probe.read(res.data);
    if (verdict.loggedIn) {
      return { ...base, loggedIn: true, name: verdict.name || '', note: `登录有效${viaCookie}` };
    }
    if (marked.length > 0) {
      return {
        ...base,
        loggedIn: true,
        name: '',
        note: `已登录（${marked.join('/')} 存在；接口未返回昵称：${verdict.detail || '无需签名接口'}）`,
      };
    }
    return {
      ...base,
      loggedIn: false,
      name: '',
      note: `Cookie 已导入但未通过校验：${verdict.detail || '会话过期'}`,
    };
  } catch (error) {
    const message = String((error && error.message) || error);
    if (marked.length > 0) {
      return { ...base, loggedIn: true, name: '', note: `已登录（${marked.join('/')} 存在；校验请求失败：${message}）` };
    }
    return { ...base, loggedIn: false, name: '', note: `校验请求失败：${message}` };
  }
}

/** Parse a pasted `document.cookie`-style string into a `{host: 'a=1; b=2'}` map. */
export function cookieMapFromPaste(platformId, raw) {
  const target = loginTarget(platformId);
  if (!target) throw new Error(`未知平台：${platformId}`);
  const value = String(raw || '').trim();
  if (value === '') throw new Error('Cookie 为空');
  const host = hostOf(`https://${target.domain}`) || target.domain;
  return { [host]: value };
}