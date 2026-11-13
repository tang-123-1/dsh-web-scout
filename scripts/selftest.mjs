// web-scout 自测套件：把 api.js 的每个 op 都真打一遍，全部断言走真实网络/真实 store。
// 用法：node scripts/selftest.mjs [--heavy]（需要 Harness 正在运行）
//   --heavy 会额外触发 open（拉起系统浏览器）与 login.browser（拉起插件浏览器）
// 退出码 0 表示全部通过。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3209/web-scout/api';
const heavy = process.argv.includes('--heavy');
const results = [];
let pass = 0;
let fail = 0;

const call = async (op, payload = {}) => {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ op, ...payload }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op}: response not JSON (${text.slice(0, 80)})`);
  }
  return { status: res.status, json };
};

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? '  [' + detail + ']' : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? '  [' + detail + ']' : ''}`);
  }
};

const data = async (op, payload) => {
  const { json } = await call(op, payload);
  if (!json.ok) throw new Error(`${op}: ${json.error && json.error.message}`);
  return json.data;
};

const expectError = async (op, payload, needle) => {
  const { json } = await call(op, payload);
  const message = json.ok ? '' : String(json.error && json.error.message);
  return { ok: json.ok === false && (needle === undefined || message.includes(needle)), message };
};

// ---------- A. 目录与配置 ----------
console.log('\n== A. catalog / config / chips ==');
const catalog = await data('catalog');
check('catalog 平台数 ≥40', catalog.platforms.length >= 40, `n=${catalog.platforms.length}`);
check('catalog 带 chips', Array.isArray(catalog.chips) && catalog.chips.length > 0, JSON.stringify(catalog.chips));
check('catalog 带 config.cacheTtlMs', Number(catalog.config.cacheTtlMs) > 0, `ttl=${catalog.config.cacheTtlMs}`);
check('catalog 平台有 label/kind', catalog.platforms.every((item) => item.label && item.kind), `sample=${catalog.platforms[0].label}/${catalog.platforms[0].kind}`);

const configBefore = await data('config', {});
const patched = await data('config', { patch: { limit: 9, pages: 2 } });
check('config 写入生效', Number(patched.limit) === 9 && Number(patched.pages) === 2, `limit=${patched.limit} pages=${patched.pages}`);
await data('config', { patch: { limit: configBefore.limit, pages: configBefore.pages } });
const configAfter = await data('config', {});
check('config 还原', Number(configAfter.limit) === Number(configBefore.limit), `limit=${configAfter.limit}`);

const chipsBefore = catalog.chips;
const chipsSet = await data('chips', { chips: ['auto', 'bing', 'v2ex'] });
check('chips 写入', JSON.stringify(chipsSet.chips) === JSON.stringify(['auto', 'bing', 'v2ex']), JSON.stringify(chipsSet.chips));
await data('chips', { chips: chipsBefore });
const chipsBack = await data('catalog');
check('chips 还原', JSON.stringify(chipsBack.chips) === JSON.stringify(chipsBefore));

// ---------- B. 自定义站点 ----------
console.log('\n== B. platform.add / remove ==');
const added = await data('platform.add', {
  name: '自测站点',
  url: 'https://www.bing.com/search?q={q}',
  site: 'bing.com',
  kind: 'web',
});
const custom = added.platforms.find((item) => item.id === 'custom:自测站点');
check('platform.add 出现在 catalog', Boolean(custom), custom ? `kind=${custom.kind} source=${custom.source}` : 'missing');
check('自定义站点 kind 生效', custom ? custom.kind === 'web' : false, custom ? custom.kind : '');

const customSearch = await data('search', { query: 'cordis', platforms: ['custom:自测站点'], limit: 3 });
check('自定义站点可搜索', ['ok', 'empty'].includes(customSearch.platforms[0].status), `${customSearch.platforms[0].status}/${customSearch.platforms[0].count}`);

const removed = await data('platform.remove', { id: 'custom:自测站点' });
check('platform.remove 生效', !removed.platforms.some((item) => item.id === 'custom:自测站点'));

