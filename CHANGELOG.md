# 变更记录

本文件记录 `web-scout`（@local/web-scout）的功能演进。版本号遵循 `MAJOR.MINOR.PATCH`。

## 1.14.0 — 2026-11-13

**为什么改**：路线图第 1 步。搜索一次要 1 秒左右、读一篇正文要 1 秒，而同一个词/同一个链接在几分钟内经常被重复请求（面板手滑再点一次、工具重跑、对话里反复引用同一篇）。这部分延迟和上游限额都是白花的。

### 新增
- `cache.js`：两级缓存。内存 LRU（240 条）+ `node:sqlite` 持久层（WAL、`cache` 表、过期索引），键取 `sha1`，默认 TTL 6 小时。
- `cache.stats` / `cache.clear` 两个 HTTP op：命中数、行数、占用字节、文件路径、是否持久化、错误原因。
- 搜索与正文读取全部接缓存：命中直接返回，payload 带 `cached` / `cacheAgeMs` / `cacheSource`。
- 面板：标题出现「缓存 3s」徽标，搜索按钮旁新增「刷新」（绕过缓存）。
- 工具 `web_scout_search` 支持 `refresh`；顺带补上 `pages` 参数（此前工具侧固定用默认页数）。

### 修
- SQLite 打不开时**不再抛错**：退化成纯内存缓存，搜索照常工作，`cache.stats.persistent` 为 false 并带 `error` 说明。

### 验收
- `_probe/verify-cache.mjs` 13 项全通过（内存命中、跨实例命中、TTL 过期、wrap 只跑一次、落盘失败降级、API 命中/刷新、stats/clear、正文缓存、maxChars 分键）。
- live：搜索首次 1100 ms → 二次 4 ms；正文首次 1074 ms → 二次 2 ms；`refresh` 重新联网 933 ms。

## 1.13.0 — 空壳结果过滤

- **中转壳不再是真地址**：百度 SERP 的 `<h3><a href>` 常是 `www.baidu.com/link?url=…`，真地址在结果容器的 `mu` 属性上。`backends.baidu` 改为优先取 `mu`/`data-landurl`，离线复解析 19/19 条全部还原成 baike/知乎/公众号/百家号直链。
- **空条目直接丢掉**：新增 `isJunkResult()`——标题为空、标题等于查询、标题是「…的最新相关信息」这类占位、链接指向引擎自己的结果页（`/s?wd=`）时过滤，并在平台状态里记「滤掉 N 条空壳」。榜单平台（`list: true`）豁免。
- **中转壳保留但标记**：新增 `isRedirectorUrl()`（支持子域匹配），命中时给结果打 `extra.shell`，面板 URL 行显示「中转」标签——微信/搜狗的解壳需要过 `antispider`，服务端解不开，如实标注比假装是直链好。
- **百度热搜链接换桌面版**：`m.baidu.com/s?word=` 分享壳统一改成 `www.baidu.com/s?wd=`。
- **站内兜底多加百度**：`siteSearch` 的引擎顺序变成 必应 → 360 → 百度。
- **中文相关性判定修 bug**：原来用整串 token 比对，必应给中文标题插空格（`7-8 岁儿童绘本`）就会把正常结果全滤掉，表现为「必应 empty」。改为去空白 + 2-gram 覆盖率 ≥0.5 通过；拉丁词仍要求全含。
- **"全被过滤"要说清楚**：抓到结果但一条都不相关时（如搜索引擎把 `7-8岁儿童绘本` 当成 `7` 返回整页 7-Zip），状态改为 `blocked` + 「抓到的 N 条都不含查询词，已过滤」。
## 1.12.0

- 面板新增「加入对话」：把当前结果的标题/平台/类型/链接/摘要拼成 Markdown 塞进宿主输入框，模型可直接基于它作答。
- 每条结果新增「＋」：单条带进输入框，适合「就这条展开讲」。
- 走宿主公开的 `InputActions`，三档降级：`insertQuote` → `insertText`（带 `draftRev` 校验、可撤销）→ `setDraft`；全失败时提示「输入框正忙」。
- 只填草稿不自动发送；插入成功后面板提示「已加入输入框，回车即可发送」。

## 1.11.0

- 视频类结果带作者与序号：`@作者`（可点进主页）、`第 k 个 / 共 M 个`、点赞数、发布日期；紧凑视图合并成一行。
- B 站：`x/space/navnum` 取作品总数，`x/space/wbi/arc/search?order=pubdate` 倒序分页二分定位，得出「第几个」；每次搜索只给第一条算序号（3 秒预算、最多 6 次翻页）。
- B 站空间接口按 IP 风控（`-412 / -352 / -799`）：命中后 10 分钟降级为「共 M 个视频」，不影响搜索本身。
- 修 `bilibiliKey` 少读一层 `.data`（wbi 签名一直拿不到密钥，导致 B 站后端长期走 `site:` 兜底、没有封面和播放）。
- 抖音：结果链接从 `www.douyin.com/video/<id>` 换成免验证码的 `iesdouyin.com/share/video/<id>/`（PC 端 `/discover`、`/hot`、`/video` 全是验证码页或 302 到「精选」）；分享页服务端不再返回 `videoInfoRes`，所以抖音行不保证有作者/点赞。
- `client.js`：`fill()`、`authorText()`、`S.authorRow`/`S.authorLink`；主题色改回 `C.dim`（`C.textDim` 不存在）。

## 1.10.0 — 2026-11-12

