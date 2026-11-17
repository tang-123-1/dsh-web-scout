# 变更记录

## [1.27.0] - 2026-11-17

### 证据包 v2：原文引文（B3）

- `engines.js` 新增 `pickQuotes(text, query)`：切句 → 剔导航/cookie 噪声 → 只保留命中查询词的句子 → 按命中数取 1–2 句，单句超长截断加省略号。纯函数，可离线测。
- 新增 `enrichQuotes(items, {fetchPage, query, pages, ...})`：并发 3 抓前 `pages` 条正文，逐条填 `quote`/`quoteHits`；单条失败只记 `stats.errors`，不影响其它条与证据包本身。
- `api.js` 的 `evidence` 在打包后自动补引文（`quotes:false` 关闭），`quoteStats` 随结果返回；`formatEvidence()` 多一行「原文：「…」」。
- `store.js` 默认配置加 `quotes: true`、`quotePages: 3`。

### 修复（自测抓出来的）

- 拉丁字母也被拿去做 bigram（`co/or/rd/di/is`…），于是 `gardening` 这种无关句子也算「命中」→ 只保留含汉字的 bigram。
- 最短句长统一按 24 字符算，中文 12 字的完整句子会被整段丢掉（实测 4 个用例全空）→ 中文 12 字、英文 24 字符。

### 验证

- `node --test`：**28/28**（新增 `test/quotes.test.mjs` 9 项：英文命中、中文 bigram、无命中返回空、噪声剔除、长度上限与省略号、重复句去重、只抓前 N 条且单条失败不影响其它条、非 http 与已有引文跳过、`formatEvidence` 带引文）。
- `_probe/verify-quotes.mjs`（真实网络）：**5/5** —— 证据包给出引文（3 条结果 / 抓 2 篇 / 1 条有引文 / 718ms）、文本带「原文：」段、引文与原文逐字一致（忽略标点空白）、同段文本重复挑句结果稳定、`quotes:false` 不抓正文。

## [1.26.0] - 2026-11-17

### 浏览器渲染抓取（B1）

- 新增 `render.js`：复用插件自管浏览器的 CDP（同一 profile、同一登录态），开临时标签 → 导航 → 等正文稳定 → 取 DOM → 关标签。`renderHtml()` 只做这一件事，失败抛错，不吞。
- `engines.js` 新增 `renderPlatformRows()` / `extractRenderedRows()`：`entryOnly` 平台先试渲染，抽出站内锚点后按标题与 URL slug 过滤相关性；抽不到就退回「站内入口」行，并在 `note` 里写明是「渲染完成但没解析到结果」还是「渲染失败：原因」。
- 渲染预算：`renderPages`（默认 2）、`renderBudgetMs`（默认 16s），`render:false` 完全关掉；`renderHeadless` 可用无窗口模式渲染。
- 新增 op `render.check`（带 `url` 时真渲染一次，回 `htmlChars`/`anchors`/`tookMs`，用来排查某个站点为什么抽不到结果）。
- `store.js` 默认配置加 `render/renderPages/renderBudgetMs/renderHeadless`；`package.json` 的 `files` 加 `render.js`。

### 修复（自测抓出来的）

- 渲染结果最初会在「相关结果不足 3 条」时回落成整页锚点，把「关于我们 / 首页」当搜索结果。改为只回相关命中，空着退回入口行。
- `RENDER_SKIP_PATH` 只挡了 `/login` 一类路径，站内搜索页自己（`/search/...`）会被当成结果 → 补上 `search|s|so|query|results|find`。
- 首版固定 `settleMs` 取 DOM，SPA 结果还没填进来；改为「正文长度连续两次不变」才取，Gitee 从 0 条变 10 条。
- `renderStatus()` 同步包了 async 的 `browserStatus()`，`render.check` 永远回 `browser:""`、`running:false`（即使浏览器已经在跑）→ 改 async 并 `await`；测试加断言「可用时必须报出可执行文件路径」。

### 验证

