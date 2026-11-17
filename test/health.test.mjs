import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutStore } from '../store.js';

function tempStore(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-health-test-'));
  const file = path.join(dir, 'web-scout.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  const store = new ScoutStore(file);
  return { store, file, dir };
}

const at = new Date().toISOString();

test('health：坏状态被归一成 error，缺 at 的条目直接丢', async () => {
  const { store } = tempStore({
    health: {
      bing: [
        { at, status: 'ok', ms: 120 },
        { at, status: 'nonsense', ms: 30 },
        { status: 'ok', ms: 10 },
      ],
    },
  });
  await store.load();
  const list = store.get('health').bing;
  assert.equal(list.length, 2);
  assert.equal(list[1].status, 'error');
});

test('health：每平台只留最近 50 条', async () => {
  const many = Array.from({ length: 90 }, () => ({ at, status: 'ok', ms: 5 }));
  const { store } = tempStore({ health: { bing: many } });
  await store.load();
  assert.equal(store.get('health').bing.length, 50);
});

test('health：非数组与非法 id 被丢弃', async () => {
  const { store } = tempStore({ health: { bing: 'nope', x: [] } });
  await store.load();
  assert.deepEqual(store.get('health'), {});
});

test('health：ms 被夹到 0..60000 的整数', async () => {
  const { store } = tempStore({
    health: { bing: [{ at, status: 'ok', ms: -5 }, { at, status: 'ok', ms: 999999 }, { at, status: 'ok', ms: 12.7 }] },
  });
  await store.load();
  assert.deepEqual(store.get('health').bing.map((entry) => entry.ms), [0, 60000, 13]);
});

test('health：落盘后重新 load 仍在', async () => {
  const { store, file } = tempStore({});
  await store.load();
  store.patch({ health: { zhihu: [{ at, status: 'login', ms: 0 }] } });
  await store.flush();
  const again = new ScoutStore(file);
  await again.load();
  assert.equal(again.get('health').zhihu[0].status, 'login');
});