### 新增
- **平台筛选**：结果上方的平台药丸变成按钮，点一下只看该平台，标题显示 `当前 / 总数`，并出现 `只看 X · 全部平台` 提示行；再点同一颗药丸取消。筛选只影响展示，不重新请求。
- **卡片 / 紧凑双视图**：标题栏新增视图按钮，紧凑视图一行一条（类型字形 + 标题 + 平台 + ▶ + 打开）；选择写入 `localStorage["web-scout-view"]`，刷新保留。
- 无缩略图的结果不再留空框，改为显示该类型的淡色字形（网 / 文 / 问 / 论 / 热 / 购 / 码 / 档 / 动 / ▶）。

### 修复
- 视图按钮文案改为「点了会去哪个视图」（卡片态显示「紧凑」、紧凑态显示「卡片」），原来显示的是当前视图，容易点反。
- 补丁脚本按精确字符串插入时被缩进漂移打空，改成正则锚点；另修掉视图按钮与关闭按钮 props 合并造成的 `SyntaxError: Unexpected token ')'`。

### 工程
- 客户端改动不需要重启 Host：`dsh-hmr` 会自动发布新 bundle，页面 `location.reload()` 即可。
- 新增截图 `docs/panel-views.png`（筛选 + 卡片视图）、`docs/panel-views-compact.png`（紧凑视图）。

## 1.9.0 — 2026-11-12

### 新增
- **结果卡片化**：结果行改成卡片——左侧 92×56 缩略图（无图显示类型字形）、中间标题 + `平台` `类型` `URL` + 两行摘要、右侧竖排动作按钮。
- **十种站点类型**：视频 / 文章 / 问答 / 论坛 / 榜单 / 商品 / 代码 / 文档 / 动态 / 网页。类型判定优先级：平台定义 `kind` → 自定义站点手选类型 → `inferKindFromUrl()` 按域名与路径猜 → 平台分组兜底。
- **面板内嵌播放 B 站视频**：`backends.bilibili` 与 `backends['bili-hot']` 现在返回 `embed`（`player.bilibili.com/player.html?bvid=…`）和 `thumb`；卡片上出现「播放 / 收起」，点开在卡片下方渲染 16:9 的 `iframe`，可全屏。
- 自定义站点表单新增「类型」下拉（`auto` 时交给域名推断），`platform.add` 与 `store.js` 会保存并校验该字段。
- `platformCatalog()` / `summarize()` 的平台条目新增 `kind`，客户端据此渲染类型标签。

### 修复
- **B 站卡片无图、不能播**：`backends.bilibili` 之前会带 store 里的旧 cookie（`SESSDATA`/`buvid3`），被 B 站搜索接口判风控（`-412`/`-352`）后两次重试都空，于是落到 `site:` 兜底——兜底行没有 `thumb`/`embed`。现在 `net.js` 支持 `noCookies` 开关，B 站搜索请求显式不带 cookie（接口本身是匿名的），实测 12 行全部带封面与 `embed`。

### 已知限制
- 抖音不出内嵌播放：`site:douyin.com` 只回站内入口行，`aweme/v1/web/general/search` 需要 `a_bogus` 签名，拿不到 `/video/<id>`；抖音卡片只有「打开」。

### 工程
- 新增离线脚本 `_probe/t93.mjs`（后端直调，检查 `thumb`/`embed`）、`_probe/t95.mjs`（无 cookie 复现）、`_probe/t96.mjs`（带 store cookie 复现 + 修复后回归）。
- README 新增「卡片与内嵌播放（v1.9）」小节与类型表、`noCookies` 维护坑；截图 `docs/panel-cards.png`。

## 1.8.0 — 2026-11-12

### 新增
- **五个热搜/榜单平台**（都是 `list: true`，不需要关键词）：
  | 平台 | 后端 | 数据源 | 条数 |
  | --- | --- | --- | --- |
  | 微博热搜 | `weibo-hot` | `weibo.com/ajax/side/hotSearch` | 50（带热度、热/新/沸标签） |
  | B站热门 | `bili-hot` | `api.bilibili.com/x/web-interface/ranking/v2` | 100（带播放/点赞/UP 主） |
  | 知乎热榜 | `zhihu-hot` | `/api/v3/feed/topstory/hot-lists/total` | 30（需要 `z_c0`） |
  | 百度热搜 | `baidu-hot` | `top.baidu.com/api/board` | 实时榜（嵌套 `cards[].content[].content`） |
  | 头条热榜 | `toutiao-hot` | `toutiao.com/hot-event/hot-board` | 50（带热水位与榜单序号） |
- 平台总数 41 → **46**；知乎热榜复用知乎登录态（`needsLogin: 'zhihu'`），未登录时状态药丸显示「需要登录：还没登录知乎…」。
- 面板提示：`platformCatalog()` 新增 `list` 标记，客户端据此判断「选中项全是榜单/信息流」，把输入框提示改成「榜单/信息流：不用输关键词，直接点搜索」，并在结果区上方补一行同样说明。

### 修复
- 平台推断：`inferPlatforms()` 增加「具体压过泛化」规则（`HINT_GENERIC`）——「微博热搜」只返回 `weibohot`，不再同时触发 `weibo`；同理 知乎热榜/推荐/关注 不再叠加 `zhihu`，B站热门不再叠加 `bilibili`。

### 工程
- README 的平台表、信息流小节、平台计数、安装校验示例全部同步；新增「榜单与信息流」对照表。
- 离线验证脚本：`_probe/t89.mjs`（五个榜单一次跑完）、`_probe/t90.mjs`（知乎热榜带 cookie）。

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