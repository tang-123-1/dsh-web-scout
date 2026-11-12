// Read the user's already-signed-in browser cookies from Chromium/Edge/Firefox-style
// profiles on this machine, so a search can reuse a real login instead of asking for
// a password. Windows-only key handling (DPAPI); everywhere else returns an empty set.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const BROWSERS = {
  edge: { roots: [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data')], label: 'Edge' },
  chrome: { roots: [path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')], label: 'Chrome' },
  brave: { roots: [path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data')], label: 'Brave' },
};

function chromeProfiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
    const candidates = [path.join(root, name, 'Network', 'Cookies'), path.join(root, name, 'Cookies')];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (file) out.push({ profile: name, file, root });
  }
  return out;
}

function readLocalStateKey(root) {
  const file = path.join(root, 'Local State');
  if (!fs.existsSync(file)) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const encoded = state && state.os_crypt && state.os_crypt.encrypted_key;
    if (typeof encoded !== 'string' || encoded === '') return undefined;
    const raw = Buffer.from(encoded, 'base64');
    const payload = raw.subarray(0, 5).toString() === 'DPAPI' ? raw.subarray(5) : raw;
    return unprotect(payload);
  } catch {
    return undefined;
  }
}

/** Windows DPAPI unprotect through PowerShell: no native addon needed. */
function unprotect(buffer) {
  if (process.platform !== 'win32') return undefined;
  const b64 = Buffer.from(buffer).toString('base64');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$bytes = [Convert]::FromBase64String($env:WS_DPAPI)',
    '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($plain))',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, WS_DPAPI: b64 },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    return Buffer.from(result.stdout.trim(), 'base64');
  } catch {
    return undefined;
  }
}

function decryptValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return '';
  const bytes = Buffer.from(encrypted);
  const prefix = bytes.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Legacy DPAPI blob (no AES layer).
    return unprotect(bytes)?.toString('utf8') || '';
  }
  if (!key || key.length !== 32) return '';
  const iv = bytes.subarray(3, 15);
  const tag = bytes.subarray(bytes.length - 16);
  const data = bytes.subarray(15, bytes.length - 16);
  try {
    const crypto = require('node:crypto');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function matchesDomain(hostKey, domain) {
  const host = String(hostKey || '').replace(/^\./, '').toLowerCase();
  const want = String(domain || '').replace(/^\./, '').toLowerCase();
  if (host === '' || want === '') return false;
  return host === want || host.endsWith(`.${want}`);
}

function firefoxProfiles() {
  const root = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles');
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, 'cookies.sqlite');
    if (fs.existsSync(file)) out.push({ profile: name, file });
  }
  return out;
}

function readFirefox(domain, result, DatabaseSync) {
  for (const profile of firefoxProfiles()) {
    let db;
    const temp = path.join(os.tmpdir(), `web-scout-ff-${Date.now()}.db`);
    try {
      fs.copyFileSync(profile.file, temp);
      db = new DatabaseSync(temp, { readOnly: true });
      const rows = db.prepare('SELECT host, name, value FROM moz_cookies').all();
      let count = 0;
      for (const row of rows) {
        if (!matchesDomain(row.host, domain) || !row.value) continue;
        const host = String(row.host).replace(/^\./, '');
        const pair = `${row.name}=${row.value}`;
        result.cookies[host] = result.cookies[host] ? `${result.cookies[host]}; ${pair}` : pair;
        count += 1;
      }
      if (count > 0) result.sources.push({ browser: 'firefox', label: 'Firefox', profile: profile.profile, count });
    } catch (error) {
      result.errors.push(`firefox/${profile.profile}: ${String((error && error.message) || error)}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(temp);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Collect cookies for `domain` out of every installed Chromium browser.
 * Returns `{cookies: {host: 'a=1; b=2'}, sources: [{browser, profile, count}], locked, errors}`.
 */
export function importBrowserCookies(domain) {
  const want = String(domain || '').trim();
  const result = { cookies: {}, sources: [], errors: [], locked: [] };
  if (want === '') return result;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    result.errors.push('当前运行时没有 node:sqlite，无法读取浏览器 cookie 库');
    return result;
  }

  for (const [id, entry] of Object.entries(BROWSERS)) {
    for (const root of entry.roots) {
      const key = readLocalStateKey(root);
      for (const profile of chromeProfiles(root)) {
        let db;
        const temp = path.join(os.tmpdir(), `web-scout-${id}-${profile.profile.replace(/\W+/g, '')}-${Date.now()}.db`);
        try {
          fs.copyFileSync(profile.file, temp);
          db = new DatabaseSync(temp, { readOnly: true });
          const rows = db.prepare('SELECT host_key, name, value, encrypted_value FROM cookies').all();
          let count = 0;
          for (const row of rows) {
            if (!matchesDomain(row.host_key, want)) continue;
            const value = row.value && row.value !== '' ? row.value : decryptValue(row.encrypted_value, key);
            if (!value) continue;
            const host = String(row.host_key).replace(/^\./, '');
            const pair = `${row.name}=${value}`;
            result.cookies[host] = result.cookies[host] ? `${result.cookies[host]}; ${pair}` : pair;
            count += 1;
          }
          if (count > 0) result.sources.push({ browser: id, label: entry.label, profile: profile.profile, count });
        } catch (error) {
          const code = String((error && error.code) || '');
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
            if (!result.locked.some((item) => item.browser === id)) {
              result.locked.push({ browser: id, label: entry.label });
            }
          } else {
            result.errors.push(`${id}/${profile.profile}: ${String((error && error.message) || error)}`);
          }
        } finally {
          try {
            db?.close();
          } catch {
            /* ignore */
          }
          try {
            fs.unlinkSync(temp);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  readFirefox(want, result, DatabaseSync);
  return result;
}

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