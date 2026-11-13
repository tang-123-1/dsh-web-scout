// 合并两份 cookie 映射（{host: 'a=1; b=2'}），同名以 extra 为准。
/** Merge two cookie maps (`{host: 'a=1; b=2'}`), later values winning per name. */
export function mergeCookies(base, extra) {
  const out = {};
  for (const source of [base, extra]) {
    for (const [host, value] of Object.entries(source || {})) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const pairs = new Map();
      for (const part of `${out[host] || ''}; ${value}`.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        pairs.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
      }
      out[host] = [...pairs].map(([name, val]) => `${name}=${val}`).join('; ');
    }
  }
  return out;
}