- `node --test`：**19/19**（新增 `test/render.test.mjs` 8 项：站内过滤、追踪参数去重、无关查询返回空、当前页不自吞、`renderStatus` 结构、无站内地址报错、非 http 拒绝、entryOnly 平台都有 `browser()`）。
- `_probe/verify-render.mjs`（真浏览器）：**6/6** —— 浏览器可用、Gitee 10 条 / 56 锚点 / 2.3s、`runSearch` 走 `backend=render`、结果非入口行、博客园验证码场景干净退回 `backend=entry`、`render:false` 不渲染。
- `_probe/verify-render-op.mjs`（`render.check` 走真实 api 层）：**3/3** —— 无 url 只报状态（`browser=msedge.exe`、`running:true`、`port:12929`）、带 url 真渲染（40104 字符 / 105 锚点 / 2.0s）、非 http 被拒。
- `_probe/verify-render-headless.mjs`：**4/4** —— 关掉非 headless 会话 → `--headless=new` 拉起 → 渲染出 40104 字符 / 2.7s → state 记录新端口 → 用完关掉。

## [1.25.0] - 2026-11-17

### 话题追踪（B4）

- 新增 `watches` 状态：`{id, query, platforms, everyMinutes, minNew, lastRunAt, lastCount, lastNew, lastError, lastTop, seen[]}`，写进 `web-scout.json`，最多 12 个、每个最多记 400 条已见 URL。
- 新增 5 个 op：`watch.list / watch.add / watch.remove / watch.run / watch.clear`；`watch.run` 不带 id 时把当前到期的一次跑完。首轮只建基线（`first:true, added:0`），之后只回新增。
- 去重键 `watchKey()` 去掉 `#fragment` 与 `utm_*/spm/from/source/ref/scene` 参数并小写化，同一文章的不同追踪链接只算一条。
- 宿主每 60 秒 `tickWatches()`，到期才跑、一次最多 4 个，失败写 `lastError` 不中断其它 watch。
- Agent 工具 `web_scout_watch`（list/add/run/remove/clear）与 MCP 工具 `web_scout_watch`；system prompt 加一句「想持续盯一个话题就用 watch」。
- 面板第三个折叠区「追踪」：关键词 + 间隔 → 添加；每行显示上次运行、新增条数、错误，带运行/删除。

### 修复

- `ScoutStore` 构造函数同时接受文件路径字符串与 `{file}` 对象（之前传对象会让 `flush()` 静默失败）。
- watch 写入改为写穿（`patch` 后立刻 `flush()`），不再依赖 250 ms 防抖，退出即丢的风险消除。
- 某一轮没有新增时 `lastTop` 保留上一轮的高亮，面板不会突然空掉。

### 验证

- `_probe/verify-watch.mjs`（假检索）：**11/11**。
- `_probe/verify-watch-real.mjs`（真 bing 检索 + 落盘/重载）：**4/4**，首次 10 条 844 ms，二次 0 新增 661 ms。
- `_probe/verify-client-watch.mjs`（vm 里渲染挂件、强制展开追踪区）：**5/5**。
- `node --test`：11/11。

## [1.24.0] - 2026-11-17

### 工程化（A2 + A1）

- **tag 自动发布 npm**：`.github/workflows/release.yml` 在推 `v*` tag 时除了打包 Release 附件，还会 `npm publish --provenance --access public`；版本已存在则自动跳过，token 走仓库 secret `NPM_TOKEN`（不再依赖本地 7 天有效的 granular token）。
- **语法检查改为跟随仓库**：两个 workflow 都不再维护硬编码文件清单，改为 `git ls-files '*.js' '*.mjs'` 全量 `node --check`，新增文件（`cache.js`、`mcp/server.mjs`、`providers/*`、`test/*`）不会再漏检。
- **解析器夹具回归（新）**：`test/parsers.test.mjs` + `test/fixtures/`（11 个夹具）离线锁定 10 个后端与两个清洗函数的解析契约——必应自站过滤、360 桌面验证码自动切 `m.so.com` 并丢弃推荐位、百度 `mu` 真地址、头条 SSR script、微信中转壳标记、CSDN/掘金/V2EX/豆瓣/npm 字段映射。
- 新增 `npm test`（`node --test`），CI 与 release 都会跑；`test/` 不打进 npm 包（`files` 未包含）。

