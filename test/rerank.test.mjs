import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankLexical, queryTokens, applyRerank, loadRerankers, lexicalScore, RERANK_WEIGHTS } from '../rerank.js';

const items = [
  { title: 'Cordis 插件开发指南', url: 'https://example.com/a', snippet: '插件 生命周期', platform: 'csdn', score: 2 },
  { title: '随手记', url: 'https://example.com/cordis', snippet: '别的内容', platform: 'bing', score: 9 },
  { title: '插件市场', url: 'https://example.com/b', snippet: 'cordis 的插件', platform: 'zhihu', score: 1 },
];

test('queryTokens：中文 2 字滑窗 + 拉丁单词', () => {
  const tokens = queryTokens('cordis 插件开发');
  assert.ok(tokens.includes('cordis'));
  assert.ok(tokens.includes('插件'));
  assert.ok(tokens.includes('开发'));
});

test('lexical：标题命中排在只有原分数高的前面', () => {
  const ranked = rankLexical(items, 'cordis 插件');
  assert.equal(ranked[0].platform, 'csdn');
  assert.ok(ranked[0].rerankGain > ranked[2].rerankGain);
});

test('lexical：查询为空时按原分数稳定排序', () => {
  const ranked = rankLexical(items, '');
  assert.deepEqual(ranked.map((item) => item.platform), ['bing', 'csdn', 'zhihu']);
});

test('lexical：同分保持原顺序（稳定）', () => {
  const same = [
    { title: 'a', url: 'https://x/1', score: 1 },
    { title: 'b', url: 'https://x/2', score: 1 },
  ];
  assert.deepEqual(rankLexical(same, 'zzz').map((item) => item.url), ['https://x/1', 'https://x/2']);
});

test('lexicalScore：标题权重高于摘要', () => {
  const titleHit = lexicalScore({ title: 'cordis', snippet: '', url: 'https://x' }, 'cordis');
  const snippetHit = lexicalScore({ title: '别的', snippet: 'cordis', url: 'https://x' }, 'cordis');
  assert.ok(titleHit > snippetHit);
  assert.equal(RERANK_WEIGHTS.title > RERANK_WEIGHTS.snippet, true);
});

test('applyRerank：off 原样返回', async () => {
  const outcome = await applyRerank(items, { query: 'cordis', mode: 'off' });
  assert.equal(outcome.mode, 'off');
  assert.deepEqual(outcome.items.map((item) => item.url), items.map((item) => item.url));
});

test('applyRerank：未知外部 id 退回 lexical 并记错误', async () => {
  const outcome = await applyRerank(items, { query: 'cordis', mode: 'my-ranker', external: {} });
  assert.equal(outcome.used, 'lexical');
  assert.match(outcome.errors[0], /没有名为 my-ranker/);
});

test('applyRerank：外部重排器返回乱序就采用', async () => {
  const external = { reverse: { id: 'reverse', rank: (list) => list.slice().reverse() } };
  const outcome = await applyRerank(items, { query: 'cordis', mode: 'reverse', external });
  assert.equal(outcome.used, 'reverse');
  assert.equal(outcome.items[0].platform, 'zhihu');
});

test('applyRerank：外部重排器抛错时退回 lexical', async () => {
  const external = { boom: { id: 'boom', rank: () => { throw new Error('炸了'); } } };
  const outcome = await applyRerank(items, { query: 'cordis', mode: 'boom', external });
  assert.equal(outcome.used, 'lexical');
  assert.match(outcome.errors[0], /炸了/);
});

test('loadRerankers：加载好文件、坏文件只记错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ranker-'));
  fs.writeFileSync(path.join(dir, 'good.mjs'), "export default { id: 'length', label: '标题长度', rank: (list) => list.slice().sort((a, b) => a.title.length - b.title.length) };", 'utf8');
  fs.writeFileSync(path.join(dir, 'bad.mjs'), 'export default { id: "", rank: 1 };', 'utf8');
  const report = await loadRerankers({ dir });
  assert.deepEqual(report.loaded, ['length']);
  assert.equal(report.rankers.length.label, '标题长度');
  assert.equal(report.errors.length, 1);
});

test('loadRerankers：目录不存在时 skipped', async () => {
  const report = await loadRerankers({ dir: path.join(os.tmpdir(), 'ws-ranker-missing-' + Date.now()) });
  assert.equal(report.skipped, true);
  assert.deepEqual(report.loaded, []);
});