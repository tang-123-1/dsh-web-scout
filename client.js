window.__ModuleLoader__.load({
  id: '@local/web-scout',
  factory: (require) => {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const NS = 'web-scout';
    const API = '/web-scout/api';
    const SLOT = 'conversation.composer.dock';
    const DEFAULT_CHIPS = ['auto', 'bing', 'zhihu', 'bilibili', 'douyin', 'csdn', 'juejin', 'github'];

    const TEXT = {
      'zh': {
        title: '联网检索',
        auto: '自动',
        placeholder: '输入关键词后回车；留空＝按当前对话内容检索',
        search: '搜索',
        searching: '检索中…',
        close: '关闭',
        open: '打开',
        panel: '联网检索结果',
        proxy: '代理（可选，如 127.0.0.1:7890）',
        save: '保存',
        saved: '已保存',
        empty: '还没有结果。输入关键词后按搜索；留空则按当前对话内容检索。',
        results: '条结果',
        blockedHint: '这些站点在服务端不可达，可直接在浏览器打开',
        browser: '在浏览器打开',
        error: '出错了',
        longHint: '查询取自上一条对话内容；想更精准可以在上方输入更短的关键词再搜一次。',
        dragHint: '按住这里拖动面板',
        resizeHint: '拖动右下角改变大小',
        sites: '站点',
        more: '站点',
        picker: '选择平台（点一下加入或移除，最多 10 个）',
        addSite: '添加站点',
        siteName: '名称，如 抖音',
        siteUrl: '搜索地址，用 {q} 占位',
        siteDomain: '限定域名，如 douyin.com',
        add: '添加',
        remove: '删除',
        loginSection: '登录与账号',
        login: '登录',
        importing: '导入中…',
        importCookie: '导入登录状态',
        importShort: '本机导入',
        browserLogin: '插件浏览器',
        captureLogin: '读取登录',
        browserStarting: '正在拉起插件浏览器…',
        browserReady: '插件浏览器已就绪，登录完点「读取登录」',
        capturing: '正在从插件浏览器读取 Cookie…',
        check: '检查',
        clearLogin: '清除',
        paste: '粘贴 Cookie',
        pasteHint: '浏览器 F12 → Application → Cookies，或 document.cookie 的内容',
        apply: '应用',
        loggedIn: '已登录',
        notLoggedIn: '未登录',
        noLogin: '未导入',
        loginHint: '点「插件浏览器」弹出一个独立 profile 的窗口，在里面登录一次，回来点「读取登录」就能读到（浏览器开着也能读）。「本机导入」是直接抓 Edge/Chrome 的 cookie 库，需要先关掉浏览器。',
        customGroup: '自定义站点',
        stale: '插件已更新到磁盘：重启一次 DeepSeek Harness 后「站点」和「登录」才会生效。',
      },
      en: {
        title: 'Web scout',
        auto: 'Auto',
        placeholder: 'Type a query, Enter to run (empty = this conversation)',
        search: 'Search',
        searching: 'Searching…',
        close: 'Close',
        open: 'Open',
        panel: 'Web scout results',
        proxy: 'Proxy (optional, e.g. 127.0.0.1:7890)',
        save: 'Save',
        saved: 'Saved',
        empty: 'No results yet. Type a query, or leave it empty to search this conversation.',
        results: 'results',
        blockedHint: 'Unreachable server-side — open them in your browser',
        browser: 'Open in browser',
        error: 'Failed',
        longHint: 'Query derived from the previous message — type a shorter keyword above to refine.',
        dragHint: 'Drag here to move the panel',
        resizeHint: 'Drag the corner to resize',
        sites: 'Sites',
        more: 'Sites',
        picker: 'Tap to add or remove (up to 10)',
        addSite: 'Add a site',
        siteName: 'Name, e.g. 抖音',
        siteUrl: 'Search URL with {q}',
        siteDomain: 'Restrict to domain, e.g. douyin.com',
        add: 'Add',
        remove: 'Remove',
        loginSection: 'Sign-in & accounts',
        login: 'Sign in',
        importing: 'Importing…',
        importCookie: 'Import session',
        importShort: 'Local import',
        browserLogin: 'Plugin browser',
        captureLogin: 'Read login',
        browserStarting: 'Launching the plugin browser…',
        browserReady: 'Plugin browser is ready — sign in, then hit "Read login"',
        capturing: 'Reading cookies from the plugin browser…',
        check: 'Check',
        clearLogin: 'Clear',
        paste: 'Paste cookie',
        pasteHint: 'DevTools → Application → Cookies, or the document.cookie text',
        apply: 'Apply',
        loggedIn: 'Signed in',
        notLoggedIn: 'Not signed in',
        noLogin: 'No session',
        loginHint:
          'Sign in on the site in your browser, then press “Import session”. If the import reports a locked database, close the browser windows first.',
        customGroup: 'Custom sites',
        stale: 'Plugin updated on disk — restart DeepSeek Harness once to enable sites and sign-in.',
      },
    };

    // Inline styles only: the dock cell lives in a shadow root and the panel is
    // portaled to <body>, so a single injected stylesheet cannot reach both.
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      line: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      base: 'var(--dsw-alias-bg-base)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
    };

    const S = {
      pill: {
        display: 'inline-flex',
        outline: 'none',
        alignItems: 'center',
        gap: '6px',
        height: '22px',
        padding: '0 9px',
        borderRadius: '999px',
        border: `1px solid ${C.line}`,
        background: 'transparent',
        color: C.dim,
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: '1',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      pillOn: { borderColor: C.brand, color: C.brand, background: C.layer2 },
      dot: { width: '6px', height: '6px', borderRadius: '50%', background: C.brand, flex: '0 0 auto' },
      dotBusy: { background: C.warn },
      count: {
        fontVariantNumeric: 'tabular-nums',
        color: C.text,
        background: C.layer2,
        borderRadius: '999px',
        padding: '1px 5px',
        fontSize: '10px',
      },
      panel: {
        position: 'fixed',
        zIndex: 2147482000,
        right: '20px',
        bottom: '96px',
        width: 'min(600px, calc(100vw - 40px))',
        maxHeight: 'min(70vh, 640px)',
        display: 'flex',
        flexDirection: 'column',
        background: C.layer1,
        border: `1px solid ${C.line2}`,
        borderRadius: '12px',
        boxShadow: '0 20px 56px rgba(0,0,0,.34)',
        overflow: 'hidden',
        fontFamily: 'inherit',
        fontSize: '12px',
        color: C.text,
        textAlign: 'left',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderBottom: `1px solid ${C.line}`,
        background: C.layer2,
      },
      headTitle: { flex: '1', minWidth: '0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      headSub: { fontWeight: 400, color: C.dim, marginLeft: '6px' },
      icon: {
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: C.dim,
        cursor: 'pointer',
        fontSize: '13px',
        lineHeight: '1',
        padding: '3px 5px',
        borderRadius: '5px',
        fontFamily: 'inherit',
      },
      form: { display: 'flex', gap: '8px', padding: '10px 12px 0' },
      input: {
        flex: '1',
        minWidth: '0',
        border: `1px solid ${C.line}`,
        background: C.base,
        color: C.text,
        borderRadius: '8px',
        padding: '7px 10px',
        fontSize: '12px',
        outline: 'none',
        fontFamily: 'inherit',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '9px 12px 0' },
      chip: {
        // 三段分开写：`border: 1px solid transparent` 是简写，React 在下一帧里
        // 只会清掉 borderColor（longhand），简写又被判为“没变化”而跳过，
        // 于是边框颜色回落到宿主全局 button 样式（白色）——这就是“取消选中还留白框”。
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'transparent',
        outline: 'none',
        boxShadow: 'none',
        background: 'transparent',
        color: C.dim,
        borderRadius: '999px',
        padding: '3px 10px',
        fontSize: '12px',
        lineHeight: '1.5',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
      },
      chipOn: { borderColor: C.brand, background: C.brand, color: C.base, fontWeight: '600' },
      block: {
        margin: '8px 12px 0',
        padding: '10px 12px',
        border: `1px solid ${C.line}`,
        borderRadius: '10px',
        background: C.layer1,
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
        maxHeight: '300px',
        overflow: 'auto',
      },
      blockTight: { maxHeight: '196px', gap: '7px', padding: '8px 10px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: '6px' },
      blockTitle: { fontSize: '11px', color: C.dim, letterSpacing: '0.02em' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      rowName: { fontSize: '12px', color: C.text, minWidth: '62px' },
      rowNote: { fontSize: '11px', color: C.dim, flex: '1 1 100%', lineHeight: '1.5' },
      mini: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'transparent',
        outline: 'none',
        boxShadow: 'none',
        background: C.layer2,
        color: C.dim,
        borderRadius: '7px',
        padding: '4px 9px',
        fontSize: '12px',
        lineHeight: '1.4',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'center',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      miniOn: { borderColor: C.brand, background: C.brand, color: C.base, fontWeight: '600' },
      miniAction: {
        border: `1px solid ${C.line}`,
        outline: 'none',
        background: 'transparent',
        color: C.dim,
        borderRadius: '6px',
        padding: '2px 7px',
        fontSize: '11px',
        lineHeight: '1.4',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      miniActionOn: { borderColor: C.brand, color: C.text },
      miniInput: {
        border: `1px solid ${C.line}`,
        background: C.base,
        color: C.text,
        borderRadius: '6px',
        padding: '5px 8px',
        fontSize: '12px',
        fontFamily: 'inherit',
        flex: '1 1 120px',
        minWidth: '90px',
        outline: 'none',
      },
      caret: {
        display: 'inline-block',
        width: '0',
        height: '0',
        borderLeft: '4px solid currentColor',
        borderTop: '3px solid transparent',
        borderBottom: '3px solid transparent',
        marginRight: '5px',
        verticalAlign: 'middle',
        transition: 'transform 140ms ease',
      },
      caretOpen: { transform: 'rotate(90deg)' },
      dotOk: { width: '6px', height: '6px', borderRadius: '50%', background: C.ok, display: 'inline-block' },
      dotOff: { width: '6px', height: '6px', borderRadius: '50%', background: C.line2, display: 'inline-block' },
      button: {
        border: `1px solid ${C.line}`,
        outline: 'none',
        background: C.layer2,
        color: C.text,
        borderRadius: '8px',
        padding: '6px 12px',
        fontSize: '12px',
        lineHeight: '1.4',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      },
      buttonPrimary: { borderColor: C.brand, color: C.brand, background: 'transparent' },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      body: {
        overflow: 'auto',
        padding: '10px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '64px',
      },
      status: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      grab: { cursor: 'move', userSelect: 'none' },
      resizeGrip: {
        position: 'absolute',
        right: '0px',
        bottom: '0px',
        width: '16px',
        height: '16px',
        cursor: 'nwse-resize',
        background: `linear-gradient(135deg, transparent 0 46%, ${C.line2} 46% 54%, transparent 54% 64%, ${C.line2} 64% 72%, transparent 72%)`,
        borderBottomRightRadius: '12px',
      },
      statusItem: {
        padding: '1px 7px',
        borderRadius: '999px',
        border: `1px solid ${C.line}`,
        fontSize: '11px',
        color: C.dim,
        display: 'inline-flex',
        gap: '5px',
        alignItems: 'center',
      },
      item: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderBottom: `1px solid ${C.line}` },
      itemMain: { flex: '1', minWidth: '0' },
      itemTitle: {
        color: C.text,
        fontWeight: 600,
        textDecoration: 'none',
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '12px',
      },
      itemUrl: {
        color: C.dim,
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        marginTop: '2px',
      },
      itemSnip: {
        color: C.dim,
        marginTop: '4px',
        lineHeight: '1.55',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      tag: {
        fontSize: '10px',
        color: C.dim,
        border: `1px solid ${C.line}`,
        borderRadius: '4px',
        padding: '0 4px',
        marginRight: '5px',
      },
      foot: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        borderTop: `1px solid ${C.line}`,
        padding: '8px 12px',
        background: C.layer2,
      },
      footInput: {
        flex: '1',
        minWidth: '0',
        border: `1px solid ${C.line}`,
        background: C.base,
        color: C.text,
        borderRadius: '6px',
        padding: '4px 8px',
        fontSize: '11px',
        outline: 'none',
        fontFamily: 'inherit',
      },
      hint: { color: C.dim, lineHeight: '1.6' },
      error: { color: C.bad, lineHeight: '1.5' },
    };

    // A focused <button> can pick up a white ring from the surrounding app CSS
    // (`:focus-visible` / box-shadow halos), which inline `outline: none` cannot
    // suppress. Strip both outline and shadow on every clickable style, and blur
    // after a click so nothing lingers.
    const NO_RING = { outline: 'none', boxShadow: 'none' };
    for (const key of ['chip', 'mini', 'miniAction', 'button', 'buttonPrimary', 'icon', 'pill', 'caret']) {
      if (S[key]) Object.assign(S[key], NO_RING);
    }

    function blurOnClick(event) {
      try {
        const target = event && event.currentTarget;
        if (target && typeof target.blur === 'function') target.blur();
      } catch (failure) {
        /* ignore */
      }
    }

    function statusStyle(status) {
      if (status === 'ok') return { color: C.ok, borderColor: C.ok };
      if (status === 'blocked') return { color: C.warn, borderColor: C.warn };
      if (status === 'error') return { color: C.bad, borderColor: C.bad };
      return null;
    }

    function merge(...parts) {
      return Object.assign({}, ...parts.filter(Boolean));
    }

    async function post(op, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ op: op }, payload || {})),
      });
      const body = await response.json().catch(() => undefined);
      if (!body || body.ok !== true) {
        const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return body.data;
    }

    let localeService;
    let translator;

    function activeDict() {
      let active = '';
      try {
        if (localeService && typeof localeService.getLocale === 'function') {
          const snapshot = localeService.getLocale();
          active = String((snapshot && snapshot.active) || '');
        }
      } catch {
        active = '';
      }
      return { id: active, dict: /^en/i.test(active) ? TEXT.en : TEXT.zh };
    }

    function translate(key) {
      if (translator) {
        try {
          const value = translator(key);
          if (value && value !== key) return value;
        } catch {
          /* ignore */
        }
      }
      const { dict } = activeDict();
      return dict[key] || key;
    }

    function useLocaleRevision() {
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined;
        try {
          return localeService.subscribe(() => setRevision((value) => value + 1));
        } catch {
          return undefined;
        }
      }, []);
      return revision;
    }

    function ScoutDock(props) {
      const revision = useLocaleRevision();
      const t = React.useMemo(() => translate, [revision]);
      const [query, setQuery] = React.useState('');
      const [selected, setSelected] = React.useState(['auto']);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [data, setData] = React.useState(null);
      const [panel, setPanel] = React.useState(false);
      const [catalog, setCatalog] = React.useState([]);
      const [proxy, setProxy] = React.useState('');
      const [proxyNote, setProxyNote] = React.useState('');
      const [hover, setHover] = React.useState('');
      const [chips, setChips] = React.useState(DEFAULT_CHIPS);
      const [stale, setStale] = React.useState(false);
      const [accounts, setAccounts] = React.useState({});
      const [customs, setCustoms] = React.useState([]);
      const [open, setOpen] = React.useState('');
      const toggleSection = (name) => setOpen((current) => (current === name ? '' : name));
      const [form, setForm] = React.useState({ name: '', url: '', site: '' });
      const [formNote, setFormNote] = React.useState('');
      const [busyId, setBusyId] = React.useState('');
      // 芯片增删是连点高频操作，用它给请求编号：迟到的旧响应不能覆盖最新状态，
      // 否则会出现「刚移除的站点，网格里还是白框高亮」的假象。
      const chipSeq = React.useRef(0);
      const [loginNote, setLoginNote] = React.useState({});
      const [pasteFor, setPasteFor] = React.useState('');
      const [pasteValue, setPasteValue] = React.useState('');
      const panelRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const sessionId = props && props.sessionId;

      // ── 面板几何：可拖动、可缩放，位置记在 localStorage，刷新后还在原处 ──
      const RECT_KEY = 'web-scout-panel-rect';
      const readRect = () => {
        const fallback = {
          x: Math.max(12, Math.min(window.innerWidth - 632, window.innerWidth - 620 - 24)),
          y: Math.max(12, Math.round(window.innerHeight * 0.12)),
          w: Math.min(620, window.innerWidth - 32),
          h: Math.min(560, Math.round(window.innerHeight * 0.62)),
        };
        try {
          const saved = JSON.parse(window.localStorage.getItem(RECT_KEY) || 'null');
          if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
            return {
              x: Math.min(Math.max(0, saved.x), Math.max(0, window.innerWidth - 240)),
              y: Math.min(Math.max(0, saved.y), Math.max(0, window.innerHeight - 120)),
              w: Math.max(380, Math.min(saved.w, window.innerWidth - 16)),
              h: Math.max(240, Math.min(saved.h, window.innerHeight - 16)),
            };
          }
        } catch {}
        return fallback;
      };
      const [rect, setRect] = React.useState(readRect);
      const gestureRef = React.useRef(null);
      const clampRect = (next) => {
        const w = Math.max(380, Math.min(next.w, window.innerWidth - 16));
        const h = Math.max(240, Math.min(next.h, window.innerHeight - 16));
        return {
          x: Math.max(-w + 160, Math.min(next.x, window.innerWidth - 160)),
          y: Math.max(0, Math.min(next.y, window.innerHeight - 60)),
          w: w,
          h: h,
        };
      };
      const startGesture = (mode) => (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (mode === 'move' && target && typeof target.closest === 'function' && target.closest('button, input, a, textarea')) return;
        event.preventDefault();
        gestureRef.current = { mode: mode, px: event.clientX, py: event.clientY, rect: rect };
        document.body.style.userSelect = 'none';
      };
      React.useEffect(() => {
        const onMove = (event) => {
          const gesture = gestureRef.current;
          if (!gesture) return;
          const dx = event.clientX - gesture.px;
          const dy = event.clientY - gesture.py;
          const base = gesture.rect;
          setRect(
            clampRect(
              gesture.mode === 'move'
                ? { x: base.x + dx, y: base.y + dy, w: base.w, h: base.h }
                : { x: base.x, y: base.y, w: base.w + dx, h: base.h + dy },
            ),
          );
        };
        const onUp = () => {
          if (!gestureRef.current) return;
          gestureRef.current = null;
          document.body.style.userSelect = '';
          setRect((current) => {
            try {
              window.localStorage.setItem(RECT_KEY, JSON.stringify(current));
            } catch {}
            return current;
          });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, []);


      const applyCatalog = (value) => {
        if (!value) return;
        setCatalog(Array.isArray(value.platforms) ? value.platforms : []);
        setChips(Array.isArray(value.chips) && value.chips.length > 0 ? value.chips : DEFAULT_CHIPS);
        setStale(!Array.isArray(value.chips));
        setAccounts(value.accounts || {});
        setCustoms(Array.isArray(value.customPlatforms) ? value.customPlatforms : []);
        if (value.config) setProxy(value.config.proxy || '');
      };

      React.useEffect(() => {
        let alive = true;
        post('catalog')
          .then((value) => {
            if (alive) applyCatalog(value);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      React.useEffect(() => {
        if (!panel) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setPanel(false);
        };
        // 面板是「可拖动/可缩放的窗口」，点外面就关掉太容易误触（拖到窗口边缘松手就没了），
        // 所以只保留 Esc 与右上角 ✕ 两种关闭方式。
        window.addEventListener('keydown', onKey);
        const timer = window.setTimeout(() => {
          if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus();
        }, 30);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.clearTimeout(timer);
        };
      }, [panel]);

      const labelOf = (id) => {
        if (id === 'auto') return t('auto');
        const found = catalog.find((item) => item.id === id);
        if (!found) return id.startsWith('custom:') ? id.slice(7) : id;
        return found.label || found.zh || found.en || id;
      };

      const loginTargets = React.useMemo(
        () => catalog.filter((item) => item.login && !item.custom),
        [catalog],
      );

      const refreshChips = async (nextChips) => {
        const seq = (chipSeq.current += 1);
        try {
          const value = await post('chips', { chips: nextChips });
          if (seq !== chipSeq.current) return;
          applyCatalog(value);
        } catch (failure) {
          if (seq !== chipSeq.current) return;
          setError(String((failure && failure.message) || failure));
        }
      };

      const addChip = (id) => {
        const next = chips.includes(id) ? chips : chips.concat(id).slice(0, 10);
        refreshChips(next);
        setSelected((current) => {
          if (id === 'auto') return ['auto'];
          const withoutAuto = current.filter((item) => item !== 'auto');
          return withoutAuto.includes(id) ? withoutAuto : withoutAuto.concat(id).slice(0, 6);
        });
      };

      // 点一下加入、再点一下移除：移除的是"芯片条里有没有这个站"，
      // 同时把它从本次选中里摘掉；全删空时回落到「自动」，避免发出空平台列表。
      const toggleChip = (id) => {
        const present = chips.includes(id);
        const nextChips = present ? chips.filter((item) => item !== id) : chips.concat(id).slice(0, 10);
        const safe = nextChips.length > 0 ? nextChips : ['auto'];
        setChips(safe);
        refreshChips(safe);
        setSelected((current) => {
          if (id === 'auto') return ['auto'];
          const withoutAuto = current.filter((item) => item !== 'auto');
          const next = present ? withoutAuto.filter((item) => item !== id) : withoutAuto.concat(id);
          const limited = next.slice(0, 6);
          return limited.length > 0 ? limited : ['auto'];
        });
      };

      const submitSite = async () => {
        setFormNote('');
        try {
          const value = await post('platform.add', { name: form.name, url: form.url, site: form.site });
          applyCatalog(value);
          const added = (value.customPlatforms || []).find((item) => item.name === form.name);
          setForm({ name: '', url: '', site: '' });
          setFormNote(t('saved'));
          if (added) addChip(added.id || `custom:${form.name}`);
        } catch (failure) {
          setFormNote(String((failure && failure.message) || failure));
        }
      };

      const removeSite = async (item) => {
        try {
          const value = await post('platform.remove', { id: item.id || '', name: item.name || '' });
          applyCatalog(value);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      };

      const noteFor = (id, message) => setLoginNote((current) => ({ ...current, [id]: message }));

      const doLogin = async (platform) => {
        setBusyId(`open:${platform}`);
        try {
          const value = await post('login.open', { platform });
          noteFor(platform, value.hint || `已打开登录页：${(value.target && value.target.url) || ''}`);
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const finishLogin = (platform, value) => {
        setAccounts((current) => ({
          ...current,
          [platform]: {
            loggedIn: value.loggedIn === true,
            name: value.name || '',
            note: value.note || '',
            checkedAt: value.checkedAt || '',
          },
        }));
        const extra = value.hint ? ` ${value.hint}` : '';
        const who = value.loggedIn ? `${t('loggedIn')}${value.name ? ` · ${value.name}` : ''}` : t('notLoggedIn');
        const via =
          value.source === 'browser'
            ? `｜插件浏览器读到 ${value.found || 0} 个 Cookie`
            : value.found
              ? `｜从 ${(value.imported || []).map((item) => item.label).join('/')} 读取 ${value.found} 个域名`
              : '';
        noteFor(platform, `${who}｜${value.note || ''}${via}${extra}`);
      };

      const doImport = async (platform) => {
        setBusyId(`import:${platform}`);
        noteFor(platform, t('importing'));
        try {
          finishLogin(platform, await post('login.import', { platform }));
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const doCheck = async (platform) => {
        setBusyId(`check:${platform}`);
        try {
          finishLogin(platform, await post('login.check', { platform }));
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const doBrowserLogin = async (platform) => {
        setBusyId(`browser:${platform}`);
        noteFor(platform, t('browserStarting'));
        try {
          const value = await post('login.browser', { platform });
          noteFor(platform, value.hint || t('browserReady'));
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const doCapture = async (platform) => {
        setBusyId(`capture:${platform}`);
        noteFor(platform, t('capturing'));
        try {
          finishLogin(platform, await post('login.capture', { platform }));
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const doClear = async (platform) => {
        try {
          await post('login.clear', { platform });
          setAccounts((current) => {
            const next = { ...current };
            delete next[platform];
            return next;
          });
          noteFor(platform, t('noLogin'));
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        }
      };

      const doPaste = async (platform) => {
        setBusyId(`paste:${platform}`);
        try {
          finishLogin(platform, await post('login.paste', { platform, cookie: pasteValue }));
          setPasteFor('');
          setPasteValue('');
        } catch (failure) {
          noteFor(platform, String((failure && failure.message) || failure));
        } finally {
          setBusyId('');
        }
      };

      const toggle = (id) => {
        setSelected((current) => {
          if (id === 'auto') return ['auto'];
          const next = current.filter((item) => item !== 'auto');
          if (next.includes(id)) {
            const left = next.filter((item) => item !== id);
            return left.length > 0 ? left : ['auto'];
          }
          return next.concat(id).slice(0, 6);
        });
      };

      const run = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          const value = await post('search', { query: query, platforms: selected, sessionId: sessionId });
          setData(value);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setBusy(false);
        }
      };

      const openUrl = async (url) => {
        setError('');
        try {
          await post('open', { url: url });
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      };

      const saveProxy = async () => {
        try {
          const value = await post('config', { patch: { proxy: proxy } });
          setProxy((value && value.proxy) || '');
          setProxyNote(t('saved'));
          window.setTimeout(() => setProxyNote(''), 1500);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      };

      const count = data && Array.isArray(data.results) ? data.results.length : 0;

      const pill = h(
        'button',
        {
          type: 'button',
          title: t('title'),
          style: merge(S.pill, panel || hover === 'pill' ? S.pillOn : null),
          onClick: () => setPanel((value) => !value),
          onMouseEnter: () => setHover('pill'),
          onMouseLeave: () => setHover(''),
        },
        h('span', { style: merge(S.dot, busy ? S.dotBusy : null) }),
        h('span', null, t('title')),
        count > 0 ? h('span', { style: S.count }, String(count)) : null,
      );

      let overlay = null;
      if (panel) {
        const rows = (data && data.results) || [];
        const platforms = (data && data.platforms) || [];
        const blockedRows = platforms.filter((item) => item.status !== 'ok' && item.browser);
        overlay = ReactDOM.createPortal(
          h(
            'div',
            { role: 'dialog', 'aria-label': t('panel'), ref: panelRef, style: merge(S.panel, { position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, right: 'auto', bottom: 'auto', width: `${rect.w}px`, height: `${rect.h}px`, maxHeight: 'none' }), 'data-ws-ring': 'off' },
            h(
              'div',
              { style: merge(S.head, S.grab), onMouseDown: startGesture('move'), title: t('dragHint') },
              h(
                'span',
                { style: S.headTitle },
                t('panel'),
                data ? h('span', { style: S.headSub }, `「${data.query}」 ${rows.length} ${t('results')}`) : null,
              ),
              h(
                'button',
                { type: 'button', title: t('close'), style: S.icon, onClick: () => setPanel(false) },
                '✕',
              ),
            ),
            h(
              'div',
              { style: S.form },
              h('input', {
                ref: inputRef,
                value: query,
                placeholder: t('placeholder'),
                style: S.input,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent && event.nativeEvent.isComposing)) {
                    event.preventDefault();
                    run();
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: run,
                  disabled: busy,
                  style: merge(S.button, S.buttonPrimary, busy ? S.buttonDisabled : null),
                },
                busy ? t('searching') : t('search'),
              ),
            ),
            h(
              'div',
              { style: S.chips },
              chips.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    title: id,
                    style: merge(S.chip, selected.includes(id) ? S.chipOn : null),
                    onClick: (event) => {
                      toggle(id);
                      blurOnClick(event);
                    },
                  },
                  labelOf(id),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: merge(S.chip, open === 'sites' ? S.chipOn : null),
                  onClick: (event) => {
                    toggleSection('sites');
                    blurOnClick(event);
                  },
                },
                h('span', { style: merge(S.caret, open === 'sites' ? S.caretOpen : null) }),
                t('more'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: merge(S.chip, open === 'login' ? S.chipOn : null),
                  onClick: (event) => {
                    toggleSection('login');
                    blurOnClick(event);
                  },
                },
                h('span', { style: merge(S.caret, open === 'login' ? S.caretOpen : null) }),
                t('loginSection'),
              ),
            ),
            stale ? h('div', { style: merge(S.hint, { padding: '2px 12px 0', color: C.warn }) }, t('stale')) : null,
            open === 'sites'
              ? h(
                  'div',
                  { style: S.block },
                  h('div', { style: S.blockTitle }, t('picker')),
                  h(
                    'div',
                    { style: S.grid },
                    catalog.map((item) =>
                      h(
                        'button',
                        {
                          key: item.id,
                          type: 'button',
                          title: item.backend || '',
                          style: merge(S.mini, chips.includes(item.id) ? S.miniOn : null),
                          onClick: (event) => {
                            toggleChip(item.id);
                            blurOnClick(event);
                          },
                        },
                        item.label || item.id,
                      ),
                    ),
                  ),
                  customs.length > 0
                    ? h(
                        'div',
                        null,
                        h('div', { style: S.blockTitle }, t('customGroup')),
                        customs.map((item) =>
                          h(
                            'div',
                            { key: `${item.name}|${item.url}`, style: S.row },
                            h('span', { style: S.rowName }, item.name),
                            h('span', { style: S.rowNote }, item.url),
                            h('button', { type: 'button', style: S.mini, onClick: () => removeSite(item) }, t('remove')),
                          ),
                        ),
                      )
                    : null,
                  h(
                    'div',
                    null,
                    h('div', { style: S.blockTitle }, t('addSite')),
                    h(
                      'div',
                      { style: S.row },
                      h('input', {
                        value: form.name,
                        placeholder: t('siteName'),
                        style: S.miniInput,
                        onChange: (event) => setForm({ ...form, name: event.target.value }),
                      }),
                      h('input', {
                        value: form.site,
                        placeholder: t('siteDomain'),
                        style: S.miniInput,
                        onChange: (event) => setForm({ ...form, site: event.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { style: S.row },
                      h('input', {
                        value: form.url,
                        placeholder: t('siteUrl'),
                        style: S.miniInput,
                        onChange: (event) => setForm({ ...form, url: event.target.value }),
                      }),
                      h(
                        'button',
                        { type: 'button', style: merge(S.mini, S.miniOn), onClick: submitSite },
                        t('add'),
                      ),
                    ),
                    formNote ? h('div', { style: S.rowNote }, formNote) : null,
                  ),
                )
              : null,
            open === 'login'
              ? h(
                  'div',
                  { style: merge(S.block, S.blockTight) },
                  h('div', { style: S.blockTitle }, t('loginSection')),
                  loginTargets.map((item) => {
                    const account = accounts[item.id];
                    const value = loginNote[item.id];
                    const busyHere = busyId.endsWith(`:${item.id}`);
                    return h(
                      'div',
                      { key: item.id, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                      h(
                        'div',
                        { style: merge(S.row, { flexWrap: 'nowrap' }) },
                        h('span', { style: account && account.loggedIn ? S.dotOk : S.dotOff }),
                        h('span', { style: { fontSize: '12px', color: C.text } }, item.label),
                        h(
                          'span',
                          {
                            style: {
                              fontSize: '11px',
                              color: account && account.loggedIn ? C.ok : C.dim,
                              flex: '1 1 auto',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          account
                            ? `${account.loggedIn ? t('loggedIn') : t('notLoggedIn')}${account.name ? ` · ${account.name}` : ''}`
                            : t('noLogin'),
                        ),
                      ),
                      h(
                        'div',
                        { style: S.row },
                        h('button', { type: 'button', style: S.miniAction, disabled: busyHere, onClick: () => doLogin(item.id) }, t('login')),
                        h(
                          'button',
                          { type: 'button', style: S.miniAction, disabled: busyHere, onClick: () => doBrowserLogin(item.id) },
                          busyHere ? t('importing') : t('browserLogin'),
                        ),
                        h('button', { type: 'button', style: S.miniAction, disabled: busyHere, onClick: () => doCapture(item.id) }, t('captureLogin')),
                        h(
                          'button',
                          { type: 'button', style: S.miniAction, disabled: busyHere, onClick: () => doImport(item.id) },
                          t('importShort'),
                        ),
                        h('button', { type: 'button', style: S.miniAction, disabled: busyHere, onClick: () => doCheck(item.id) }, t('check')),
                        h('button', { type: 'button', style: S.miniAction, onClick: () => doClear(item.id) }, t('clearLogin')),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: merge(S.miniAction, pasteFor === item.id ? S.miniActionOn : null),
                            onClick: () => {
                              setPasteFor(pasteFor === item.id ? '' : item.id);
                              setPasteValue('');
                            },
                          },
                          t('paste'),
                        ),
                      ),
                      pasteFor === item.id
                        ? h(
                            'div',
                            { style: S.row },
                            h('input', {
                              value: pasteValue,
                              placeholder: `${item.domain || ''} · ${t('pasteHint')}`,
                              style: S.miniInput,
                              onChange: (event) => setPasteValue(event.target.value),
                            }),
                            h('button', { type: 'button', style: merge(S.miniAction, S.miniActionOn), onClick: () => doPaste(item.id) }, t('apply')),
                          )
                        : null,
                      value ? h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: '1.5' } }, value) : null,
                    );
                  }),
                  h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: '1.5' } }, t('loginHint')),
                )
              : null,
            h(
              'div',
              { style: merge(S.body, { flex: '1', minHeight: '0' }) },
              error ? h('div', { style: S.error }, `${t('error')}: ${error}`) : null,
              platforms.length > 0
                ? h(
                    'div',
                    { style: S.status },
                    platforms.map((item) =>
                      h(
                        'span',
                        { key: item.id, title: item.note || '', style: merge(S.statusItem, statusStyle(item.status)) },
                        h('span', null, item.label),
                        item.count ? h('span', null, String(item.count)) : null,
                      ),
                    ),
                  )
                : null,
              !data && !error ? h('div', { style: S.hint }, t('empty')) : null,
              data && data.query && data.query.length > 40 ? h('div', { style: S.hint }, t('longHint')) : null,
              data && rows.length === 0 ? h('div', { style: S.hint }, t('empty')) : null,
              rows.map((item) =>
                h(
                  'div',
                  { key: `${item.url}|${item.title}`, style: S.item },
                  h(
                    'div',
                    { style: S.itemMain },
                    h(
                      'a',
                      {
                        href: item.url,
                        target: '_blank',
                        rel: 'noreferrer',
                        style: S.itemTitle,
                        onClick: (event) => {
                          event.preventDefault();
                          openUrl(item.url);
                        },
                      },
                      item.title || item.url,
                    ),
                    h('div', { style: S.itemUrl }, h('span', { style: S.tag }, item.platformLabel || item.platform), item.url),
                    item.snippet ? h('div', { style: S.itemSnip }, item.snippet) : null,
                  ),
                  h('button', { type: 'button', style: S.button, onClick: () => openUrl(item.url) }, t('open')),
                ),
              ),
              blockedRows.length > 0
                ? h(
                    'div',
                    null,
                    h('div', { style: merge(S.hint, { marginBottom: '4px' }) }, t('blockedHint')),
                    blockedRows.map((item) =>
                      h(
                        'div',
                        { key: item.id, style: S.item },
                        h('div', { style: S.itemMain }, h('div', null, `${item.label} · ${item.note || item.status}`)),
                        h('button', { type: 'button', style: S.button, onClick: () => openUrl(item.browser) }, t('browser')),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { style: S.foot },
              h('input', {
                value: proxy,
                placeholder: t('proxy'),
                style: S.footInput,
                onChange: (event) => setProxy(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') saveProxy();
                },
              }),
              h('button', { type: 'button', style: S.button, onClick: saveProxy }, proxyNote || t('save')),
            ),
            h('div', { style: S.resizeGrip, title: t('resizeHint'), onMouseDown: startGesture('resize') }),
          ),
          document.body,
        );
      }

      return h(React.Fragment, null, pill, overlay);
    }

    const inject = ['slots'];

    function apply(ctx) {
      try {
        localeService = ctx.get('locale');
        if (localeService && typeof localeService.register === 'function') {
          localeService.register(NS, 'zh-CN', TEXT.zh);
          localeService.register(NS, 'zh', TEXT.zh);
          localeService.register(NS, 'en', TEXT.en);
          localeService.register(NS, 'en-US', TEXT.en);
        }
        if (localeService && typeof localeService.bind === 'function') translator = localeService.bind(NS);
      } catch {
        localeService = undefined;
      }
      // HMR 会重新执行本 bundle：先把上一代注册摘掉，否则 dock 里会挂两棵树，
      // 面板叠在一起、状态互相打架（看起来就像「移除了还高亮」）。
      try {
        if (typeof window.__webScoutDispose === 'function') window.__webScoutDispose();
      } catch {}
      // 宿主全局 CSS 给 button 加了 :hover/:focus-visible 的白色光环（带 !important），
      // inline style 压不住，只能自己插一条更高优先级的规则。面板是 portal 到 body 的，
      // 用 document.head 的样式表才有效（ctx.styles.insert 作用域在 shadow root 内）。
      installRingCss();
      ctx.effect(() =>
        ctx.slots.inject(SLOT, () => {
          const dispose = ctx.slots.register({ name: SLOT, id: 'web-scout', order: 6 }, ScoutDock);
          window.__webScoutDispose = () => {
            try {
              if (typeof dispose === 'function') dispose();
            } catch {}
          };
          return dispose;
        }),
      );
    }

    function installRingCss() {
      try {
        const id = 'web-scout-ring-css';
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = [
          '[data-ws-ring="off"],',
          '[data-ws-ring="off"] * ,',
          '[data-ws-ring="off"] button:hover,',
          '[data-ws-ring="off"] button:focus,',
          '[data-ws-ring="off"] button:focus-visible,',
          '[data-ws-ring="off"] button:focus-within,',
          '[data-ws-ring="off"] button:active {',
          '  outline: none !important;',
          '  box-shadow: none !important;',
          '  -webkit-tap-highlight-color: transparent !important;',
          '}',
        ].join('\n');
        document.head.appendChild(style);
      } catch (failure) {
        /* ignore */
      }
    }

    return { inject: inject, apply: apply, ScoutDock: ScoutDock };
  },
});