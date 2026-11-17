import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRenderedRows, renderPlatformRows, PLATFORMS } from '../engines.js';
import { renderAvailable, renderStatus, renderHtml } from '../render.js';

const html = `<!doctype html><html><body>
<nav>
  <a href="/">首页</a>
  <a href="/login">登录</a>
  <a href="/register?from=web">注册账号</a>
</nav>
<div class="list">
  <a href="https://sspai.com/post/9001?utm_source=search">少数派编辑部的效率工具清单</a>
  <a href="https://sspai.com/post/9001?utm_source=search&from=web">少数派编辑部的效率工具清单（重复）</a>
  <a href="https://sspai.com/post/9002">用 Cordis 写一个插件：从零到上线</a>
  <a href="https://other.example.com/post/1">别站的文章不该进来</a>
  <a href="https://sspai.com/search/post">站内搜索页本身</a>
  <a href="https://sspai.com/post/9003">效率工具的另一份整理</a>
</div>
</body></html>`;

const def = { id: 'sspai', zh: '少数派', site: 'sspai.com', browser: (q) => `https://sspai.com/search/post/${encodeURIComponent(q)}` };

test('渲染结果只留站内链接，剔掉导航/登录/站内搜索页', () => {
  const out = extractRenderedRows(html, 'https://sspai.com/search/post/%E6%8F%92%E4%BB%B6', def, '效率工具 插件', 10);
  const urls = out.rows.map((row) => row.url);
  assert.equal(urls.some((url) => /\/login/.test(url)), false, '登录页不该出现');
  assert.equal(urls.some((url) => /\/register/.test(url)), false, '注册页不该出现');
  assert.equal(urls.some((url) => url.includes('/search/post')), false, '站内搜索页自己不该出现');
  assert.equal(urls.some((url) => url.includes('other.example.com')), false, '站外链接不该出现');
  assert.ok(out.rows.length >= 2, `至少要留下 2 条，实际 ${out.rows.length}`);
});

test('同一文章挂不同追踪参数只算一条', () => {
  const out = extractRenderedRows(html, 'https://sspai.com/search/post/x', def, '效率工具', 10);
  const hits = out.rows.filter((row) => row.url.includes('/post/9001'));
  assert.equal(hits.length, 1, `9001 应只出现一次，实际 ${hits.length}`);
});

test('相关结果不足时宁可为空，也不把导航链接当结果', () => {
  const out = extractRenderedRows(html, 'https://sspai.com/search/post/x', def, '完全无关的查询词 zzz', 10);
  assert.equal(out.rows.length, 0, `不该把导航/首页当结果，实际 ${out.rows.length}`);
});

test('落地地址与页面同路径时不会把自己当结果', () => {
  const pageUrl = 'https://sspai.com/post/9002';
  const out = extractRenderedRows(html, pageUrl, def, '插件', 10);
  assert.equal(out.rows.some((row) => row.url === pageUrl), false);
});

test('renderStatus 在不启动浏览器的情况下也能给出结构', async () => {
  const status = await renderStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(typeof status.running, 'boolean');
  // v1.26 自测发现：browserStatus() 是 async，同步包一层会永远拿到空 browser。
  if (status.available) assert.equal(typeof status.browser, 'string');
  if (status.available) assert.ok(status.browser.length > 0, '浏览器可用时应当报出可执行文件路径');
  assert.equal(typeof renderAvailable(), 'boolean');
});

test('没有站内搜索地址的平台直接报错，不静默返回空', async () => {
  await assert.rejects(() => renderPlatformRows({ id: 'x', zh: 'X' }, 'q'), /站内搜索地址/);
});

test('renderHtml 拒绝非 http 地址', async () => {
  await assert.rejects(() => renderHtml('file:///etc/passwd'), /http\(s\)/);
});

test('entryOnly 平台都在注册表里带 browser()', () => {
  const entry = [...PLATFORMS.values()].filter((item) => item.entryOnly === true);
  assert.ok(entry.length >= 10, `entryOnly 平台数量异常：${entry.length}`);
  for (const item of entry) assert.equal(typeof item.browser, 'function', `${item.id} 缺少 browser()`);
});