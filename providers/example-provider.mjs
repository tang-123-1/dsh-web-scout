/**
 * 外部 provider 示例：演示「不改插件代码就能加一个站点」。
 *
 * 用法：
 *   1. 把本文件复制到 <DSH profile>/web-scout-providers/ 里（例如叫 demo.mjs）
 *   2. POST /web-scout/api {"op":"provider.reload"}
 *   3. 面板「站点」分区里就会出现它，或直接 {"op":"search","platforms":["wsdemo"]}
 *
 * 本文件是自包含的：只用全局 fetch，不依赖插件内部模块。
 */
export default {
  id: 'wsdemo',
  label: '示例站点',
  labelEn: 'Demo',
  group: 'general',
  kind: 'article',
  site: 'example.com',
  version: '1.0.0',
  describe: '一个最小的 provider 示例：把查询词拼进标题，返回固定链接。',
  browser: (query) => `https://example.com/search?q=${encodeURIComponent(query)}`,

  async search({ query, limit }) {
    const rows = [];
    const total = Math.max(1, Math.min(Number(limit) || 3, 5));
    for (let index = 1; index <= total; index += 1) {
      rows.push({
        title: `示例结果 ${index}：${query}`,
        url: `https://example.com/demo/${index}?q=${encodeURIComponent(query)}`,
        snippet: `这是外部 provider「示例站点」返回的第 ${index} 条结果，用来验证可插拔后端。`,
        extra: { demo: true, rank: index },
      });
    }
    return rows;
  },
};