// ---------- C. 搜索 ----------
console.log('\n== C. search ==');
const search = await data('search', { query: '龙珠 孙悟空', platforms: ['bing', 'v2ex', 'csdn'], limit: 5, pages: 1, refresh: true });
check('search 多平台', search.platforms.length === 3, search.platforms.map((p) => `${p.id}:${p.status}`).join(' '));
check('search 有结果', search.results.length > 0, `n=${search.results.length}`);
check('search 结果字段完整', search.results.every((item) => item.title && item.url && item.platform), '');
check('search 未命中缓存', search.cached === false, `cached=${search.cached}`);

const searchCached = await data('search', { query: '龙珠 孙悟空', platforms: ['bing', 'v2ex', 'csdn'], limit: 5, pages: 1 });
check('search 二次命中缓存', searchCached.cached === true && searchCached.cacheAgeMs >= 0, `age=${searchCached.cacheAgeMs}`);

const feed = await data('search', { platforms: ['weibohot'], limit: 4 });
check('榜单空查询可用', feed.query === '' && feed.results.length > 0, `n=${feed.results.length}`);

const emptyErr = await expectError('search', { query: '', platforms: ['bing'] });
check('关键词引擎空查询报错', emptyErr.ok, emptyErr.message.slice(0, 30));

const opErr = await expectError('not-an-op', {});
check('未知 op 报错', opErr.ok, opErr.message.slice(0, 30));

// ---------- D. 读取 ----------
console.log('\n== D. read ==');
const page = await data('read', { url: 'https://cn.bing.com/', maxChars: 3000 });
check('read 抓到正文', page.chars > 0 && page.text.length > 0, `chars=${page.chars} status=${page.status}`);
check('read 带回 links', Array.isArray(page.links), `links=${(page.links || []).length}`);
const pageCached = await data('read', { url: 'https://cn.bing.com/', maxChars: 3000 });
check('read 二次命中缓存', pageCached.cached === true, `age=${pageCached.cacheAgeMs}`);
const readErr = await expectError('read', { url: 'ftp://example.com' });
check('read 拒绝非 http', readErr.ok, readErr.message.slice(0, 30));

// ---------- E. 证据包 ----------
console.log('\n== E. evidence ==');
const evidence = await data('evidence', { query: 'cordis 插件', platforms: ['bing', 'csdn', 'v2ex'], budgetChars: 1500, maxItems: 5, perPlatform: 2, refresh: true });
check('evidence 有 items', evidence.items.length > 0, `n=${evidence.items.length}`);
check('evidence 预算内', evidence.usedChars <= 1500, `used=${evidence.usedChars}`);
check('evidence 每平台配额', evidence.coverage.every((item) => item.selected <= 2), JSON.stringify(evidence.coverage.map((c) => c.selected)));
check('evidence 有摘录与依据', evidence.items.every((item) => item.excerpt && item.why), '');
check('evidence 文本格式', typeof evidence.text === 'string' && evidence.text.includes('证据包'), evidence.text.split('\n')[0].slice(0, 40));

// ---------- F. 规划与研究 ----------
console.log('\n== F. plan / research ==');
const plan = await data('plan', { query: 'cordis 插件报错 403' });
check('plan 意图 code', plan.intent === 'code', `${plan.intent}/${plan.intentLabel}`);
check('plan 变体 ≥1', plan.variants.length >= 1, JSON.stringify(plan.variants.map((v) => v.text)));
check('plan 波次 ≥1', plan.waves.length >= 1, `waves=${plan.waves.length}`);

const research = await data('research', { query: 'cordis 插件', platforms: ['bing', 'csdn', 'v2ex', 'github'], budgetMs: 12000, maxRounds: 2, minItems: 4, refresh: true });
check('research 至少一轮', research.rounds.length >= 1, `rounds=${research.rounds.length}`);
check('research 有质量门槛', typeof research.quality.met === 'boolean', JSON.stringify(research.quality));
check('research 文本是报告', research.text.includes('研究报告'), research.text.split('\n')[0].slice(0, 40));

// ---------- G. 体检 ----------
console.log('\n== G. health.check ==');
const health = await data('health.check', { platforms: ['bing', 'v2ex'], query: 'cordis', timeoutMs: 9000 });
check('health 有 items', health.items.length === 2, `n=${health.items.length}`);
check('health 可判可用', health.ok >= 1, `ok=${health.ok}`);
check('health 文本', health.text.includes('连通性体检'), health.text.split('\n')[0].slice(0, 40));

