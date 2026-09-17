/**
 * Drives the real Electron app for integration tests.
 *
 * The app is started exactly as a user starts it (`electron dist/main.js`), with
 * Chromium's remote debugging port enabled, and the renderer is controlled
 * through the DevTools protocol. No test hooks live in the application itself.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(here, '../..');

/** Why the Electron tests cannot run here, or null when they can. */
export function electronUnavailableReason() {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'no DISPLAY or WAYLAND_DISPLAY';
  if (typeof WebSocket !== 'function') return 'this Node has no global WebSocket (Node 22+ needed)';
  try {
    createRequire(import.meta.url)('electron');
  } catch {
    return 'the electron package is not installed';
  }
  return null;
}

export async function launchApp({ env = {}, dataDir } = {}) {
  const electronBinary = createRequire(import.meta.url)('electron');
  const xdg = dataDir ?? await mkdtemp(path.join(tmpdir(), 'hopdesk-e2e-'));

  const childEnv = { ...process.env, XDG_DATA_HOME: xdg, ...env };
  // Set by VS Code's integrated terminal; it turns Electron into plain Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBinary,
    [path.join(desktopDir, 'dist/main.js'), '--remote-debugging-port=0'],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron did not start:\n${output}`)), 20_000);
    const scan = chunk => {
      output += chunk;
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited ${code}:\n${output}`)); });
  });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
  }, 15_000, 'the HopDesk window never appeared');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const app = {
    child, cdp, dataDir: xdg,
    get output() { return output; },

    /** Evaluates an async expression in the renderer and returns its value. */
    async eval(expression) {
      const res = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true, returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`renderer threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      }
      return res.result.value;
    },

    async waitFor(expression, timeoutMs = 10_000, what = expression) {
      return waitFor(async () => app.eval(expression), timeoutMs, `timed out waiting for: ${what}`);
    },

    async close() {
      cdp.close();
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise(r => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); });
    },
  };

  // The renderer script is a module and loads asynchronously.
  await app.waitFor('return document.readyState === "complete" && window.__hopdeskReady === true',
    15_000, 'renderer initialisation');
  return app;
}

export async function waitFor(fn, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { lastError = err; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${message}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('DevTools websocket failed'));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      close() { ws.close(); },
    });
  });
}
