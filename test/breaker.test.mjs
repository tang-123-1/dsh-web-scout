import test from 'node:test';
import assert from 'node:assert/strict';
import { breakerState, trippedPlatforms, BREAKER_THRESHOLD, FAILURE_STATUS } from '../breaker.js';

const now = Date.parse('2026-11-17T10:00:00.000Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const bad = (minutesAgo, status = 'error') => ({ at: at(minutesAgo), status, ms: 0 });
const ok = (minutesAgo) => ({ at: at(minutesAgo), status: 'ok', ms: 200 });

test('连续三次失败才跳闸', () => {
  assert.equal(breakerState([bad(5), bad(4)], { now }).tripped, false);
  assert.equal(breakerState([bad(5), bad(4), bad(3)], { now }).tripped, true);
});

test('中间只要有一次成功就不跳闸', () => {
  const state = breakerState([bad(5), ok(4), bad(3)], { now });
  assert.equal(state.tripped, false);
});

test('empty / login 不算失败', () => {
  assert.equal(FAILURE_STATUS.has('empty'), false);
  assert.equal(FAILURE_STATUS.has('login'), false);
  const state = breakerState([bad(5, 'empty'), bad(4, 'login'), bad(3, 'timeout')], { now });
  assert.equal(state.tripped, false);
});

test('冷却期满以前一直跳闸，并给出剩余时间', () => {
  const state = breakerState([bad(5), bad(4), bad(3)], { now, cooldownMs: 30 * 60000 });
  assert.equal(state.tripped, true);
  assert.equal(state.retryInMs, 27 * 60000);
});

test('冷却期满后进入 half-open（允许再试一次）', () => {
  const state = breakerState([bad(45), bad(40), bad(35)], { now, cooldownMs: 30 * 60000 });
  assert.equal(state.tripped, false);
  assert.equal(state.reason, 'half-open');
});

test('时间解析不了就不跳闸', () => {
  const state = breakerState([{ at: 'x', status: 'error' }, { at: 'y', status: 'error' }, { at: 'z', status: 'error' }], { now });
  assert.equal(state.tripped, false);
});

test('trippedPlatforms 只回跳闸的平台', () => {
  const health = {
    bing: [bad(5), bad(4), bad(3)],
    zhihu: [bad(5), ok(2)],
    csdn: [bad(9), bad(8), bad(7)],
  };
  const trips = trippedPlatforms(health, { now });
  assert.deepEqual(Object.keys(trips).sort(), ['bing', 'csdn']);
});

test('阈值可配置；非对象/空值安全', () => {
  const health = { bing: [bad(5), bad(4)] };
  assert.deepEqual(trippedPlatforms(health, { now, threshold: 2 }), { bing: { tripped: true, fails: 2, reason: '连续 2 次失败', retryInMs: 26 * 60000 } });
  assert.deepEqual(trippedPlatforms(null, { now }), {});
  assert.equal(BREAKER_THRESHOLD, 3);
});