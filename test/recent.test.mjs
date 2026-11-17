import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutStore } from '../store.js';

function tempStore(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-recent-test-'));
  const file = path.join(dir, 'web-scout.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return { store: new ScoutStore(file), file };
}

const at = new Date().toISOString();

test('recent：保留顺序、去空白、平台最多 8 个', async () => {
  const { store } = tempStore({
    recent: [
      { q: '  宣传文案  ', platforms: ['bing', 'zhihu', 'csdn', 'github', 'juejin', 'v2ex', 'douban', 'npm', 'mdn', 'so360'], at },
      { q: 'cordis', platforms: 'nope', at },
    ],
  });
  await store.load();
  const list = store.get('recent');
  assert.equal(list[0].q, '宣传文案');
  assert.equal(list[0].platforms.length, 8);
  assert.deepEqual(list[1].platforms, []);
});

test('recent：缺 at 或 at 不是 ISO 的条目被丢', async () => {
  const { store } = tempStore({
    recent: [{ q: 'a', at: 'yesterday' }, { q: 'b' }, { q: 'c', at }, { q: '', at }],
  });
  await store.load();
  assert.deepEqual(store.get('recent').map((entry) => entry.q), ['c']);
});

test('recent：最多 20 条', async () => {
  const many = Array.from({ length: 40 }, (unused, index) => ({ q: 'q' + index, at }));
  const { store } = tempStore({ recent: many });
  await store.load();
  assert.equal(store.get('recent').length, 20);
  assert.equal(store.get('recent')[0].q, 'q0');
});

test('recent：非数组回空数组，不会把配置写坏', async () => {
  const { store } = tempStore({ recent: 'oops' });
  await store.load();
  assert.deepEqual(store.get('recent'), []);
});

test('recent：默认空数组且能落盘回读', async () => {
  const { store, file } = tempStore({});
  await store.load();
  assert.deepEqual(store.get('recent'), []);
  store.patch({ recent: [{ q: '写盘', platforms: ['bing'], at }] });
  await store.flush();
  const again = new ScoutStore(file);
  await again.load();
  assert.equal(again.get('recent')[0].q, '写盘');
});