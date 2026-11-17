import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BACKENDS, isRedirectorUrl, isJunkResult } from '../engines.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const fixtureJson = (name) => JSON.parse(fixture(name));

/**
 * 假 client：按 URL 子串挑夹具，HTML 走 request()、JSON 走 json()。
 * 解析器只跟这段文本打交道，所以夹具就是解析契约的回归锁。
 */
function fakeClient({ html = {}, json = {} } = {}) {
  return {
    async request(url) {
      const key = Object.keys(html).find((needle) => url.includes(needle));
      if (key === undefined) throw new Error(`no html fixture for ${url}`);
      return { status: 200, url, headers: {}, text: html[key] };
    },
    async json(url) {
      const key = Object.keys(json).find((needle) => url.includes(needle));
      if (key === undefined) throw new Error(`no json fixture for ${url}`);
      return { status: 200, url, headers: {}, data: json[key] };
    },
  };
}

const base = { query: 'cordis 插件', limit: 5, timeoutMs: 5000, pages: 1, page: 1 };

test('bing: 解析 b_algo，且丢掉 bing 自己的链接', async () => {
  const rows = await BACKENDS.bing({ ...base, client: fakeClient({ html: { 'bing.com/search': fixture('bing.html') } }) });
  assert.equal(rows.length, 2);
  assert.match(rows[0].title, /cordis/i);
  assert.ok(!/bing\.com/.test(rows[0].url), 'bing 自站链接必须被过滤');
  assert.match(rows[1].snippet, /cordis/);
});

test('so360: 桌面验证码时自动换 m.so.com，并过滤 360 自己的推荐位', async () => {
  const client = fakeClient({
    html: {
      'www.so.com/s': '<html><title>请输入验证码</title><body>captcha</body></html>',
      'm.so.com/s': fixture('so360-mobile.html'),
    },
  });
  const rows = await BACKENDS.so360({ ...base, client });
  assert.equal(rows.length, 2, '360 推荐位应被丢弃');
  assert.equal(rows[0].url, 'https://github.com/cordisjs/cordis');
  assert.equal(rows[1].url, 'https://zhuanlan.zhihu.com/p/123456');
  assert.ok(rows.every((row) => !/so\.com/.test(row.url)));
});

test('baidu: 优先用容器上的 mu 真实地址，缺 mu 时保留中转壳', async () => {
  const rows = await BACKENDS.baidu({ ...base, client: fakeClient({ html: { 'baidu.com/s': fixture('baidu.html') } }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://baike.baidu.com/item/cordis/12345');
  assert.equal(rows[1].url, 'http://www.baidu.com/link?url=def456');
  assert.equal(isRedirectorUrl(rows[1].url), true);
});

test('toutiao: 从 script[type=application/json] 里取 SSR 结果', async () => {
  const rows = await BACKENDS.toutiao({ ...base, client: fakeClient({ html: { 'so.toutiao.com': fixture('toutiao.html') } }) });
  assert.equal(rows.length, 2);
  assert.match(rows[0].title, /cordis/);
  assert.match(rows[0].url, /^https:\/\/toutiao\.com\/group\/77/);
  assert.equal(rows[1].url, 'https://toutiao.com/group/7706789686521512449/');
});

test('weixin: 解析 txt-box，链接补全域名并标记 shell', async () => {
  const rows = await BACKENDS.weixin({ ...base, client: fakeClient({ html: { 'weixin.sogou.com': fixture('weixin.html') } }) });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].url.startsWith('https://weixin.sogou.com/link?url='));
  assert.equal(rows[0].extra.shell, true);
  assert.equal(rows[0].extra.account, '工具人日记');
});

test('csdn: 解析 result_vos，去掉 url 上的追踪参数与 <em>', async () => {
  const rows = await BACKENDS.csdn({ ...base, client: fakeClient({ json: { 'so.csdn.net': fixtureJson('csdn.json') } }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'cordis 插件开发实践');
  assert.equal(rows[0].url, 'https://blog.csdn.net/aaa/article/details/123456');
  assert.equal(rows[1].snippet, '46 个平台、两级缓存、一个 MCP 服务。');
});

test('juejin: 解析 result_model.article_info 并拼出文章地址', async () => {
  const rows = await BACKENDS.juejin({ ...base, client: fakeClient({ json: { 'api.juejin.cn': fixtureJson('juejin.json') } }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://juejin.cn/post/7000000000000000001');
  assert.match(rows[1].title, /DSH/);
});

test('v2ex: 解析 sov2ex hits 并拼出帖子地址', async () => {
  const rows = await BACKENDS.v2ex({ ...base, client: fakeClient({ json: { 'sov2ex.com': fixtureJson('v2ex.json') } }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://www.v2ex.com/t/698540');
  assert.match(rows[1].snippet, /cordis/);
});

test('douban: 解析 subject_suggest 并把封面强制成 https', async () => {
  const rows = await BACKENDS.douban({ ...base, client: fakeClient({ json: { 'subject_suggest': fixtureJson('douban.json') } }) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '龙珠');
  assert.ok(rows[0].thumb.startsWith('https://'));
  assert.match(rows[0].snippet, /1986/);
});

test('npm: 两个 registry 并发，先成功的生效', async () => {
  const rows = await BACKENDS.npm({
    ...base,
    client: {
      async json(url) {
        if (url.includes('registry.npmjs.org')) throw new Error('ETIMEDOUT');
        return { status: 200, headers: {}, url, data: fixtureJson('npm.json') };
      },
    },
  });
  assert.equal(rows.length, 2);
  assert.match(rows[1].title, /^dsh-web-scout@1\.23\.0$/);
});

test('空壳判定：没有信息的结果才算垃圾，中转壳不算', () => {
  assert.equal(isJunkResult({ title: '', url: 'https://x.com/a' }, 'cordis'), true);
  assert.equal(isJunkResult({ title: 'cordis', url: 'https://x.com/a' }, 'cordis'), true);
  assert.equal(isJunkResult({ title: 'https://www.baidu.com/s?wd=cordis', url: 'https://www.baidu.com/s?wd=cordis' }, 'cordis'), true);
  assert.equal(isJunkResult({ title: '真标题', url: 'https://www.baidu.com/link?url=1' }, 'cordis'), false);
});