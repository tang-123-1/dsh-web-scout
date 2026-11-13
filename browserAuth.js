// 插件自管的浏览器会话：用一个独立 profile 启动 Chromium（Edge/Chrome），
// 通过 DevTools 协议（CDP）读取该会话里的 Cookie——浏览器开着也能读，
// 不需要拷 cookie 库、不需要 DPAPI 解密、不会碰用户日常浏览器。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CDP_TIMEOUT = 9000;
const LAUNCH_TIMEOUT = 15000;

function homeRoot() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  if (process.env.DSH_HOME) {
    const profile = process.env.DSH_PROFILE || 'desktop';
    return path.join(process.env.DSH_HOME, 'profiles', profile);
  }
  return path.join(os.homedir(), '.dsh');
}

export function profileDir() {
  return path.join(homeRoot(), 'web-scout-browser');
}

function statePath() {
  return path.join(profileDir(), 'session.json');
}

export function browserCandidates() {
  if (process.platform === 'darwin') {
    const home = os.homedir();
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
  }
  if (process.platform !== 'win32') {
    return [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
  }
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.WEB_SCOUT_BROWSER || '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ];
  return list.filter(Boolean);
}

export function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function cdpVersion(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(value) {
  try {
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(value, null, 2));
  } catch {
    /* ignore */
  }
}

function cdpCall(wsUrl, method, params = {}, timeoutMs = CDP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new Error('CDP 调用超时'));
    }, timeoutMs);
    const done = (fn, value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      fn(value);
    };
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method, params }));
      } catch (error) {
        done(reject, error);
      }
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error) done(reject, new Error(message.error.message || 'CDP 错误'));
      else done(resolve, message.result);
    };
    socket.onerror = () => done(reject, new Error('CDP 连接失败'));
  });
}

async function waitForCdp(port, deadline) {
  while (Date.now() < deadline) {
    const version = await cdpVersion(port);
    if (version && version.webSocketDebuggerUrl) return version;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return null;
}

/**
 * 启动（或复用）插件自管的浏览器。
 * @param {{url?: string, headless?: boolean}} options
 */
export async function ensureBrowserSession(options = {}) {
  const dir = profileDir();
  const state = readState();
  if (state && state.port) {
    const version = await cdpVersion(state.port);
    if (version && version.webSocketDebuggerUrl) {
      if (options.url) await openTab(state.port, options.url);
      return { port: state.port, profile: dir, reused: true, browser: state.browser || '', version: version.Browser };
    }
  }

  const exe = findBrowser();
  if (exe === '') throw new Error('没找到 Edge/Chrome，可用环境变量 WEB_SCOUT_BROWSER 指定可执行文件路径');
  const port = await freePort();
  const args = [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msEdgeDiscover',
    '--disable-sync',
    '--disable-background-networking',
  ];
  if (options.headless) args.push('--headless=new');
  args.push(options.url || 'about:blank');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const version = await waitForCdp(port, Date.now() + LAUNCH_TIMEOUT);
  if (!version) throw new Error('浏览器已经拉起，但调试端口没响应（可能被安全软件拦了）');
  writeState({ port, pid: child.pid, browser: exe, at: new Date().toISOString(), profile: dir });
  return { port, profile: dir, reused: false, browser: exe, version: version.Browser };
}

async function openTab(port, url) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  } catch {
    /* ignore */
  }
}

function normalizeDomain(host) {
  return String(host || '')
    .replace(/^\./, '')
    .toLowerCase();
}

function domainMatches(cookieDomain, domain) {
  const clean = normalizeDomain(cookieDomain);
  const want = normalizeDomain(domain);
  if (clean === '' || want === '') return false;
  return clean === want || clean.endsWith(`.${want}`);
}

/**
 * 从插件自管浏览器里抓某个站点的 Cookie。
 * @param {{domain: string, port?: number}} options
 */
export async function captureBrowserCookies(options = {}) {
  const domain = normalizeDomain(options.domain);
  if (domain === '') throw new Error('这个站点没有可识别的域名');
  let port = options.port;
  if (!port) {
    const state = readState();
    if (state && state.port) port = state.port;
  }
  if (!port) {
    const session = await ensureBrowserSession({});
    port = session.port;
  }
  const version = await cdpVersion(port);
  if (!version || !version.webSocketDebuggerUrl) {
    throw new Error('插件浏览器没在运行：先点「插件浏览器」打开登录窗口');
  }

  let result;
  try {
    result = await cdpCall(version.webSocketDebuggerUrl, 'Storage.getCookies', {});
  } catch (error) {
    result = await cdpCall(version.webSocketDebuggerUrl, 'Network.getAllCookies', {}).catch(() => {
      throw error;
    });
  }
  const all = Array.isArray(result && result.cookies) ? result.cookies : [];
  const matched = all.filter((cookie) => cookie && domainMatches(cookie.domain, domain));
  const grouped = {};
  for (const cookie of matched) {
    const host = normalizeDomain(cookie.domain) || domain;
    const pair = `${cookie.name}=${cookie.value}`;
    grouped[host] = grouped[host] ? `${grouped[host]}; ${pair}` : pair;
  }
  return {
    domain,
    port,
    total: all.length,
    count: matched.length,
    names: matched.map((cookie) => cookie.name).slice(0, 16),
    cookies: grouped,
  };
}

export async function browserStatus() {
  const base = { profile: profileDir(), browser: findBrowser() };
  const state = readState();
  if (!state || !state.port) return { running: false, ...base };
  const version = await cdpVersion(state.port);
  if (!version || !version.webSocketDebuggerUrl) {
    return { running: false, stale: true, lastPort: state.port, ...base };
  }
  return { running: true, ...base, port: state.port, pid: state.pid, version: version.Browser };
}