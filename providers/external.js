/**
 * 外部 provider 加载器（v1.15）
 *
 * 目录：`<DSH profile>/web-scout-providers/*.mjs`（或 .js）
 * 文件写法（默认导出对象，或导出 `providers` 数组）：
 *
 *   export default {
 *     id: 'demo',
 *     label: '示例站点',
 *     kind: 'article',
 *     browser: (q) => `https://example.com/search?q=${encodeURIComponent(q)}`,
 *     async search({ query, limit }) {
 *       return [{ title: `示例 · ${query}`, url: 'https://example.com/a', snippet: '……' }];
 *     },
 *   };
 *
 * 约定：
 *   - 加载失败、语法错误、字段不合法都只记进 errors，不影响插件其它功能。
 *   - 每次 reload 都带 `?v=<时间戳>`，所以改完文件调 `provider.reload` 就生效，不用重启 Host。
 *   - 不自动执行任何安装脚本；只用 Node 原生 import。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGES = 20;

export function externalProviderDir(configDir) {
  const base = configDir || process.env.DSH_PROFILE_DIR || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop');
  return path.join(base, 'web-scout-providers');
}

export async function loadExternalProviders({ dir, registry, replace = true } = {}) {
  const directory = dir || externalProviderDir();
  const report = { dir: directory, loaded: [], errors: [], skipped: false };

  if (!fs.existsSync(directory)) {
    report.skipped = true;
    return report;
  }

  let files = [];
  try {
    files = fs
      .readdirSync(directory)
      .filter((name) => /\.(mjs|js)$/i.test(name))
      .sort()
      .slice(0, MAX_FILES);
  } catch (error) {
    report.errors.push({ file: directory, message: `目录读不了：${error.message}` });
    return report;
  }

  if (replace) registry.dropSource('external');

  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        report.errors.push({ file: name, message: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB，已跳过` });
        continue;
      }
      const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
      const exported = mod.default || mod.provider || mod.providers;
      const list = Array.isArray(exported) ? exported : exported ? [exported] : [];
      if (list.length === 0) {
        report.errors.push({ file: name, message: '没有导出 default / provider / providers' });
        continue;
      }
      for (const raw of list) {
        const result = registry.register({ ...raw, source: 'external' }, { replace: true, source: 'external' });
        if (result.ok) {
          report.loaded.push(result.provider.id);
        } else {
          report.errors.push({ file: name, id: raw && raw.id, message: result.errors.join('；') });
        }
      }
    } catch (error) {
      report.errors.push({ file: name, message: `加载失败：${error.message}` });
    }
  }

  return report;
}

/**
 * 按包名发现 provider：扫描若干 node_modules，找 `web-scout-provider-*`。
 * 只 import 包自己的入口（package.json 的 exports/main，缺省 index.mjs|index.js），
 * 不执行安装脚本、不读包内其它文件；任何包出错只记进 errors。
 */
export async function discoverPackageProviders({ roots = [], registry, replace = true } = {}) {
  const report = { roots: [], packages: [], errors: [], skipped: false };
  if (!registry) throw new Error('discoverPackageProviders 需要 registry');
  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    const modules = path.join(root, 'node_modules');
    if (!fs.existsSync(modules)) continue;
    report.roots.push(modules);
    let names = [];
    try {
      names = fs
        .readdirSync(modules)
        .filter((name) => /^web-scout-provider-[a-z0-9._-]+$/i.test(name))
        .sort()
        .slice(0, MAX_PACKAGES);
    } catch (error) {
      report.errors.push({ root: modules, message: `目录读不了：${error.message}` });
      continue;
    }
    for (const name of names) {
      const dir = path.join(modules, name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      try {
        const manifestFile = path.join(dir, 'package.json');
        let manifest = {};
        if (fs.existsSync(manifestFile)) manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const entry = resolvePackageEntry(dir, manifest);
        if (!entry) {
          report.errors.push({ package: name, message: '找不到入口文件（exports/main/index.mjs）' });
          continue;
        }
        const stat = fs.statSync(entry);
        if (stat.size > MAX_FILE_BYTES) {
          report.errors.push({ package: name, message: `入口文件超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB，已跳过` });
          continue;
        }
        const mod = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
        const exported = mod.default || mod.provider || mod.providers;
        const list = Array.isArray(exported) ? exported : exported ? [exported] : [];
        if (list.length === 0) {
          report.errors.push({ package: name, message: '没有导出 default / provider / providers' });
          continue;
        }
        for (const raw of list) {
          const result = registry.register({ ...raw, source: 'package' }, { replace: true, source: 'package' });
          if (result.ok) {
            report.packages.push({ package: name, id: result.provider.id, version: manifest.version || '' });
          } else {
            report.errors.push({ package: name, id: raw && raw.id, message: result.errors.join('；') });
          }
        }
      } catch (error) {
        report.errors.push({ package: name, message: `加载失败：${error.message}` });
      }
    }
  }
  if (report.roots.length === 0) report.skipped = true;
  if (replace && report.packages.length === 0 && report.roots.length > 0) {
    // 没找到任何包时不要把已有的 package provider 清掉：可能只是这次目录还没装好。
    report.kept = true;
  }
  return report;
}

function resolvePackageEntry(dir, manifest) {
  const candidates = [];
  const exported = manifest && manifest.exports;
  if (typeof exported === 'string') candidates.push(exported);
  else if (exported && typeof exported === 'object') {
    const dot = exported['.'] || exported.import || exported.default;
    if (typeof dot === 'string') candidates.push(dot);
    else if (dot && typeof dot === 'object') {
      if (typeof dot.import === 'string') candidates.push(dot.import);
      if (typeof dot.default === 'string') candidates.push(dot.default);
    }
  }
  if (typeof manifest.main === 'string') candidates.push(manifest.main);
  candidates.push('index.mjs', 'index.js');
  for (const candidate of candidates) {
    const file = path.join(dir, candidate);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {
      /* try next */
    }
  }
  return '';
}