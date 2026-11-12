# 变更记录

本文件记录 `web-scout`（@local/web-scout）的功能演进。版本号遵循 `MAJOR.MINOR.PATCH`。

## 1.7.0 — 2026-11-12

### 新增
- **知乎信息流平台**：「知乎推荐」（`/api/v3/feed/topstory/recommend`）与「知乎关注」（`/api/v3/feed/topstory`），每个平台按页取 6 条，`pages` 控制页数；解析回答 / 文章 / 视频 / 想法四种 `target`，带作者、赞数、评论数、日期。
- 两者都标 `list: true`：不消费关键词、不参与相关性过滤，也不进默认 9 源（避免污染普通检索），需要时在「站点」分区里加入芯片条。
- 登录门禁：后端先查 cookie jar 里有没有 `z_c0`，没有就抛 `login` 型 blocked，状态药丸显示「需要登录：还没登录知乎…」，而不是含糊的网络错误。
- 空查询放宽：`runSearch` 在“所选平台全是信息流”时允许空 `query`；`api.js` 同样加了 `feedOnly` 判断，不会再把对话内容硬塞成查询词。
- `platformCatalog()` 的 `login` 字段支持 `needsLogin` 回退：知乎推荐/关注直接复用 `https://www.zhihu.com/signin`。

### 工程
- 新增 GitHub Actions：`ci.yml`（语法/清单校验）、`release.yml`（打 tag 自动打包 zip/tgz 并挂到 Release）。
- 仓库整理：`LICENSE`（MIT）、`.gitignore`、`.gitattributes`、`CHANGELOG.md`、`scripts/smoke.mjs` 离线冒烟测试；`browserAuth.js` 补齐 macOS/Linux 的 Edge/Chrome 路径。

## 1.6.0 — 2026-11-12

### 数据量
- 后端支持翻页：CSDN（`p=`）、V2EX（`from=`）、掘金（`cursor` 游标）、哔哩哔哩（`page=`）、360 搜索（`pn=`）、百度（`pn=`）、GitHub / Stack Exchange（`page=`）、Hacker News（algolia `page`）、微信（`page=`）。
- 新增 `collectPages()`：逐页抓取，第 2 页起失败只降级不整体失败；每页去重，攒够上限或某页少于 3 条即停。
- 上限放宽：`limit` ≤ 30、`pages` ≤ 4、`maxPlatforms` ≤ 14；默认 `limit 12 / pages 3 / maxPlatforms 10`。
- 默认平台从 6 个增加到 **9 个**：必应、360、CSDN、掘金、今日头条、V2EX、知乎、哔哩哔哩、微信。
- 新增「微信」平台（搜狗微信搜索，抓公众号文章标题/摘要/账号）。
- 结果数量演进：`龙珠` 单次搜索 11–13 条（1.4）→ 24 条（1.4.1）→ 30 条（1.5）→ 70–90 条（1.6），`limit 20 / pages 4` 可到 103–121 条。

### 修复
- 跨平台去重：`dedupeKey()` 剥掉 `utm_*`、`spm`、`from`、`source`、`ref` 等追踪参数与末尾斜杠，避免同一篇文章在不同源里重复出现（实测重复 1 → 0）。
- HTML 实体多次转义：`stripTags()` 最多解码 3 轮，补 `ensp/emsp/thinsp/zwnj/le/ge/prime` 等实体，修掉标题里露出的 `&ensp;`。
- 站内兜底放宽：结果少于 3 条就补一次 `site:` 检索，不再只在 0 条时兜底（修掉「B 站只剩 1 条」）。
- 旧配置迁移：`store` 增加 `version` 字段，老配置里的 `limit 8 / 6 个平台` 自动升级到新默认值，用户手动改过的值不动。

## 1.5.0 — 2026-11-12

- 新增**站内搜索后端**：今日头条（解析 SSR 页面里的 JSON 数据块）、V2EX（`sov2ex` 接口）。
- 落地页过滤：站点类平台不再把首页/频道页（`/`、`/hot`、`/search`、`/topic` 等）当成结果返回。
- 站内搜索入口行：正文拿不到时，给一条「在 XX 里直接搜索『关键词』」，点击直接打开该站自己的搜索页。
- 默认平台 4 → 6（加今日头条、V2EX）。

## 1.4.1 — 2026-11-12

- `打开` 恢复为交给系统默认浏览器（1.4 的面板内阅读器已移除）。
- 结果条数修复：`auto` 由「默认平台」扩展为「默认平台 ∪ 对话里识别出的站点」；每个后端按 `limit×2` 超量抓取后再过滤；`maxPlatforms` 可配。
- 面板保留可拖动、可缩放，位置记在 `localStorage['web-scout-panel-rect']`。

## 1.4.0 — 2026-11-12

- 面板内阅读器视图（`read` 接口 + 反爬提示）、面板拖动与右下角缩放。**1.4.1 已移除阅读器**，拖动缩放保留。

## 1.3.1 — 2026-11-12

- 搜索质量：`relevanceTokens()` + `keepRelevant()` 过滤掉不含关键词的“猜词”结果（修掉 B 站搜「龙珠」返回「赵云-飞龙神将」这类噪音）。
- 结果为空时用 `site:` 兜底一次。

## 1.3.0 — 2026-11-12

- 新增「抖音热榜」平台：`/web/api/v2/hotsearch/billboard/word/`，一次 50 条，带排名、热度、标签位。

## 1.2.2 — 2026-11-12

- 修掉芯片「取消选中仍留白框」：`border` 简写改成 `borderWidth/Style/Color` 三段（React 只清 longhand，简写被判“无变化”跳过）。
- 选中态改为实心白胶囊；用 `data-ws-ring` + `!important` 规则压掉宿主按钮的 hover/focus 光环。

## 1.2.1 — 2026-11-12

- 「站点」网格点一下加入、再点一下移除（原来只能加不能减）。
- HMR 导致的重复挂载：`apply()` 先执行上一代 disposer，避免两套面板打架。
- 连点并发：请求序号守卫，迟到的旧响应不覆盖新状态。

## 1.2.0 — 2026-11-12

- **插件自管浏览器**：`browserAuth.js` 用 `--user-data-dir` 启动一个独立 profile 的 Edge/Chrome，通过 CDP 读 `Storage.getCookies`，绕开「浏览器运行时 cookie 库被独占锁」的问题。
- 登录判定加 `require` 白名单：哔哩哔哩 `SESSDATA`、知乎 `z_c0`、GitHub `user_session`/`logged_in`，匿名 cookie 不再误判为已登录。
- 登录分区按钮：登录 / 插件浏览器 / 读取登录 / 本机导入 / 检查 / 清除 / 粘贴 Cookie。

## 1.1.0 — 2026-11-12

- 平台名全部中文（来自 `catalog.platforms[].label`），芯片不再显示 `bing/zhihu` 之类的 id。
- 「＋站点」可添加任意站点（名称 / 限定域名 / 搜索地址 `{q}`），也可删除。
- 登录状态：本机浏览器 cookie 导入（Edge/Chrome/Firefox）、粘贴 Cookie、探针校验。

## 1.0.0 — 2026-11-12

- 首个版本：Composer 底部「联网检索」挂件、结果面板、36 个平台后端、三件套工具（`web_scout_search` / `web_scout_open` / `web_scout_read`）、`/web-scout/api` HTTP 接口。