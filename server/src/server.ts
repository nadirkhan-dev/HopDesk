import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.js';
import { Store } from './store.js';
import { Api } from './api.js';
import { Presence } from './presence.js';
import { SignalingServer } from './signaling.js';

/**
 * The self-hosted HopDesk server: an account API and a rendezvous for computers
 * that cannot reach each other directly.
 *
 * It speaks plain HTTP and expects a reverse proxy in front of it for TLS, which
 * is what the bundled Docker Compose sets up. Nothing here needs to see a
 * session's contents, so nothing here can.
 */

export interface RunningServer {
  port: number;
  store: Store;
  presence: Presence;
  api: Api;
  close(): Promise<void>;
}

export interface StartOptions {
  config: ServerConfig;
  /** ':memory:' in tests. */
  databaseFile?: string;
  log?: (message: string) => void;
  now?: () => number;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? (message => process.stdout.write(`${new Date().toISOString()} ${message}\n`));
  const store = new Store(opts.config.dataDir, opts.databaseFile);
  const presence = new Presence(opts.now);
  const api = new Api({ config: opts.config, store, presence, log, ...(opts.now ? { now: opts.now } : {}) });
  const signaling = new SignalingServer({ store, api, presence, log, ...(opts.now ? { now: opts.now } : {}) });

  store.pruneRefresh(Date.now());

  const http: Server = createServer((req, res) => {
    void api.handle(req, res);
  });
  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    signaling.handleUpgrade(req, socket, head);
  });
  // A connection that neither sends a request nor upgrades is not worth holding.
  http.headersTimeout = 15_000;
  http.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.config.port, opts.config.host, () => { http.off('error', reject); resolve(); });
  });
  const port = (http.address() as AddressInfo).port;
  log(`hopdesk server listening on ${opts.config.host}:${port}`
    + `; registration ${opts.config.registration}`
    + `; relay ${opts.config.turn ? 'configured' : 'not configured'}`);

  return {
    port,
    store,
    presence,
    api,
    async close() {
      signaling.close();
      await new Promise<void>(resolve => http.close(() => resolve()));
      store.close();
    },
  };
}
