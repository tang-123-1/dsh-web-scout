import test from 'node:test';
import assert from 'node:assert/strict';
import { pickQuotes, enrichQuotes, packEvidence, formatEvidence } from '../engines.js';

const latin = `Cookie policy. Accept all.
Home | Docs | Blog
Cordis is a plugin framework for DeepSeek Harness. It keeps the loader kernel small.
Nothing about the weather here.
The cordis plugin registry lists every plugin you can install.`;

test('英文：只挑真的含查询词的句子', () => {
  const out = pickQuotes(latin, 'cordis plugin');
  assert.equal(out.sentences.length >= 1, true);
  assert.match(out.quote, /cordis/i);
  assert.doesNotMatch(out.quote, /weather/);
});

test('中文：按 bigram 命中，不要求整句包含查询串', () => {
  const text = '今天天气不错。这个插件框架把插件加载器做得很小，插件之间互不干扰。无关的一句话。';
  const out = pickQuotes(text, '插件加载器');
  assert.ok(out.quote.includes('插件'));
  assert.ok(!out.quote.includes('天气'));
});

test('挑不到就返回空字符串，不编句子', () => {
  const out = pickQuotes('This page is about gardening and tomatoes.', 'cordis plugin');
  assert.equal(out.quote, '');
  assert.equal(out.sentences.length, 0);
});

test('导航与 cookie 条被当成噪声剔掉', () => {
  const out = pickQuotes('Cookie policy\n登录\n关于我们\ncordis 的插件市场收录所有插件。', 'cordis 插件');
  assert.ok(!/Cookie policy|关于我们/.test(out.quote));
  assert.ok(out.quote.includes('cordis'));
});

test('多句拼接有上限，且单句超长会截断并加省略号', () => {
  const long = `cordis ${'插件'.repeat(400)}`;
  const out = pickQuotes(`${long}\ncordis 第二句也命中查询词 ${'x'.repeat(200)}`, 'cordis', { chars: 120, maxSentences: 2 });
  assert.ok(out.quote.length <= 130, `quote=${out.quote.length}`);
  assert.match(out.quote, /…/);
});

test('同一句重复出现只算一次', () => {
  const line = 'cordis 插件框架很好用，加载器很小。';
  const out = pickQuotes(`${line}\n${line}\n${line}`, 'cordis', { maxSentences: 3 });
  assert.equal(out.sentences.length, 1);
});

test('enrichQuotes：只抓前 N 条、单条失败不影响其他条', async () => {
  const items = [
    { url: 'https://a.test/1' },
    { url: 'https://b.test/2' },
    { url: 'https://c.test/3' },
    { url: 'https://d.test/4' },
  ];
  const seen = [];
  const out = await enrichQuotes(items, {
    query: 'cordis',
    pages: 3,
    fetchPage: async (url) => {
      seen.push(url);
      if (url.includes('b.test')) throw new Error('HTTP 500');
      return { text: 'cordis 是一个插件框架，加载器内核很小。' };
    },
  });
  assert.equal(seen.length, 3);
  assert.equal(out.stats.withQuote, 2);
  assert.equal(out.stats.errors.length, 1);
  assert.match(out.stats.errors[0].reason, /HTTP 500/);
  assert.ok(items[0].quote.length > 0);
  assert.equal(items[3].quote, undefined);
});

test('enrichQuotes：非 http 与已有引文的条目跳过', async () => {
  const items = [{ url: 'file:///etc/passwd' }, { url: 'https://a.test/x', quote: '已有' }];
  const out = await enrichQuotes(items, { query: 'cordis', pages: 3, fetchPage: async () => ({ text: 'cordis' }) });
  assert.equal(out.stats.skipped, 1);
  assert.equal(out.stats.attempted, 0);
  assert.equal(items[1].quote, '已有');
});

test('证据包文本会带上原文引文', () => {
  const packed = packEvidence({
    query: 'cordis',
    results: [
      { title: 'cordis 插件框架', url: 'https://a.test/1', platform: 'bing', snippet: 'cordis 是一个插件框架' },
    ],
  });
  packed.items[0].quote = 'cordis 是一个插件框架，加载器内核很小。';
  const text = formatEvidence(packed);
  assert.match(text, /原文：「cordis/);
});