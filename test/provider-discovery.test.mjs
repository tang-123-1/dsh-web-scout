import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverPackageProviders, loadExternalProviders } from '../providers/external.js';
import { ProviderRegistry } from '../providers/registry.js';

const createRegistry = () => new ProviderRegistry();

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-providers-'));
  return root;
}

function writePackage(root, name, body, manifest = {}) {
  const dir = path.join(root, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', main: 'index.mjs', ...manifest }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'index.mjs'), body, 'utf8');
}

test('从 node_modules 发现 web-scout-provider-* 包', async () => {
  const root = workspace();
  writePackage(
    root,
    'web-scout-provider-demo',
    "export default { id: 'demo', label: '演示', kind: 'article', browser: (q) => 'https://example.com/?q=' + encodeURIComponent(q), async search() { return []; } };\n",
  );
  const registry = createRegistry();
  const report = await discoverPackageProviders({ roots: [root], registry });
  assert.deepEqual(report.packages.map((item) => item.id), ['demo']);
  assert.equal(report.packages[0].version, '1.2.3');
  assert.equal(registry.get('demo').source, 'package');
});

test('不碰名字不相干的包', async () => {
  const root = workspace();
  writePackage(root, 'lodash', 'export default { id: "lodash", label: "x", kind: "web", async search() { return []; } };\n');
  const registry = createRegistry();
  const report = await discoverPackageProviders({ roots: [root], registry });
  assert.deepEqual(report.packages, []);
  assert.equal(registry.get('lodash'), undefined);
});

test('坏包只进 errors，其它包照常加载', async () => {
  const root = workspace();
  writePackage(root, 'web-scout-provider-broken', 'export const nope = 1;\n');
  writePackage(
    root,
    'web-scout-provider-fine',
    "export default { id: 'fine', label: '好的', kind: 'article', browser: (q) => 'https://example.com/?q=' + q, async search() { return []; } };\n",
  );
  const registry = createRegistry();
  const report = await discoverPackageProviders({ roots: [root], registry });
  assert.deepEqual(report.packages.map((item) => item.id), ['fine']);
  assert.equal(report.errors.some((item) => item.package === 'web-scout-provider-broken'), true);
});

test('exports 字段优先于 main', async () => {
  const root = workspace();
  const dir = path.join(root, 'node_modules', 'web-scout-provider-exports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'web-scout-provider-exports', exports: { '.': { import: './dist/entry.mjs' } } }),
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'dist', 'entry.mjs'),
    "export default { id: 'exp', label: '导出', kind: 'web', browser: (q) => 'https://example.com/?q=' + q, async search() { return []; } };\n",
    'utf8',
  );
  const registry = createRegistry();
  const report = await discoverPackageProviders({ roots: [root], registry });
  assert.deepEqual(report.packages.map((item) => item.id), ['exp']);
});

test('没有 node_modules 时标记 skipped 而不是报错', async () => {
  const root = workspace();
  const registry = createRegistry();
  const report = await discoverPackageProviders({ roots: [root], registry });
  assert.equal(report.skipped, true);
  assert.deepEqual(report.errors, []);
});

test('单文件 provider 仍可用，且与包发现互不覆盖', async () => {
  const root = workspace();
  const dir = path.join(root, 'providers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'single.mjs'),
    "export default { id: 'single', label: '单文件', kind: 'web', browser: (q) => 'https://example.com/?q=' + q, async search() { return []; } };\n",
    'utf8',
  );
  writePackage(
    root,
    'web-scout-provider-pkg',
    "export default { id: 'pkg', label: '包', kind: 'web', browser: (q) => 'https://example.com/?q=' + q, async search() { return []; } };\n",
  );
  const registry = createRegistry();
  const fileReport = await loadExternalProviders({ dir, registry });
  const packageReport = await discoverPackageProviders({ roots: [root], registry });
  assert.deepEqual(fileReport.loaded, ['single']);
  assert.deepEqual(packageReport.packages.map((item) => item.id), ['pkg']);
  assert.ok(registry.get('single'));
  assert.ok(registry.get('pkg'));
});