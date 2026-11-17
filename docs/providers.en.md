# Writing a provider

A provider is "how to search one site". All 46 built-in platforms are providers; you can add your own without touching plugin code.

## Where it lives

| Form | Location | Good for |
| --- | --- | --- |
| Single file | `<profile>/web-scout-providers/<id>.mjs` (or `.js`) | Trying one site, personal use |
| npm package | any `node_modules/web-scout-provider-<name>` | Sharing, publishing |

`<profile>` is the DSH profile directory. If unsure, call op `provider.list`: `dir` is the single-file directory and `packageRoots` lists the scanned `node_modules` folders.

Scaffold:

```bash
node scripts/new-provider.mjs my-site
npm run provider:new -- my-site --dir D:/tmp/providers --force
```

No host restart needed: click "Reload" in the platform panel, or call op `provider.reload` (files are re-imported with a fresh query string, so edits take effect).

## Minimal shape

```js
export default {
  id: 'my-site',            // lowercase letters/digits first, may contain . _ -, max 48
  label: 'My Site',
  zh: '我的站',              // optional display name (Chinese)
  kind: 'article',          // auto | web | article | qa | forum | code | doc | video | hot | shop | social
  site: 'example.com',      // optional: used for in-site search and landing-page filtering
  browser: (q) => `https://example.com/search?q=${encodeURIComponent(q)}`,
  async search({ query, limit, client, signal }) {
    const { text } = await client.get(`https://example.com/search?q=${encodeURIComponent(query)}`, { as: 'text' });
    return [{ title: 'Title', url: 'https://example.com/a', snippet: 'Snippet', date: '2026-11-17' }].slice(0, limit);
  },
};
```

Required: `id`, `label`, `kind`, `search`. `browser` is recommended — without `search` it becomes a "search on site" entry row; with `search` it still lets users open the original page.

## `search()` contract

- Arguments: `{ query, limit, client, signal, page? }`. Use `client.get(url, { as: 'text' | 'json' })` or `client.json(url)`.
- Return an array; each item needs at least `{ title, url }`. `snippet`, `date`, `author`, `score` are optional.
- Return results **from this site only** — no nav, login or home page links. The plugin filters again (`isJunkResult` / `isLandingPage` / relevance), but a clean source is cheaper.
- More than `limit` is truncated for you.
- If you get blocked, `throw new Error('blocked')`; the platform is marked `error` and repeated failures trip the circuit breaker. Returning `[]` is recorded as `empty` and never trips it.
- Login-required sites: set `login: true` on the provider; the panel then offers a "Sign in" button and the plugin's own browser keeps the session.

## Publishing as an npm package

```
web-scout-provider-<name>/
  package.json   { "name": "web-scout-provider-<name>", "version": "1.0.0", "exports": "./index.mjs" }
  index.mjs      export default { ...provider }
```

- The package name must start with `web-scout-provider-`.
- Entry resolution: `exports` → `main` → `index.mjs` / `index.js`.
- Only the entry file is imported; install scripts are never run.
- One bad package lands in `errors` and does not affect other packages or the plugin.
- Limits: 20 packages, entry ≤256KB.

## Checklist

1. `op provider.list` shows your id with `source: "external"` (single file) or `"package"`.
2. `op search { "platforms": ["my-site"], "query": "anything" }` returns `status: "ok"` with `count > 0`.
3. Searching an obviously missing term returns `empty`, not a pile of navigation links.
4. Edit one line → `provider.reload` → search again; the change is live.
5. Login sites: click "Sign in", then confirm `login.check` returns `loggedIn: true`.