### 验证

- `node --test`：**11/11 通过**（首轮 1 红：CSDN 夹具误写成 `{code,data:{result_vos}}`，与真实响应 `{result_vos}` 不符，修夹具后转绿）。
- `git ls-files '*.js' '*.mjs'` 17 个文件 `node --check` 全过；两个 workflow YAML 结构校验通过。

## [1.23.0] - 2026-11-13

### 改名与 npm 发布

- 包名从 `@local/web-scout` 改为 **`dsh-web-scout`**：`package.json` 的 `name`、`client.js` 的 `__ModuleLoader__.load({ id })`、`index.js` 的 `PACKAGE_NAME`、`cordis.patch.yml` 的 `name` 同步（客户端 bundle id 必须等于包名，否则 `clientModules` 不会把它放进 `__DSH_BOOT__`）。
- 去掉 `private: true`，加 `publishConfig.access = "public"`，可以 `npm publish` 到公开 registry。
- 安装方式改为 `dsh plugin add dsh-web-scout`（npm 一行装）；仓库安装仍可用 `install_bundle`，只是依赖名变成 `dsh-web-scout`。
- README 顶部精简：一句话简介 + 4 条能力 + 8 条功能速览 + 2 张截图 + 安装三行，长表格挪到各自小节。

## [1.22.0] - 2026-11-13

### 空白站点治理

- 英文站点新增 `lang: 'en'`：查询含中文时自动换成拉丁变体（`hasCJK` + `platformQueryFor` 用 `latinVariant` 生成），Stack Overflow / Hacker News / PyPI / Medium / Reddit / YouTube / Amazon 都受益。实测 Stack Exchange API 用 `cordis 插件` 返回 0 条、用 `cordis plugin` 返回结果。
- 15 个没有服务端搜索的平台加 `entryOnly: true`（1688、亚马逊、博客园、Gitee、京东、开源中国、少数派、微博、闲鱼、小红书、抖音、Medium、PyPI、YouTube、Reddit）：不再白跑一次被忽略的 `site:` 查询，直接返回站内入口行，耗时从 700–900 ms 降到 **0–1 ms**，note 写明原因。
- 去掉 Stack Overflow / Hacker News 误标的 `needsTunnel`（它们的 API 在本机可达，之前被截到 6 秒还误报「需要代理」）。
- 新增按平台超时上限 `timeoutCap`：淘宝/今日头条 9 s、V2EX/微信 7 s、Stack Overflow 9 s、Hacker News 8 s——单站不再拖住整轮搜索。
- `platformCatalog()` 继续输出 `kind`，`runSearch` 的平台条目新增 `entryOnly` 标记。

### 验证

- `_probe/verify-122.mjs`：`stackoverflow`（中文查询）→ 空但不再报超时；`hackernews`（中文查询）→ 用英文变体拿到结果；`jd/douyin/weibo` → 0–1 ms 返回入口行。
- `_probe/verify-122b.mjs`：中文查询 `龙珠 孙悟空` 在 bing/zhihu/bilibili 行为不变，跨平台重复 0。
- 全量回归 13 套 + `selftest`（见 README「自测与修复」）。


本文件记录 `web-scout`（@local/web-scout）的功能演进。版本号遵循 `MAJOR.MINOR.PATCH`。

## 1.21.0

热榜趋势 + 跨榜共振：让「抖音热榜」这类平台不再只是一次性快照。

