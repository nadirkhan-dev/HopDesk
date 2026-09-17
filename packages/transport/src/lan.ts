import net from 'node:net';
import { FramedLink } from './framing.js';

/**
 * Direct LAN connectivity: the host listens on a TCP port and a viewer on the
 * same network connects to it, found by mDNS or typed as an address. No
 * server and no account is involved. The socket carries only the handshake
 * and sealed frames; it needs no TLS of its own.
 */

export const DEFAULT_LAN_PORT = 47631;

export interface LanListenerOptions {
  port?: number;
  host?: string;
  /** Unauthenticated connections held at once; extras are dropped. */
  maxConnections?: number;
}

export class LanListener {
  private server: net.Server | null = null;
  private live = new Set<net.Socket>();

  constructor(private readonly onLink: (link: FramedLink, remote: { address: string; port: number }) => void) {}

  async listen(opts: LanListenerOptions = {}): Promise<{ port: number }> {
    const max = opts.maxConnections ?? 16;
    const server = net.createServer(socket => {
      if (this.live.size >= max) { socket.destroy(); return; }
      this.live.add(socket);
      socket.on('close', () => this.live.delete(socket));
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      this.onLink(new FramedLink(socket), { address: socket.remoteAddress ?? '', port: socket.remotePort ?? 0 });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? DEFAULT_LAN_PORT, opts.host, () => { server.off('error', reject); resolve(); });
    });
    return { port: (server.address() as net.AddressInfo).port };
  }

  get connections() { return this.live.size; }

  async close() {
    for (const s of this.live) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export function connectLan(host: string, port: number, timeoutMs = 8000): Promise<FramedLink> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`No answer from ${host}:${port}`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('error', err => { clearTimeout(timer); reject(err); });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      resolve(new FramedLink(socket));
    });
  });
}
