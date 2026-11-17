# dsh-web-scout

Web search and research for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — 46 platforms, hot lists, evidence packs, multi-round research, and an MCP server, all inside the composer.

[中文说明](README.md)

## Install

```bash
dsh plugin add dsh-web-scout
```

Or install the bundle from the plugin panel: `dsh-web-scout`.

## What you get

- **One search box, 46 platforms.** Bing, Baidu, 360, CSDN, Juejin, Zhihu (entry), V2EX, Toutiao, WeChat, Bilibili, Douban, GitHub, npm, Stack Overflow, Hacker News, MDN, SegmentFault and more. Native JSON/HTML backends where the site allows it; an in-site search row where it does not.
- **Hot lists without keywords.** Eight platforms expose their current front page (Weibo, Zhihu, Bilibili, Douban, V2EX, …).
- **Evidence packs.** Top results scored by relevance, recency and source, packed into a character budget, with coverage gaps and optional verbatim quotes fetched from the page.
- **Multi-round research.** Query variants, several search waves, and a quality quorum, with a wall-clock budget.
- **Topic watches.** A saved query re-runs on a schedule and only surfaces what is new since the last run.
- **Browser-rendered scraping.** For sites that need JavaScript, the plugin drives its own Chromium/Edge profile (login state included) and extracts the results; if the page throws a captcha it falls back to the in-site search row and says why.
- **Two-level cache.** Memory LRU + SQLite (`~/.dsh/web-scout-cache.db`) shared by the panel, the agent tools and the MCP server. Cache keys include the query language, so `zh` and `en` results never mix.
- **Quality controls.** Pluggable reranking (lexical by default), per-platform circuit breaker after repeated failures, persisted health history with a 20-sample strip per platform.
- **Result actions.** Sort by relevance/platform, copy as Markdown or CSV, recent queries with TTL, `Alt+W` to focus the box.
- **Language adaptation.** `auto` detects the query language (CJK vs Latin words) and switches the `Accept-Language` header and engine parameters (`setlang`) accordingly; override with `zh` / `en`.

## Agent tools

| Tool | Use |
| --- | --- |
| `web_scout_search` | Search one or more platforms |
| `web_scout_read` | Read a page as text |
| `web_scout_evidence` | Build an evidence pack with quotes |
| `web_scout_research` | Multi-round research with a report |
| `web_scout_health` | Probe backends and see health history |
| `web_scout_watch` | Manage topic watches |
| `web_scout_open` | Open a URL or a platform search page in the desktop browser |

## MCP server

```bash
npx dsh-web-scout-mcp
```

Tools, resources (`web-scout://platform/{id}`, health, config) and prompts (`research_topic`, `platform_sweep`, `watch_topic`) are all exposed; long calls emit `notifications/progress`.

## Write your own provider

```bash
node scripts/new-provider.mjs my-site
npm run provider:new -- my-site --dir ./tmp
```

Providers can be a single file in `<profile>/web-scout-providers/` or an npm package named `web-scout-provider-*`. Contract and checklist: [docs/providers.en.md](docs/providers.en.md).

## Requirements

- DeepSeek Harness with the plugin runtime (`dsh.bundle` manifest).
- Node.js 20+.
- A Chromium/Edge install for browser-rendered scraping and login (optional but recommended).
- Network access to the platforms you query; some sites need a proxy/tunnel, which the plugin reads from DSH settings or `proxy` config.

## License

MIT