### 新增
- 榜单快照：`hotSnapshotOf` / `hotTrendOf` / `withHotTrend`，每平台保留最近一次 60 行，store 上限 8 个平台。
- 趋势字段：`extra.trend`（`isNew` / `rankDelta` / `hotDelta` / `rank`）与接口级 `trend` 摘要（每平台 `size/fresh/moved`）。
- 跨榜共振：`crossResonance`，同话题出现在多个榜单时写 `extra.resonance`。
- 面板徽标：新（黄）/`↑n`（绿）/`↓n`（灰）/「共振×n」；「加入对话」文本同步带「新上榜 · ↑3 · 第 2 名 · 共振」。

### 验证
- `verify-trend.mjs` 12/12（快照结构、名次与热度差、无历史不误标新、合并不覆盖原字段、共振正反例）。
- live：连打两次榜单 → 微博热搜 `fresh=1 moved=3`、24 行带趋势、2 行共振；关键词检索 `trend` 为空、结果不受影响。
## 1.20.0

自测套件 + 五个真 bug。

### 新增
- `scripts/selftest.mjs`：27 个 op 全覆盖的自测（`--heavy` 额外跑系统浏览器与插件浏览器），50/54 项断言。
- `browser.close` op：真正关掉插件自管的浏览器（CDP 关闭 + 进程兜底 + 清 state）。

### 修复
- 工具输出不是无损 JSON（`extra: undefined` 导致 `invalid output: value is not lossless JSON`）：`net.js` 新增 `plain()`，6 个工具统一走净化。
- 自定义站点 `kind` 白名单缺 `web`/`social`，选「网页」会被降级成文章。
- `login.clear` 缺 `loggedIn/note`，前端读不到判定结果。
- 插件浏览器关闭后进程残留、重复拉起多实例：用 `DevToolsActivePort` 复用，关闭时 `taskkill /F /T /PID` 兜底。

- `catalog` / `config` 不再返回明文 Cookie：改为 `cookieHosts`（域名 → 条数）与 `cookieCount`，响应体从 100+ KB 降到 11 KB。

### 验证
- 12 套离线/联网验收全绿（203 → 207 项）；`selftest` 54/54、`selftest --heavy` 58/58；`verify-plain` 9/9。

全平台连通性扫描（47 个 provider 逐个真打）之后的修复。

### 修复
- **360搜索**：桌面版 `so.com` 按 IP 直接返回验证码页，改为命中验证码时自动改打 `m.so.com`，解析 `res-list` 与 `m.so.com/jump?u=` 解出真实地址；顺带过滤 360 塞在结果流里的「其他人还搜 / 猜您关注」推荐链接。
- **npm**：本机 `registry.npmjs.org` 不可达导致每次 9 s 超时；改为与 `registry.npmmirror.com` **并发**请求、先回先用，实测 9 012 ms → 115 ms。
- **必应忽略 `site:`**：新增 `siteIgnored` 检测（某引擎返回 ≥3 条却 0 条命中该站即收手），纯站内平台不再白等 3 个引擎；note 改为「搜索引擎忽略了 site: 过滤（该站点不支持服务端检索），已给站内入口」。
- **新增三个真后端**：MDN 官方搜索 API、豆瓣 `subject_suggest` 联想接口、思否服务端渲染搜索页。

### 清理
- 删除开发期塞进 profile 的示例 provider（`web-scout-providers/demo.mjs`，id `wsdemo`）；仓库里的 `providers/example-provider.mjs` 保留作文档。

### 验证
- 扫描：修复前 ok 18 / empty 20 / blocked 5 / error 4，修复后 **ok 19 / empty 19 / blocked 5 / error 4**；360、npm、MDN、豆瓣、思否全部转出真实结果。
- live：`so360 4 条 835ms`、`npm 4 条 356ms`（体检 115ms）、`mdn "array map" 4 条 577ms`、`douban 龙珠 4 条 299ms`、`segmentfault 2 条 965ms`。

## 1.19.0

一次功能审计后的瘦身：只删真正没人走到的路径，行为不变。

### 移除

