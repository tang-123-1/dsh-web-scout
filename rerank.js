/**
 * 可插拔重排（v1.30）
 *
 * 默认 `lexical`：在引擎给出的相关度分数之上，再看「查询词落在标题/摘要/地址里几次」。
 * 引擎侧的分数来自各平台自己的排序，跨平台并不可比（知乎第一条和必应第一条不是一个尺度），
 * 所以在合并多个平台之后按词命中重排一次，比直接按原分数排更接近人的直觉。
 *
 * 外部重排器目录：`<DSH profile>/web-scout-rerankers/*.mjs`
 *
 *   export default {
 *     id: 'length',
 *     label: '按标题长度',
 *     rank(items, { query }) {
 *       return items.slice().sort((a, b) => String(a.title).length - String(b.title).length);
 *     },
 *   };
 *
 * 约定与 provider 一致：加载失败、字段不合法只进 errors，不影响检索本身；
 * 每次加载带 `?v=<时间戳>`，改完文件 `rerank.reload` 即生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 128 * 1024;

export const RERANK_MODES = ['off', 'lexical'];

export const RERANK_WEIGHTS = { title: 3, snippet: 1, url: 0.5, exact: 4, head: 2 };

export function rerankDir(configDir) {
  const base = configDir || process.env.DSH_PROFILE_DIR || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop');
  return path.join(base, 'web-scout-rerankers');
}

/** 查询词切成小写片段：中文按 2 字滑窗，其余按单词。 */
export function queryTokens(query) {
  const text = String(query || '').toLowerCase().trim();
  if (text === '') return [];
  const tokens = new Set();
  const latin = text.match(/[a-z0-9][a-z0-9+#._-]{1,}/g) || [];
  for (const word of latin) tokens.add(word);
  const cjk = text.replace(/[^\u4e00-\u9fff]+/g, ' ').trim();
  for (const group of cjk.split(/\s+/)) {
    if (group.length === 1) tokens.add(group);
    for (let index = 0; index + 2 <= group.length; index += 1) tokens.add(group.slice(index, index + 2));
  }
  return Array.from(tokens);
}

function countHits(haystack, tokens) {
  const text = String(haystack || '').toLowerCase();
  if (text === '') return 0;
  let hits = 0;
  for (const token of tokens) {
    if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token)) continue;
    if (text.includes(token)) hits += 1;
  }
  return hits;
}

/** 单条打分：词命中为主，原分数只做同分时的次序，避免「平台自嗨」压过相关性。 */
export function lexicalScore(item, query, tokens, weights = RERANK_WEIGHTS) {
  const list = tokens || queryTokens(query);
  if (list.length === 0) return Number(item.score) || 0;
  const title = countHits(item.title, list) * weights.title;
  const snippet = countHits(item.snippet, list) * weights.snippet;
  const url = countHits(item.url, list) * weights.url;
  const head = countHits(String(item.title || '').slice(0, 24), list) * weights.head;
  const phrase = String(item.title || '').toLowerCase().includes(String(query || '').toLowerCase().trim()) ? weights.exact : 0;
  const base = Math.min(3, Math.max(0, Number(item.score) || 0) / 10);
  return title + snippet + url + head + phrase + base;
}

export function rankLexical(items, query, options = {}) {
  const tokens = queryTokens(query);
  const weights = { ...RERANK_WEIGHTS, ...(options.weights || {}) };
  return items
    .map((item, index) => ({ item, index, gain: lexicalScore(item, query, tokens, weights) }))
    .sort((a, b) => (b.gain - a.gain) || (a.index - b.index))
    .map((entry) => ({ ...entry.item, rerankGain: Math.round(entry.gain * 100) / 100 }));
}

export async function loadRerankers({ dir } = {}) {
  const directory = dir || rerankDir();
  const report = { dir: directory, loaded: [], errors: [], skipped: false, rankers: {} };
  if (!fs.existsSync(directory)) {
    report.skipped = true;
    return report;
  }
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => /\.(mjs|js)$/i.test(name)).sort().slice(0, MAX_FILES);
  } catch (error) {
    report.errors.push({ file: directory, message: '目录读不了：' + error.message });
    return report;
  }
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        report.errors.push({ file: name, message: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB` });
        continue;
      }
      const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
      const exported = mod.default || mod.reranker || mod.rankers;
      const list = Array.isArray(exported) ? exported : exported ? [exported] : [];
      if (list.length === 0) {
        report.errors.push({ file: name, message: '没有导出 default / reranker' });
        continue;
      }
      for (const raw of list) {
        const id = raw && typeof raw.id === 'string' ? raw.id.trim().slice(0, 40) : '';
        if (id === '' || typeof raw.rank !== 'function') {
          report.errors.push({ file: name, message: '需要 id 与 rank(items, ctx) 函数' });
          continue;
        }
        report.rankers[id] = { id, label: typeof raw.label === 'string' ? raw.label : id, rank: raw.rank, file: name };
        report.loaded.push(id);
      }
    } catch (error) {
      report.errors.push({ file: name, message: '加载失败：' + error.message });
    }
  }
  return report;
}

/**
 * 统一入口。mode：`off` | `lexical` | （宿主注入的）外部重排器 id。
 * 外部重排器抛错或返回非数组时退回 lexical，并在 stats 里写明原因。
 */
export async function applyRerank(items, { query, mode = 'lexical', external = null, weights } = {}) {
  const list = Array.isArray(items) ? items : [];
  const wanted = String(mode || 'lexical');
  if (wanted === 'off' || list.length < 2) return { items: list, mode: 'off', used: '', moved: 0, errors: [] };
  if (external && external[wanted] && typeof external[wanted].rank === 'function') {
    try {
      const ranked = await external[wanted].rank(list.slice(), { query });
      if (Array.isArray(ranked) && ranked.length === list.length) {
        const before = list.map((item) => item.url).join('|');
        const after = ranked.map((item) => item.url).join('|');
        return { items: ranked, mode: wanted, used: wanted, moved: before === after ? 0 : 1, errors: [] };
      }
      return { items: rankLexical(list, query, { weights }), mode: 'lexical', used: 'lexical', moved: 1, errors: ['外部重排器返回的不是等长数组，已退回 lexical'] };
    } catch (error) {
      return { items: rankLexical(list, query, { weights }), mode: 'lexical', used: 'lexical', moved: 1, errors: ['外部重排器失败：' + error.message] };
    }
  }
  const ranked = rankLexical(list, query, { weights });
  const moved = ranked.filter((item, index) => item.url !== list[index].url).length;
  return { items: ranked, mode: 'lexical', used: 'lexical', moved, errors: wanted === 'lexical' ? [] : [`没有名为 ${wanted} 的外部重排器，已用 lexical`] };
}