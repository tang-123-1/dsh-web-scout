import { ensureBrowserSession, findBrowser, browserStatus } from './browserAuth.js';

/**
 * 渲染抓取（v1.26 / B1）
 *
 * 有一批站点只对真浏览器给内容：搜索页是 SPA、接口要签名、或者要过一遍 JS 才出结果。
 * 之前这些平台在 `entryOnly` 里只回一条「去站内搜」的入口。这里补上真渲染：
 * 复用插件自管的 CDP 浏览器（同一个 profile，登录态一致），开一个临时标签，
 * 等页面稳定后把 DOM 序列化出来，交给上游用 parseAnchors 解析。
 *
 * 设计约束：
 * - 只在确有必要时渲染：调用方负责预算（每次搜索最多 2 个平台、总计 ~16s）。
 * - 临时标签用完即关（/json/close/{id}），不污染用户自己开着的标签。
 * - 任何失败都抛 Error，调用方退回 entryOnly 的入口行，不整体失败。
 */

const TARGET_TIMEOUT = 8000;
const DEFAULT_SETTLE = 700;
const DEFAULT_TIMEOUT = 9000;

export function renderAvailable() {
  try {
    return findBrowser() !== '';
  } catch {
    return false;
  }
}

export async function renderStatus() {
  const available = renderAvailable();
  let browser = '';
  try {
    const status = await browserStatus();
    if (status && typeof status === 'object') {
      browser = status.browser || status.exe || '';
      return { available, browser, running: status.running === true, port: status.port || 0, profile: status.profile || '' };
    }
  } catch {
    /* ignore */
  }
  return { available, browser, running: false, port: 0, profile: '' };
}

async function jsonList(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const list = await response.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 新开一个空白标签，返回它的 target（含 webSocketDebuggerUrl）。 */
async function createTarget(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(TARGET_TIMEOUT),
    });
    if (response.ok) {
      const target = await response.json();
      if (target && target.webSocketDebuggerUrl) return target;
    }
  } catch {
    /* 老版本 Chrome 只认 GET，下面兜底 */
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { signal: AbortSignal.timeout(TARGET_TIMEOUT) });
    if (response.ok) {
      const target = await response.json();
      if (target && target.webSocketDebuggerUrl) return target;
    }
  } catch {
    /* ignore */
  }
  const list = await jsonList(port);
  const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error('浏览器没有可用的页面 target');
  return page;
}

async function closeTarget(port, id) {
  if (!id) return;
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { method: 'PUT', signal: AbortSignal.timeout(1500) });
  } catch {
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(1500) });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 一个最小的 CDP 会话：只做得到的四件事 —— 开页、导航、等稳定、取 HTML。
 * @param {string} wsUrl
 * @param {number} timeoutMs
 */
function openSession(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    let closed = false;

    const fail = (error) => {
      if (closed) return;
      closed = true;
      for (const [, item] of pending) item.reject(error);
      pending.clear();
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(error);
    };

    const timer = setTimeout(() => fail(new Error('渲染超时')), timeoutMs);

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        if (closed) {
          rej(new Error('渲染会话已关闭'));
          return;
        }
        const id = ++nextId;
        pending.set(id, { resolve: res, reject: rej });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          rej(error);
        }
      });

    const once = (method) =>
      new Promise((res) => {
        const list = listeners.get(method) || [];
        list.push(res);
        listeners.set(method, list);
      });

    socket.onopen = () => {
      resolve({
        send,
        once,
        close: () => {
          closed = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        },
      });
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message || 'CDP 错误'));
        else item.resolve(message.result);
        return;
      }
      if (message.method) {
        const list = listeners.get(message.method);
        if (list && list.length > 0) {
          listeners.delete(message.method);
          for (const fn of list) fn(message.params);
        }
      }
    };

    socket.onerror = () => fail(new Error('CDP 连接失败'));
    socket.onclose = () => {
      if (!closed) fail(new Error('CDP 连接被关闭'));
    };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 渲染一个 URL，返回最终 DOM 的 outerHTML 与落地 URL。
 * @param {string} url
 * @param {{timeoutMs?: number, settleMs?: number, waitForText?: number, port?: number}} options
 */
export async function renderHtml(url, options = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('renderHtml 需要一个 http(s) 地址');
  const timeoutMs = Math.min(20000, Math.max(3000, Number(options.timeoutMs) || DEFAULT_TIMEOUT));
  const settleMs = Math.min(4000, Math.max(0, Number(options.settleMs ?? DEFAULT_SETTLE)));
  const minText = Math.max(0, Number(options.waitForText) || 160);

  const session = await ensureBrowserSession({ headless: options.headless === true });
  const port = Number(options.port) || session.port;
  if (!port) throw new Error('浏览器调试端口不可用');

  const started = Date.now();
  const targetInfo = await createTarget(port);
  const cdp = await openSession(targetInfo.webSocketDebuggerUrl, timeoutMs);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: target });

    const budgetLeft = () => timeoutMs - (Date.now() - started);
    await Promise.race([loaded, sleep(Math.max(500, budgetLeft() - 1500))]);

    let html = '';
    let finalUrl = target;
    const deadline = Date.now() + Math.max(1500, Math.min(settleMs + 4000, budgetLeft()));
    let lastLen = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      const probe = await cdp
        .send('Runtime.evaluate', {
          expression: `(() => { const t = document.body ? document.body.innerText.trim().length : 0; return { ready: document.readyState, text: t, href: location.href, anchors: document.querySelectorAll('a[href]').length }; })()`,
          returnByValue: true,
        })
        .catch(() => null);
      const value = probe && probe.result ? probe.result.value : null;
      if (value && value.href) finalUrl = value.href;
      if (value && value.ready === 'complete' && value.text >= minText) {
        // SPA 的结果常常在 load 之后才填进来：文本长度连续两次不变才认为稳定。
        if (value.text === lastLen) stable += 1;
        else stable = 0;
        lastLen = value.text;
        if (stable >= 2) {
          const got = await cdp
            .send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
            .catch(() => null);
          html = got && got.result ? String(got.result.value || '') : '';
          if (html.length > 500) break;
        }
      }
      await sleep(300);
    }

    if (html === '') {
      const got = await cdp
        .send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
        .catch(() => null);
      html = got && got.result ? String(got.result.value || '') : '';
    }
    if (html === '') throw new Error('渲染完成但没拿到 HTML');
    return { html, url: finalUrl, port, tookMs: Date.now() - started, targetId: targetInfo.id || '' };
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
    await closeTarget(port, targetInfo.id);
  }
}