import { spawn } from 'node:child_process';

const SAFE = /^(https?|mailto):/i;

/** Open a URL in the desktop's default browser (or mail client). Returns the command used. */
export function openInBrowser(url) {
  const target = String(url || '').trim();
  if (!SAFE.test(target)) throw new Error('only http(s) URLs can be opened');
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'cmd';
    // `start` treats the first quoted argument as the window title.
    args = ['/c', 'start', '', target];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return { url: target, command: [command, ...args].join(' ') };
}