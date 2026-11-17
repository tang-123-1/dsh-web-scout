# 写一个 web-scout provider

provider 就是「一个站点怎么搜」。内置 46 个平台都能被 provider 覆盖，你也可以只加自己的站点，不用改插件代码。

## 放在哪

| 形式 | 位置 | 适合 |
| --- | --- | --- |
| 单文件 | `<profile>/web-scout-providers/<id>.mjs`（或 `.js`） | 临时试一个站、自己用 |
| npm 包 | 任意 `node_modules/web-scout-provider-<name>` | 分享给别人、发布到 npm |

`<profile>` 是 DSH 的 profile 目录；不确定时调一次 op `provider.list`，返回里的 `dir` 就是单文件目录，`packageRoots` 是会被扫描的 `node_modules`。

生成模板：

```bash
node scripts/new-provider.mjs my-site
# 或
npm run provider:new -- my-site --dir D:/tmp/providers --force
```

改完之后不用重启 Host：面板「平台」区点「重新加载」，或调 op `provider.reload`（每次都用新的 query 参数 import，所以文件改动会生效）。

## 最小形状

```js
export default {
  id: 'my-site',            // 小写字母/数字开头，可含 . _ -，≤48
  label: 'My Site',         // 面板显示名
  zh: '我的站',             // 可选，中文名
  kind: 'article',          // auto | web | article | qa | forum | code | doc | video | hot | shop | social
  site: 'example.com',      // 可选，站内搜索与「落地页过滤」用
  browser: (q) => `https://example.com/search?q=${encodeURIComponent(q)}`, // 站内搜索地址，也可用来让用户手动打开
  async search({ query, limit, client, signal }) {
    const { text } = await client.get(`https://example.com/search?q=${encodeURIComponent(query)}`, { as: 'text' });
    return [{ title: '标题', url: 'https://example.com/a', snippet: '摘要', date: '2026-11-17' }].slice(0, limit);
  },
};
```

必填只有 `id`、`label`、`kind`、`search`。`browser` 建议给：`entryOnly` 平台没给 `search` 时，它会变成一条「去站内搜」的入口行；给了 `search` 也能让用户点开原始搜索页。

## search() 的约定

- 参数：`{ query, limit, client, signal, page? }`。`client.get(url, { as: 'text' | 'json' })`，也可以 `client.json(url)`。
- 返回数组，每条至少 `{ title, url }`；`snippet`、`date`、`author`、`score` 可选。
- **只回这个站的结果**，不要把导航、登录、首页塞进来；插件会再过滤一层（`isJunkResult` / `isLandingPage` / 相关性），但源头干净更省事。
- 超过 `limit` 会被截断，不必自己切。
- 抓不到就抛错（`throw new Error('被拦了')`）或返回 `[]`。抛错会记录到 `platforms[].status = 'error'`，连续失败过多会触发熔断；返回空数组记为 `empty`，不会熔断。
- 需要登录的站：返回空数组并在 provider 上标 `login: true`，面板会给「登录」按钮，插件自管浏览器能保持登录态。

## 发布成 npm 包

```
web-scout-provider-<name>/
  package.json   { "name": "web-scout-provider-<name>", "version": "1.0.0", "exports": "./index.mjs" }
  index.mjs      export default { ...provider }
```

- 包名必须是 `web-scout-provider-` 前缀，否则不会被发现。
- 入口按 `exports` → `main` → `index.mjs` / `index.js` 的顺序找。
- 只 import 入口文件；不会执行安装脚本，也不读包内其它文件。
- 单个 provider 出错只记进 `errors`，不会影响其它包或插件本身。
- 最多扫描 20 个包、单入口 ≤256KB。

## 自检清单

1. `op provider.list` 里能看到你的 id，且 `source` 是 `external`（单文件）或 `package`（npm 包）。
2. `op search { "platforms": ["my-site"], "query": "任意词" }` 返回的 `platforms[0].status` 是 `ok`，`count > 0`。
3. 查询一个明显不存在的词，确认返回 `empty` 而不是一堆导航链接。
4. 改一行代码 → `provider.reload` → 再搜一次，确认改动生效。
5. 需要登录的站：先在面板点「登录」，再确认 `login.check` 是 `loggedIn: true`。