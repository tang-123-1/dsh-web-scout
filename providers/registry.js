/**
 * Provider 注册表（v1.15，路线图第 2 步）
 *
 * 「可插拔」的含义：加一个站点不再改 `engines.js`，而是写一个 provider 对象/文件，
 * 交给注册表；`runSearch` 只认 provider 接口，不再认具体是哪家后端。
 *
 * provider 契约（全部字段都可选，除 id / label / search 或 browser 之一）：
 *   id          唯一标识，`[a-z0-9][a-z0-9._-]{0,47}`，站内用英文小写（如 `csdn`）
 *   label       中文名（面板芯片、结果标签都用它）
 *   labelEn     英文名
 *   group       general | cn | social | video | dev | shop | knowledge …
 *   kind        auto | video | article | qa | forum | hot | shop | code | doc | social | web
 *   list        true = 榜单/信息流，不需要关键词
 *   needsLogin  需要登录的平台 id（如 'zhihu'），用于登录门禁与提示
 *   needsTunnel true = 大陆直连通常失败，默认超时要更短
 *   site        站内检索用的域名（`site:bilibili.com`）
 *   backend     兼容字段：内部后端 id（历史原因保留）
 *   singlePage  true = 该后端只有第一页（忽略 pages）
 *   browser(q)  打开该站搜索页的 URL
 *   search(ctx) 返回 [{title, url, snippet, extra?, thumb?, embed?}]；
 *               ctx = { client, query, limit, timeoutMs, page, pages }
 *
 * 校验失败不会抛异常，而是记进 `errors()`——外部 provider 写错了不能把插件搞挂。
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const KINDS = new Set(['auto', 'video', 'article', 'qa', 'forum', 'hot', 'shop', 'code', 'doc', 'social', 'web']);
const SOURCES = new Set(['builtin', 'external', 'custom']);

export function validateProvider(raw, options = {}) {
  const errors = [];
  const source = options.source || raw?.source || 'external';
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['provider 必须是对象'], source };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) errors.push(`id 不合法（要求小写字母/数字开头，可含 . _ -，≤48 字）：${JSON.stringify(raw.id)}`);
  if (typeof raw.label !== 'string' || raw.label.trim() === '') errors.push('label（中文名）必填');
  if (typeof raw.search !== 'function' && typeof raw.browser !== 'function') errors.push('search 或 browser 至少要有一个');
  if (raw.kind !== undefined && !KINDS.has(raw.kind)) errors.push(`kind 不合法：${JSON.stringify(raw.kind)}`);
  if (!SOURCES.has(source)) errors.push(`source 不合法：${JSON.stringify(source)}`);
  if (raw.list !== undefined && typeof raw.list !== 'boolean') errors.push('list 必须是布尔值');
  if (raw.site !== undefined && typeof raw.site !== 'string') errors.push('site 必须是字符串');
  return {
    ok: errors.length === 0,
    errors,
    source,
    provider: {
      id,
      label: typeof raw.label === 'string' ? raw.label.trim() : id,
      labelEn: typeof raw.labelEn === 'string' ? raw.labelEn : '',
      group: typeof raw.group === 'string' && raw.group !== '' ? raw.group : 'general',
      kind: KINDS.has(raw.kind) ? raw.kind : 'auto',
      list: raw.list === true,
      needsLogin: typeof raw.needsLogin === 'string' && raw.needsLogin !== '' ? raw.needsLogin : '',
      needsTunnel: raw.needsTunnel === true,
      site: typeof raw.site === 'string' ? raw.site : '',
      backend: typeof raw.backend === 'string' ? raw.backend : '',
      singlePage: raw.singlePage === true,
      browser: typeof raw.browser === 'function' ? raw.browser : null,
      search: typeof raw.search === 'function' ? raw.search : null,
      describe: typeof raw.describe === 'string' ? raw.describe : '',
      source,
      version: typeof raw.version === 'string' ? raw.version : '',
    },
  };
}

export class ProviderRegistry {
  constructor() {
    this.map = new Map();
    this.failures = [];
    this.revision = 0;
  }

  /** 注册一个 provider。重复 id 默认拒绝；replace=true 覆盖。 */
  register(raw, options = {}) {
    const verdict = validateProvider(raw, options);
    if (!verdict.ok) {
      this.noteFailure({ id: raw && typeof raw.id === 'string' ? raw.id : '?', source: verdict.source, errors: verdict.errors });
      return { ok: false, errors: verdict.errors };
    }
    const { provider } = verdict;
    const existing = this.map.get(provider.id);
    if (existing && options.replace !== true) {
      const errors = [`id 重复：${provider.id}（已有 ${existing.source} 版本，传 replace:true 覆盖）`];
      this.noteFailure({ id: provider.id, source: provider.source, errors });
      return { ok: false, errors };
    }
    this.map.set(provider.id, provider);
    this.revision += 1;
    return { ok: true, provider, replaced: Boolean(existing) };
  }

  /** 批量注册；返回各自结果，不影响其它条目。 */
  registerAll(list, options = {}) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) out.push(this.register(item, options));
    return out;
  }

  /** 卸载某个来源的全部 provider（重载外部目录时用）。 */
  dropSource(source) {
    let dropped = 0;
    for (const [id, provider] of [...this.map]) {
      if (provider.source === source) {
        this.map.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0) this.revision += 1;
    return dropped;
  }

  noteFailure(entry) {
    this.failures.push({ ...entry, at: new Date().toISOString() });
    if (this.failures.length > 40) this.failures.shift();
  }

  clearFailures() {
    this.failures = [];
  }

  get(id) {
    return this.map.get(id);
  }

  has(id) {
    return this.map.has(id);
  }

  ids() {
    return [...this.map.keys()];
  }

  list() {
    return [...this.map.values()];
  }

  bySource(source) {
    return this.list().filter((provider) => provider.source === source);
  }

  get size() {
    return this.map.size;
  }
}

export const providers = new ProviderRegistry();