import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置文件版本：老文件没有 version 字段，读到时按 0 处理并迁移一次。 */
const STORE_VERSION = 2;

/** 自定义站点允许的展示类型，用来决定面板里渲染成卡片还是视频。 */
const CUSTOM_KINDS = new Set(['auto', 'video', 'article', 'qa', 'forum', 'hot', 'shop', 'code', 'doc', 'social', 'web']);

const DEFAULTS = {
  proxy: '',
  limit: 12,
  pages: 3,
  timeoutMs: 12000,
  maxPlatforms: 10,
  autoOpen: false,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  defaultPlatforms: ['bing', 'so360', 'csdn', 'juejin', 'toutiao', 'v2ex', 'zhihu', 'bilibili', 'weixin'],
  chips: ['auto', 'bing', 'zhihu', 'bilibili', 'douyin', 'douyinhot', 'csdn', 'juejin'],
  customPlatforms: [],
  cookies: {},
  accounts: {},
  hotSnapshot: {},
};

function configDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE ? [process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE)] : [];
  const base = process.env.DSH_PROFILE_DIR || profile[0] || home;
  return base;
}

function normalizeHotSnapshot(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, snap] of Object.entries(value)) {
    if (typeof id !== 'string' || id === '' || id.length > 40) continue;
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.rows)) continue;
    const rows = [];
    for (const row of snap.rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      const title = row[0].slice(0, 40);
      const rank = Number(row[1]);
      const hot = Number(row[2]);
      rows.push([title, Number.isFinite(rank) ? Math.max(1, Math.round(rank)) : 0, Number.isFinite(hot) ? Math.max(0, Math.round(hot)) : 0]);
      if (rows.length >= 60) break;
    }
    if (rows.length === 0) continue;
    const at = Number(snap.at);
    out[id] = { at: Number.isFinite(at) ? at : 0, rows };
    if (Object.keys(out).length >= 8) break;
  }
  return out;
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  if (typeof value.proxy === 'string') out.proxy = value.proxy.trim();
  const limit = Number(value.limit);
  if (Number.isFinite(limit)) out.limit = Math.min(20, Math.max(1, Math.round(limit)));
  const timeoutMs = Number(value.timeoutMs);
  if (Number.isFinite(timeoutMs)) out.timeoutMs = Math.min(30000, Math.max(3000, Math.round(timeoutMs)));
  const pages = Number(value.pages);
  if (Number.isFinite(pages)) out.pages = Math.min(4, Math.max(1, Math.round(pages)));
  const maxPlatforms = Number(value.maxPlatforms);
  if (Number.isFinite(maxPlatforms)) out.maxPlatforms = Math.min(14, Math.max(1, Math.round(maxPlatforms)));
  if (typeof value.autoOpen === 'boolean') out.autoOpen = value.autoOpen;
  const cacheTtlMs = Number(value.cacheTtlMs);
  if (Number.isFinite(cacheTtlMs)) {
    out.cacheTtlMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.round(cacheTtlMs)));
  }
  if (Array.isArray(value.defaultPlatforms) && value.defaultPlatforms.length > 0) {
    const list = value.defaultPlatforms.map((item) => String(item)).slice(0, 10);
    // v1.5 迁移：旧默认值是 4 个源，识别出来后升级成 6 个（加了头条 / V2EX）
    const legacySets = [
      ['bing', 'so360', 'csdn', 'juejin'],
      ['bing', 'so360', 'csdn', 'juejin', 'toutiao', 'v2ex'],
      ['bing', 'so360', 'csdn', 'juejin', 'toutiao', 'v2ex', 'zhihu', 'bilibili'],
    ];
    const isLegacy = legacySets.some((legacy) => list.length === legacy.length && list.every((item, index) => item === legacy[index]));
    out.defaultPlatforms = isLegacy ? [...DEFAULTS.defaultPlatforms] : list;
  }
  out.version = Number.isFinite(Number(value.version)) ? Math.max(0, Math.round(Number(value.version))) : 0;
  if (Array.isArray(value.chips)) out.chips = value.chips.map((item) => String(item)).slice(0, 12);
  if (Array.isArray(value.customPlatforms)) {
    out.customPlatforms = value.customPlatforms
      .filter((item) => item && typeof item === 'object' && String(item.name || '').trim() !== '' && String(item.url || '').trim() !== '')
      .slice(0, 24)
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        name: String(item.name).trim().slice(0, 40),
        url: String(item.url).trim().slice(0, 500),
        site: String(item.site || '').trim().slice(0, 120),
        kind: CUSTOM_KINDS.has(String(item.kind || 'auto')) ? String(item.kind || 'auto') : 'auto',
      }));
  }
  if (value.cookies && typeof value.cookies === 'object' && !Array.isArray(value.cookies)) {
    const cookies = {};
    for (const [host, cookie] of Object.entries(value.cookies)) {
      if (typeof cookie !== 'string' || cookie.trim() === '') continue;
      cookies[String(host).slice(0, 120)] = cookie.slice(0, 8000);
    }
    out.cookies = cookies;
  }
  if (value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts)) {
    const accounts = {};
    for (const [id, info] of Object.entries(value.accounts)) {
      if (!info || typeof info !== 'object') continue;
      accounts[String(id).slice(0, 60)] = {
        loggedIn: info.loggedIn === true,
        name: String(info.name || '').slice(0, 80),
        note: String(info.note || '').slice(0, 160),
        checkedAt: String(info.checkedAt || ''),
      };
    }
    out.accounts = accounts;
  }
  out.hotSnapshot = normalizeHotSnapshot(value.hotSnapshot);
    return out;
}

export class ScoutStore {
  constructor(file) {
    this.file = file || path.join(configDir(), 'web-scout.json');
    this.state = normalize(undefined);
    this.loaded = false;
    this.pending = undefined;
  }

  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.state = normalize(JSON.parse(text));
    } catch {
      this.state = normalize(undefined);
    }
    // v2 迁移：老配置文件只存过 limit/maxPlatforms 的旧默认值（6 或 8），一次性升到 v1.6 的新默认。
    if ((this.state.version || 0) < STORE_VERSION) {
      this.state = normalize({
        ...this.state,
        limit: DEFAULTS.limit,
        pages: DEFAULTS.pages,
        maxPlatforms: DEFAULTS.maxPlatforms,
        version: STORE_VERSION,
      });
    }
    this.loaded = true;
    if ((this.state.version || 0) >= STORE_VERSION) this.schedule();
    return this.state;
  }

  snapshot() {
    return { ...this.state };
  }

  get(key) {
    return this.state[key];
  }

  patch(patch) {
    this.state = normalize({ ...this.state, ...(patch || {}) });
    this.schedule();
    return this.snapshot();
  }

  schedule() {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.flush().catch(() => {});
    }, 250);
    if (typeof this.pending.unref === 'function') this.pending.unref();
  }

  async flush() {
    const dir = path.dirname(this.file);
    const body = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.file);
  }
}

export { DEFAULTS as SCOUT_DEFAULTS, configDir as scoutConfigDir };