/**
 * 两级缓存：内存 LRU（毫秒级）+ SQLite（跨重启）。
 *
 * 为什么不用 Map 一把梭：
 * - 搜索/正文抓取有成本（有的站点还会风控），重启后应当还能命中；
 * - 但热点查询又该走内存，别每次都过一遍磁盘。
 *
 * SQLite 用 Node 内置的 node:sqlite，不引第三方依赖（插件是 host-only、零依赖 bundle）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { scoutConfigDir } from './store.js';

const DEFAULT_TTL = 6 * 60 * 60 * 1000; // 6 小时
const DEFAULT_MEMORY_ENTRIES = 240;

function hash(key) {
  return createHash('sha1').update(String(key)).digest('hex');
}

export class ScoutCache {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || DEFAULT_TTL;
    this.memoryMax = Math.max(16, Number(options.memoryMax) || DEFAULT_MEMORY_ENTRIES);
    this.dir = options.dir || scoutConfigDir();
    this.file = options.file || path.join(this.dir, 'web-scout-cache.db');
    this.memory = new Map();
    this.counters = { hits: 0, misses: 0, memoryHits: 0, writes: 0, expired: 0 };
    this.db = null;
    this.error = '';
    this.open();
  }

  open() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.db = new DatabaseSync(this.file);
      this.db.exec(
        'PRAGMA journal_mode = WAL;' +
          'CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS cache_exp ON cache (exp);',
      );
      this.purgeExpired();
    } catch (error) {
      // 缓存坏了不该让搜索失败：退化成一元内存缓存。
      this.db = null;
      this.error = String((error && error.message) || error);
    }
  }

  purgeExpired() {
    if (!this.db) return 0;
    try {
      const stmt = this.db.prepare('DELETE FROM cache WHERE exp <= ?');
      const info = stmt.run(Date.now());
      const removed = Number(info && info.changes) || 0;
      if (removed > 0) this.counters.expired += removed;
      return removed;
    } catch {
      return 0;
    }
  }

  rememberMemory(id, entry) {
    if (this.memory.has(id)) this.memory.delete(id);
    this.memory.set(id, entry);
    while (this.memory.size > this.memoryMax) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }

  get(key) {
    const id = hash(key);
    const now = Date.now();
    const cached = this.memory.get(id);
    if (cached) {
      if (cached.exp > now) {
        this.counters.hits += 1;
        this.counters.memoryHits += 1;
        this.rememberMemory(id, cached);
        return { value: cached.value, at: cached.at, ageMs: now - cached.at, source: 'memory' };
      }
      this.memory.delete(id);
      this.counters.expired += 1;
    }
    if (!this.db) {
      this.counters.misses += 1;
      return undefined;
    }
    try {
      const row = this.db.prepare('SELECT v, at, exp FROM cache WHERE k = ?').get(id);
      if (!row) {
        this.counters.misses += 1;
        return undefined;
      }
      if (Number(row.exp) <= now) {
        this.db.prepare('DELETE FROM cache WHERE k = ?').run(id);
        this.counters.expired += 1;
        this.counters.misses += 1;
        return undefined;
      }
      const value = JSON.parse(String(row.v));
      this.counters.hits += 1;
      this.rememberMemory(id, { value, at: Number(row.at), exp: Number(row.exp) });
      return { value, at: Number(row.at), ageMs: now - Number(row.at), source: 'sqlite' };
    } catch {
      this.counters.misses += 1;
      return undefined;
    }
  }

  set(key, value, ttlMs) {
    const id = hash(key);
    const now = Date.now();
    const ttl = Math.max(1000, Number(ttlMs) || this.ttlMs);
    const exp = now + ttl;
    this.rememberMemory(id, { value, at: now, exp });
    this.counters.writes += 1;
    if (!this.db) return;
    try {
      this.db
        .prepare('INSERT INTO cache (k, v, at, exp) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at, exp = excluded.exp')
        .run(id, JSON.stringify(value), now, exp);
    } catch {
      // 写失败只影响跨重启复用，内存里已经有了。
    }
  }

  /** 命中就返回，没命中就执行 loader 并写回。 */
  async wrap(key, loader, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit.value, cached: true, ageMs: hit.ageMs, source: hit.source };
    const value = await loader();
    this.set(key, value, ttlMs);
    return { value, cached: false, ageMs: 0, source: 'fresh' };
  }

  stats() {
    let rows = 0;
    let bytes = 0;
    if (this.db) {
      try {
        const row = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(v)), 0) AS b FROM cache').get();
        rows = Number(row && row.n) || 0;
        bytes = Number(row && row.b) || 0;
      } catch {
        // ignore
      }
    }
    return {
      ...this.counters,
      memory: this.memory.size,
      rows,
      bytes,
      file: this.file,
      ttlMs: this.ttlMs,
      persistent: Boolean(this.db),
      error: this.error,
    };
  }

  clear() {
    this.memory.clear();
    if (this.db) {
      try {
        this.db.exec('DELETE FROM cache');
      } catch {
        // ignore
      }
    }
    this.counters = { hits: 0, misses: 0, memoryHits: 0, writes: 0, expired: 0 };
    return this.stats();
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      // ignore
    }
    this.db = null;
  }
}

export function createCache(options = {}) {
  return new ScoutCache(options);
}