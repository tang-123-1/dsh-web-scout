#!/usr/bin/env node
/**
 * 生成一个外部 provider 文件（不是包，只是单文件），放进 profile 的 web-scout-providers/。
 *
 *   node scripts/new-provider.mjs my-site
 *   node scripts/new-provider.mjs my-site --dir D:/tmp/providers --force
 *
 * 生成后直接编辑该文件，再在面板「平台」区点一次「重新加载」，或调 op provider.reload。
 */
import fs from 'node:fs';
import path from 'node:path';

import { externalProviderDir } from '../providers/external.js';

function parse(argv) {
  const out = { id: '', dir: '', force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--force' || value === '-f') out.force = true;
    else if (value === '--dir') {
      out.dir = argv[i + 1] || '';
      i += 1;
    } else if (value === '--help' || value === '-h') out.help = true;
    else rest.push(value);
  }
  out.id = rest[0] || '';
  return out;
}

function template(id) {
  const name = id.replace(/-/g, ' ');
  return `/**
 * 外部 provider：${id}
 * 文档：docs/providers.md
 */
export default {
  id: ${JSON.stringify(id)},
  label: ${JSON.stringify(name)},
  zh: ${JSON.stringify(name)},
  kind: 'article',
  browser: (query) => 'https://example.com/search?q=' + encodeURIComponent(query),
  async search({ query, limit, client }) {
    const url = 'https://example.com/search?q=' + encodeURIComponent(query);
    const { text } = await client.get(url, { as: 'text' });
    const rows = [];
    // 解析 text（或 client.json() 拿 JSON），最多 limit 条。
    // 每条至少要有 title 与 url；snippet / date / author 可选。
    if (text && text.length > 0 && rows.length === 0) {
      return [{ title: ${JSON.stringify(name)} + ' · ' + query, url: 'https://example.com/', snippet: '占位结果：编辑本文件把解析补上。' }];
    }
    return rows.slice(0, limit);
  },
};
`;
}

const options = parse(process.argv.slice(2));
if (options.help || options.id === '') {
  process.stdout.write(`用法：node scripts/new-provider.mjs <id> [--dir <目录>] [--force]

id 只能是小写字母、数字、短横线，2–31 位；默认写到：
  ${externalProviderDir()}
`);
  process.exit(options.id === '' && !options.help ? 1 : 0);
}

if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(options.id)) {
  process.stderr.write(`id 不合规：${options.id}（小写字母/数字/短横线，2–31 位）\n`);
  process.exit(1);
}

const dir = options.dir || externalProviderDir();
const file = path.join(dir, `${options.id}.mjs`);
if (fs.existsSync(file) && !options.force) {
  process.stderr.write(`已存在：${file}（要覆盖加 --force）\n`);
  process.exit(1);
}

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, template(options.id), 'utf8');
} catch (error) {
  process.stderr.write(`写入失败：${error.message}\n`);
  process.exit(1);
}

process.stdout.write(`已生成 ${file}
下一步：
  1) 编辑 search()：先 client.get(url, { as: 'text' }) 或 client.json() 看真实返回；
  2) 只回 { title, url, snippet? }；
  3) 面板点「重新加载」，或 op provider.reload；
  4) 用 op search { platforms: ['${options.id}'], query: '...' } 验收。
`);