- **检索历史**（`history` / `clear` 两个 op、`store.record()`、`clearHistory()`、`store` 里的 `history` 字段）。面板与工具从来没有读过它，属于只写不读的死数据，还让每次搜索多一次落盘。
- **「本机导入」登录**（`login.import` op、面板按钮、`browserCookies.js` 里 Chromium/Firefox cookie 库解析约 200 行）。它要求先关掉浏览器（cookie 库被独占锁），实测每次都 EBUSY；现在登录只走「插件浏览器 → 读取登录」和「粘贴 Cookie」。`mergeCookies()` 保留。
- `engines.js` 的 `MOBILE_UA`（未被引用）与 `searchEvidence()`（api 直接调 `runSearch` + `packEvidence`，这个包装没人用）。
- `browserAuth.js` 的 `browserSessionInfo()`（被 `browserStatus()` 取代）与 `closeBrowserSession()`（没有任何调用方）。
- 客户端四条死文案：`sites`、`importCookie`、`importShort`、`importing`（后者改用了已有的 `browserStarting`）。

### 保留（有调用方，别误删）

- `providers/registry.js` 的 `validateProvider`、`engines.js` 的 `PROVIDERS` / `PLATFORM_LIST` / `BACKENDS`、`store.js` 的 `SCOUT_DEFAULTS`：测试与外部 provider 依赖它们。
- 46 个平台全部带 `backend` 或 `site`，没有「只是重复 bing」的空平台；`net.js` 的 `DEFAULT_UA` / `normalizeProxy` / `decodeBody` / `CookieJar` 只收起了 `export`，实现仍在用。

### 验证

- 离线：`verify-cache` 13/13、`verify-providers` 23/23、`verify-evidence` 19/19、`verify-plan` 22/22、`verify-research` 16/16、`verify-mcp` 24/24、`verify-mcp-117` 11/11、`verify-mcp-118` 10/10、`verify-mcp-robust` 10/10、`verify-mcp-tools` 7/7。
- live：`search` / `evidence` / `research` / `health.check` / `login.status` 全部正常；删掉的 `history`、`clear`、`login.import` 三个 op 按预期报未知操作。
## 1.18.0

路线图第 3 层「查询改写与路由 + Research Mode」：先把问题理解成一个计划，再按波次检索，够了就停。

### 新增

- **查询规划器**（`engines.js` 的 `planQuery` / `planWaves`）：
  - 意图判定（code / doc / academic / news / howto / compare / product / general），每类带一张平台路由表；查询里点名的站点排最前，其次显式 `platforms`，最后路由表。
  - 查询变体：原始 → 中文技术词转英文（36 条词表）→ 带域名补 `site:` → 代码 token 就地加引号；去重、上限 4。
  - 波次规划：主平台（前 4）→ 换说法（前 3）→ 补漏（其余）。
- **研究模式**（`research`）：每波前查时间预算（剩余 <1.5 s 记 `skipped: budget`）、跨波 `dedupeKey` 去重、每波用证据包评估质量门槛（`items` / `quorumPlatforms` / `quorumKinds`），达标提前停；单波异常只记 `round.error`，不整体失败；返回 `rounds[]`、`quality`、`pack` 与 `text` 研究报告。
- **接口**：`{"op":"plan"}` 与 `{"op":"research"}`（参数 `budgetMs` 3–60 s、`maxRounds` 1–3、`minItems`/`quorumPlatforms`/`quorumKinds`，缓存键含全部规划参数；空结果的报告不入缓存）。
- **Agent 工具**：`web_scout_research`（共 6 个工具）。
- **MCP 工具**：`web_scout_research`（共 6 个工具）。
- **面板**：标题栏「研究」按钮，跑完把研究报告塞进输入框，并显示「N 轮 · 达标/未达标」。

### 修复

- 空查询 + 纯榜单平台曾被规划器掺入关键词引擎，导致整波 0 条：`planQuery` 在 `feedFocus` 时不掺路由表，`feedOnly` 改用 `hintPlatforms || explicitPlatforms` 判定。
- 代码/文件 token 加引号时被挪到句首：改成就地替换；域名 token（TLD 白名单）不再被加引号。
- 空研究报告会写进缓存导致 6 小时内一直「没结果」：只在 `quality.items > 0` 时 `cache.set`。

