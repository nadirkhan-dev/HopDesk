import { createSocket, type Socket } from 'node:dgram';
import type { Protocol, RemoteOs } from './connections.js';

/**
 * Computers on the local network that advertise screen sharing.
 *
 * mDNS/DNS-SD (Bonjour, Avahi) is what macOS Screen Sharing and many Linux VNC
 * servers use to announce themselves, and it needs no dependency: a DNS
 * question sent to the mDNS multicast group from an ordinary port is a
 * "one-shot" query (RFC 6762 §5.1, §6.7), which responders answer by unicast to
 * that port. Nothing binds 5353, so this coexists with a running Avahi daemon.
 *
 * What it will not find, by design of the platforms: Windows PCs, which do not
 * advertise Remote Desktop over mDNS, and servers that do not announce
 * themselves. Manual entry of an address is always available.
 */

export interface DiscoveredComputer {
  /** The advertised instance name, e.g. "Office Mac". */
  name: string;
  /** IPv4 address to connect to. */
  address: string;
  /** The advertised .local host name, when given. */
  hostname?: string;
  port: number;
  protocol: Protocol;
  os?: RemoteOs;
  /** The DNS-SD service it was found through. */
  service: string;
}

export const DISCOVERY_SERVICES: Record<string, Protocol> = {
  '_rfb._tcp.local': 'vnc',
  '_rdp._tcp.local': 'rdp',
};

const TYPE_A = 1, TYPE_PTR = 12, TYPE_TXT = 16, TYPE_SRV = 33;
const DEVICE_INFO = '_device-info._tcp.local';

export interface BrowseOptions {
  timeoutMs?: number;
  /** Where to send the query; the mDNS group by default. Tests use a local responder. */
  target?: { address: string; port: number };
  services?: string[];
}

export function browseLan(opts: BrowseOptions = {}): Promise<DiscoveredComputer[]> {
  const services = opts.services ?? Object.keys(DISCOVERY_SERVICES);
  const target = opts.target ?? { address: '224.0.0.251', port: 5353 };
  const timeoutMs = opts.timeoutMs ?? 2500;

  return new Promise(resolve => {
    const records: DnsRecord[] = [];
    let socket: Socket;
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve(assemble(records, services));
    };
    socket.on('error', finish);
    socket.on('message', msg => {
      try { records.push(...decodeMessage(msg)); } catch { /* malformed packets from the network are ignored */ }
    });
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastLoopback(true);
      } catch { /* not multicast-capable (e.g. a unicast test target) */ }
      const query = encodeQuery([...services, DEVICE_INFO]);
      socket.send(query, target.port, target.address, err => { if (err) finish(); });
      // A second query catches responders that were busy the first time.
      setTimeout(() => socket.send(query, target.port, target.address, () => {}), Math.min(600, timeoutMs / 3)).unref?.();
      setTimeout(finish, timeoutMs).unref?.();
    });
  });
}

/* --------------------------------------------------------------- assembly */

function assemble(records: DnsRecord[], services: string[]): DiscoveredComputer[] {
  const lower = (s: string) => s.toLowerCase();
  const byName = (type: number, name: string) => records.filter(r => r.type === type && lower(r.name) === lower(name));
  const found = new Map<string, DiscoveredComputer>();

  for (const service of services) {
    const protocol = DISCOVERY_SERVICES[service];
    if (!protocol) continue;
    for (const ptr of byName(TYPE_PTR, service)) {
      const instance = ptr.data as string;
      const srv = byName(TYPE_SRV, instance)[0]?.data as SrvData | undefined;
      if (!srv) continue;
      const address = byName(TYPE_A, srv.target)[0]?.data as string | undefined;
      if (!address) continue;

      const label = instance.slice(0, instance.length - service.length - 1);
      // macOS announces a model ("MacBookPro18,3") under _device-info for the same instance label.
      const info = byName(TYPE_TXT, `${label}.${DEVICE_INFO}`)[0]?.data as string[] | undefined;
      const model = info?.find(t => t.toLowerCase().startsWith('model='))?.slice(6) ?? '';
      const os: RemoteOs | undefined = /mac/i.test(model) ? 'macos' : undefined;

      const key = `${address}:${srv.port}:${protocol}`;
      if (!found.has(key)) {
        found.set(key, {
          name: label, address, hostname: srv.target.replace(/\.$/, ''),
          port: srv.port, protocol, os, service,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}


/* ------------------------------------------------------------ DNS wire format */

interface SrvData { priority: number; weight: number; port: number; target: string }
export interface DnsRecord { name: string; type: number; data: string | string[] | SrvData | Buffer }

export function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map(p => {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error('DNS label too long');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

export function encodeQuery(names: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);            // QDCOUNT; id 0 and flags 0 for mDNS
  const questions = names.map(n => {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(TYPE_PTR, 0);
    q.writeUInt16BE(1, 2);                          // class IN
    return Buffer.concat([encodeName(n), q]);
  });
  return Buffer.concat([header, ...questions]);
}

/** Reads a possibly compressed name; returns it and the offset after it. */
function readName(msg: Buffer, offset: number, depth = 0): [string, number] {
  if (depth > 20) throw new Error('DNS name compression loop');
  const labels: string[] = [];
  let pos = offset;
  for (;;) {
    if (pos >= msg.length) throw new Error('truncated DNS name');
    const len = msg[pos]!;
    if (len === 0) { pos += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= msg.length) throw new Error('truncated DNS pointer');
      const pointer = ((len & 0x3f) << 8) | msg[pos + 1]!;
      const [rest] = readName(msg, pointer, depth + 1);
      if (rest) labels.push(rest);
      pos += 2;
      return [labels.join('.'), pos];
    }
    if (pos + 1 + len > msg.length) throw new Error('truncated DNS label');
    labels.push(msg.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return [labels.join('.'), pos];
}

export function decodeMessage(msg: Buffer): DnsRecord[] {
  if (msg.length < 12) return [];
  const flags = msg.readUInt16BE(2);
  if (!(flags & 0x8000)) return [];                  // a query, not a response
  const qd = msg.readUInt16BE(4);
  const rrCount = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const [, next] = readName(msg, pos);
    pos = next + 4;
  }
  const out: DnsRecord[] = [];
  for (let i = 0; i < rrCount && pos < msg.length; i++) {
    const [name, next] = readName(msg, pos);
    pos = next;
    if (pos + 10 > msg.length) break;
    const type = msg.readUInt16BE(pos);
    const rdlen = msg.readUInt16BE(pos + 8);
    const start = pos + 10;
    const end = start + rdlen;
    if (end > msg.length) break;
    const rdata = msg.subarray(start, end);
    const clean = name;
    if (type === TYPE_PTR) {
      out.push({ name: clean, type, data: readName(msg, start)[0] });
    } else if (type === TYPE_SRV && rdlen >= 7) {
      out.push({
        name: clean, type,
        data: { priority: rdata.readUInt16BE(0), weight: rdata.readUInt16BE(2), port: rdata.readUInt16BE(4), target: readName(msg, start + 6)[0] },
      });
    } else if (type === TYPE_A && rdlen === 4) {
      out.push({ name: clean, type, data: [...rdata].join('.') });
    } else if (type === TYPE_TXT) {
      const strings: string[] = [];
      for (let p = 0; p < rdata.length;) {
        const l = rdata[p]!;
        strings.push(rdata.subarray(p + 1, p + 1 + l).toString('utf8'));
        p += 1 + l;
      }
      out.push({ name: clean, type, data: strings });
    }
    pos = end;
  }
  return out;
}
