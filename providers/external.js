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