// ---------- H. 缓存管理 ----------
console.log('\n== H. cache ==');
const stats = await data('cache.stats', {});
check('cache.stats 有行数', stats.rows > 0, `rows=${stats.rows} hits=${stats.hits}`);
await data('cache.clear', {});
const stats2 = await data('cache.stats', {});
check('cache.clear 清空', stats2.rows === 0, `rows=${stats2.rows}`);

// ---------- I. provider ----------
console.log('\n== I. providers ==');
const providers = await data('provider.list', {});
check('provider.list 数量', providers.providers.length >= 40, `n=${providers.providers.length} platforms=${providers.platforms}`);
check('provider.list 带 dir', typeof providers.dir === 'string', providers.dir);
const reloaded = await data('provider.reload', {});
check('provider.reload 幂等', reloaded.providers.length === providers.providers.length, `n=${reloaded.providers.length}`);

// ---------- J. graph ----------
const graph = await data('graph', {});
check('graph 已合成客户端', graph.composed === true && graph.has === true, `rev=${graph.rev}`);

// ---------- K. 登录 ----------
console.log('\n== K. login ==');
const loginStatus = await data('login.status', {});
check('login.status 有 accounts', typeof loginStatus.accounts === 'object', JSON.stringify(loginStatus.accounts).slice(0, 80));
const paste = await data('login.paste', { platform: 'v2ex', cookie: 'A2=selftest-cookie' });
check('login.paste 写入并判定', paste.loggedIn === true, `${paste.note}`);
const checkAfter = await data('login.check', { platform: 'v2ex' });
check('login.check 读到 cookie', Number(checkAfter.cookies) > 0, `cookies=${checkAfter.cookies}`);
const cleared = await data('login.clear', { platform: 'v2ex' });
check('login.clear 清空', cleared.loggedIn === false || cleared.cookies === 0, `${cleared.note}`);

// ---------- K. 凭据脱敏（catalog/config 不得回原始 cookie 值）----------
console.log('\n== K. redaction ==');
{
  const cat = await data('catalog', {});
  const config = cat.config || {};
  const raw = JSON.stringify(config);
  const looksLikeCookieValue = /[A-Za-z0-9_]+=[^;"]*\|\d+:\d+:/.test(raw) || /SESSIONID=[^;"]{8,}/.test(raw);
  check('catalog 不含原始 cookie 值', !looksLikeCookieValue, raw.slice(0, 40));
  check('catalog 有 cookieHosts 计数', Object.prototype.hasOwnProperty.call(config, 'cookieHosts'), JSON.stringify(config.cookieHosts || {}).slice(0, 60));
  const cookiesLeaked = Object.prototype.hasOwnProperty.call(config, 'cookies');
  check('catalog 没有 cookies 原始字段', cookiesLeaked === false, String(cookiesLeaked));
  const patched = await data('config', { patch: { limit: Number(config.limit) || 12 } });
  check('config 补丁同样脱敏', !JSON.stringify(patched).includes('SESSIONID='), '');
}

// ---------- L. 插件浏览器 ----------
console.log('\n== L. browser ==');
const browserBefore = await data('browser.status', {});
check('browser.status 可用', typeof browserBefore.running === 'boolean', `running=${browserBefore.running}`);
const closed = await data('browser.close', {});
check('browser.close 无会话时安全', closed.closed === false || closed.closed === true, JSON.stringify(closed).slice(0, 80));

// ---------- M. 重活（可选） ----------
if (heavy) {
  console.log('\n== M. heavy (open / plugin browser) ==');
  const opened = await data('open', { url: 'https://cn.bing.com/search?q=web-scout+selftest' });
  check('open 拉起系统浏览器', Boolean(opened.command), String(opened.command).slice(0, 60));
  const launched = await data('login.browser', { platform: 'v2ex' });
  check('login.browser 启动插件浏览器', Number(launched.port) > 0, `port=${launched.port} reused=${launched.reused}`);
  const live = await data('browser.status', {});
  check('browser.status 反映运行中', live.running === true, `port=${live.port}`);
  const stopped = await data('browser.close', {});
  check('browser.close 关掉浏览器', stopped.closed === true, JSON.stringify(stopped).slice(0, 80));
}

const report = { at: new Date().toISOString(), pass, fail, total: pass + fail, results };
fs.writeFileSync('selftest-report.json', JSON.stringify(report, null, 2), 'utf8');
console.log(`\n===== ${pass}/${pass + fail} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);