### 测试

- `verify-plan.mjs` 22/22、`verify-research.mjs` 16/16（离线注入 `deps.search`）、`verify-research-live.mjs` 11/11、`verify-mcp-118.mjs` 10/10。
- 回归：`verify-mcp.mjs` 24/24、`verify-mcp-117.mjs` 11/11、`verify-mcp-robust.mjs` 10/10、`verify-mcp-tools.mjs` 7/7（读正文用例改本机可达的 `cn.bing.com`）。

## 1.17.0

路线图第 2 层「读取与证据」+ 第 4 层「连通性一键测试」的一部分：把结果变成可引用的材料，并让「哪条通道现在能用」先看清楚。

### 新增

- **证据包**（`engines.js` 的 `packEvidence` / `formatEvidence` / `searchEvidence`）：
  - 打分 `0.42×标题命中 + 0.22×摘要命中 + 0.16×原排名 + 0.12×后端质量 + 0.08×新鲜度`；同分按原顺序稳定排序。
  - 每平台配额（默认 3）+ 字符预算（默认 6000），超出进 `dropped.perPlatform` / `dropped.budget`，重复进 `dropped.duplicates`。
  - 摘录挑含查询词的句子（切句 + token/2-gram 命中），`excerptChars` 默认 240。
  - 产出 `items[]`（含 `score`/`excerpt`/`why`/`thumb`/`embed`）、`coverage[]`、`gaps[]`、`platformNotes`。
- **连通性体检**（`checkPlatforms` / `formatHealth`）：原生通道真打一次（`limit:2`），返回 `ok/empty/blocked/login/error` 与耗时；纯 `site:` 平台默认 `skipped`，`deep:true` 才真打；未知 id 记 `skipped.unknown`。
- **接口**：`POST /web-scout/api {"op":"evidence"}`（与 `search` 同样的 query/platform 推导，缓存键含预算与摘录参数）与 `{"op":"health.check"}`。
- **Agent 工具**：`web_scout_evidence`、`web_scout_health`（共 5 个工具）。
- **MCP 工具**：`web_scout_evidence`、`web_scout_health`（共 5 个工具）。
- **面板**：标题栏「证据包」把结果压成证据包直接放进输入框；站点分区「体检」按钮 + 每个平台前的状态点（绿/黄/红）与汇总行。

### 测试

- `verify-evidence.mjs` 19/19（去重、排序、配额、预算、摘录、缺口、榜单空 query、新鲜度、跳过规则）。
- `verify-evidence-live.mjs` 15/15（live 预算/缓存/榜单、体检三站真打、未知平台 skipped）。
- `verify-mcp-117.mjs` 11/11；回归 `verify-mcp.mjs` 24/24、`verify-mcp-robust.mjs` 10/10、`verify-mcp-tools.mjs` 7/7。

### 修的

- `refresh` 清缓存原先走 `cache.set(key, null, 1)`，会让下一次读取拿到 `null`；改为 `ScoutCache.forget(key)`。
- `checkPlatforms` 显式传入不存在的平台原先被静默忽略，现在进 `skipped[{reason:"unknown"}]`。

## 1.16.0 — 2026-11-13

**为什么改**：路线图第 3 步。插件的能力此前只对 DSH 内部可见（三个 agent 工具 + 面板 HTTP op）；要让别的宿主（Claude Desktop、Cursor、自己的脚本）也能用同一套检索，必须走标准协议。

### 新增
- `mcp/server.mjs`：零依赖的 MCP 服务，JSON-RPC 2.0 over stdio。支持协议 `2025-06-18` / `2025-03-26` / `2024-11-05`（客户端要新版本就回新版本，未知版本回落 `2024-11-05`），既能吃换行分隔 JSON（MCP 官方 stdio），也兼容 LSP 式 `Content-Length` 帧。
- 三个工具：
  - `web_scout_search`：`query`（榜单类可空）、`platforms`、`limit`、`pages`、`timeoutMs`、`refresh`；返回 `content[].text`（人读的清单）+ `structuredContent`（query/platforms/results/cached…）。
  - `web_scout_read`：`url`、`maxChars`；正文 + 标题 + 状态 + 是否截断 + 缓存命中信息。
  - `web_scout_providers`：平台/provider 清单、默认源、代理、缓存 TTL。
