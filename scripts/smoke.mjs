#!/usr/bin/env node
/**
 * web-scout 冒烟测试：不启动 DeepSeek Harness，直接调用插件里的检索引擎。
 *
 *   node scripts/smoke.mjs                      # 默认查询「龙珠」，跑默认平台
 *   node scripts/smoke.mjs "cordis 插件"         # 指定关键词
 *   node scripts/smoke.mjs 龙珠 bing,csdn,v2ex   # 指定关键词 + 平台
 *
 * 退出码：0 = 至少一个平台返回结果；1 = 全部失败（通常是没有网络或需要代理）。
 */
import { runSearch, platformCatalog, inferPlatforms, cleanQuery } from '../engines.js';

const args = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const query = args[0] || '龙珠';
const platforms = args[1] || 'auto';

const catalog = platformCatalog();
const inferred = inferPlatforms(query);

console.log(`平台总数：${catalog.length}`);
console.log(`查询：${JSON.stringify(query)}  清洗后：${JSON.stringify(cleanQuery(query))}`);
if (inferred.length) console.log(`识别出的站点：${inferred.join(', ')}`);
console.log(`平台参数：${platforms}\n`);

const started = Date.now();
const base = (process.env.WEB_SCOUT_SMOKE_PLATFORMS || 'bing,so360,csdn,juejin,toutiao,v2ex')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const data = await runSearch({ query, platforms, defaultPlatforms: base, limit: 8, pages: 2, timeoutMs: 15000 });
const cost = Date.now() - started;

for (const platform of data.platforms) {
  const flag = platform.status === 'ok' ? '✓' : platform.status === 'empty' ? '·' : '✗';
  console.log(
    `${flag} ${platform.label.padEnd(6)} ${String(platform.status).padEnd(8)} ${String(platform.count).padStart(2)} 条` +
      `${platform.note ? `  (${platform.note})` : ''}`,
  );
}

console.log(`\n合计 ${data.results.length} 条，用时 ${cost} ms` + (data.tunnelSuggested ? '（部分站点需要代理）' : ''));

for (const [index, row] of data.results.slice(0, 6).entries()) {
  console.log(`\n${index + 1}. [${row.platformLabel}] ${row.title}`);
  console.log(`   ${row.url}`);
  if (row.snippet) console.log(`   ${row.snippet.slice(0, 90)}`);
}

const ok = data.platforms.filter((platform) => platform.status === 'ok').length;
console.log(`\n结果：${ok} 个平台可用 / ${data.platforms.length} 个平台参与`);
process.exit(ok > 0 ? 0 : 1);