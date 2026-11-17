/**
 * 平台熔断（v1.31）
 *
 * 体检历史（`health`）已经记了每个平台每次的成败，这里只做一件事：
 * 连续失败到阈值就先别打它了——既省时间，也免得被对方当成扫描。
 *
 * 规则：
 *   - 只看最近 `threshold` 条；全部是失败（error/timeout/blocked）才算跳闸。
 *   - 冷却期（默认 30 分钟）过了一半开：允许再试一次，试成功历史里就有 ok，自动恢复。
 *   - `empty`（站点正常但没结果）与 `login`（要登录）不算失败——它们不是「平台坏了」。
 *   - 体检记录为空、字段不合法、时间解析不了，一律不跳闸：宁可多打一次，不要凭空屏蔽平台。
 */

export const BREAKER_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;
export const FAILURE_STATUS = new Set(['error', 'timeout', 'blocked']);

export function recentFailures(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && FAILURE_STATUS.has(String(entry.status || '')));
}

export function breakerState(entries, options = {}) {
  const threshold = Math.max(1, Number(options.threshold) || BREAKER_THRESHOLD);
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || BREAKER_COOLDOWN_MS);
  const now = Number(options.now) || Date.now();
  const list = Array.isArray(entries) ? entries : [];
  if (list.length < threshold) return { tripped: false, fails: 0, reason: '' };
  const tail = list.slice(-threshold);
  if (!tail.every((entry) => entry && FAILURE_STATUS.has(String(entry.status || '')))) {
    return { tripped: false, fails: 0, reason: '' };
  }
  const newest = Date.parse(String(tail[tail.length - 1].at || ''));
  if (!Number.isFinite(newest)) return { tripped: false, fails: 0, reason: '' };
  const age = now - newest;
  if (age >= cooldownMs) {
    return { tripped: false, fails: threshold, reason: 'half-open', dueMs: 0 };
  }
  return {
    tripped: true,
    fails: threshold,
    reason: '连续 ' + threshold + ' 次失败',
    retryInMs: Math.max(0, cooldownMs - age),
  };
}

/** 一次算出所有平台的跳闸情况：`{id: state}`，只回跳闸的那些。 */
export function trippedPlatforms(health, options = {}) {
  const out = {};
  if (!health || typeof health !== 'object') return out;
  for (const [id, entries] of Object.entries(health)) {
    const state = breakerState(entries, options);
    if (state.tripped) out[id] = state;
  }
  return out;
}