- 与面板完全共享配置（`~/.dsh/web-scout.json`）与缓存（`web-scout-cache.db`，WAL 支持多进程）；外部 provider（`<profile>/web-scout-providers/*.mjs`）在 MCP 侧同样可用。
- `cache.forget(key)`：refresh 需要的单条失效（此前只能整表 clear）。

### 验收
- `_probe/verify-mcp.mjs` **24/24**：握手/版本协商/ping/工具清单/未知工具/缺 query/providers/搜索/二次命中缓存/refresh 绕过/正文读取与缓存/非 http url/未知方法 -32601/坏 JSON 后仍存活/榜单空 query。
- `_probe/verify-mcp-robust.mjs` **10/10**：并发流水线 id 对齐、stdout 无非 JSON 噪音、stderr 有诊断、批量数组请求、stdin 关闭后 exit code 0、Content-Length 帧。
- `_probe/verify-mcp-tools.mjs` **7/7**：外部 provider `wsdemo` 可搜、未知平台回落默认源、`timeoutMs` 钳位、providers 负载字段、不可达域名返回 isError。

### 用法
```json
{ "mcpServers": { "web-scout": { "command": "node", "args": ["D:/dshcs/web-scout/mcp/server.mjs"] } } }
```

## 1.15.0 — 2026-11-13

**为什么改**：路线图第 2 步。`engines.js` 已经长到 2100 行，加一个站点要改核心文件、还要小心别碰坏翻页/过滤/缓存；谁想接自己的站都得读完整份源码。后端必须能被「外挂」。

### 新增
- `providers/registry.js`：provider 契约 + 注册表。字段 `id/label/kind/list/site/browser/search`，带静态校验（id 格式、label 必填、search|browser 至少一个、kind 白名单、source 白名单）。
- `providers/external.js`：从 `<profile>/web-scout-providers/*.mjs` 加载外部 provider。单文件上限 256 KB、最多 40 个，语法错误/校验失败/超时全部只记错误；每次 reload 带 `?v=<ts>` 真正重新 import。
- `runSearch` 改为「先查 provider，再回落旧分支」：内置 provider 转调原后端，行为与 v1.14 等价（有断言）；外部 provider 直接进同一套过滤、去重、缓存、翻页流程。
- 平台表可重建（`rebuildPlatformMap`）：外部 provider 自动进 `catalog.platforms`（`source:"external"`）、面板网格、`inferPlatforms` 所用平台集。
- HTTP op `provider.list`（清单 + 目录 + 错误）与 `provider.reload`（热加载，不用重启 Host）。
- `providers/example-provider.mjs`：最小可用示例（复制到 profile 目录即可试）。

### 修
- `platformCatalog()` 原来只遍历内置 `PLATFORM_LIST`，外部 provider 与自定义站点会漏出清单 → 改用 `PLATFORMS`。
- 工具 `web_scout_search` 首次执行会等 provider 初始化（最多 3s），避免首个搜索跑在旧平台表上。

### 验收
- `_probe/verify-providers.mjs` 23 项全通过（校验 4 项、注册表 5 项、外部加载 4 项、集成 10 项，含「provider 与直接调后端结果一致」等价性断言与「坏文件不影响好文件」）。
- `_probe/verify-providers-live.mjs` 12 项全通过：47 个 provider（46 内置 + 1 外部）、catalog 带 `source`、榜单标记仍在 8 个、外部 provider 可搜 3 条、内置 csdn/v2ex 正常、reload 幂等。
- `_probe/verify-providers-robust.mjs` 6 项全通过：现场塞入「坏 id」与「语法错误」两个文件，reload 报错但不掉平台、搜索照常，清理后错误归零。

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