import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, loadConfig } from '../../dist/exports.js';

/** A server on a random port with an in-memory database, as tests use it. */
export async function testServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-server-'));
  const config = loadConfig({
    HOPDESK_TOKEN_SECRET: 'a-test-secret-that-is-long-enough-to-be-accepted',
    HOPDESK_PORT: '0',
    HOPDESK_HOST: '127.0.0.1',
    HOPDESK_DATA_DIR: dataDir,
    HOPDESK_REGISTRATION_OPEN: 'true',
    ...env,
  });
  const logs = [];
  const server = await startServer({ config, databaseFile: ':memory:', log: m => logs.push(m) });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    ...server,
    base,
    logs,
    ws: `ws://127.0.0.1:${server.port}/ws`,
    async call(method, route, { body, token } = {}) {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}

/** A WebSocket client that collects messages, for the signalling tests. */
export function client(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.onmessage = event => {
    messages.push(JSON.parse(event.data));
    for (const waiter of waiters.splice(0)) waiter();
  };
  const open = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('websocket failed'));
  });
  const closed = new Promise(resolve => { socket.onclose = event => resolve({ code: event.code, reason: event.reason }); });
  return {
    socket, messages, open, closed,
    send: message => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    async next(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no matching message; saw ${JSON.stringify(messages)}`);
        await new Promise(resolve => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}
