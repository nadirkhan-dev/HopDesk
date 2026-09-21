import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

/**
 * Finding HopDesk computers on the local network, so a Device ID is enough to
 * connect and nobody has to know an IP address.
 *
 * Plain mDNS/DNS-SD (RFC 6762, 6763) over a UDP socket: the service is
 * `_hopdesk._tcp`, the instance name is the Device ID, and the TXT record
 * carries the ID and the computer's name. No dependency, and it interoperates
 * with Avahi and Bonjour because it is the same protocol they speak.
 *
 * The TXT and SRV records are only a hint about where to try connecting. They
 * are not authentication: whoever answers still has to complete the handshake
 * with the access code, and a host that lies about its Device ID simply fails
 * to do so.
 */

export const HOPDESK_SERVICE = '_hopdesk._tcp.local';
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1, TYPE_PTR = 12, TYPE_TXT = 16, TYPE_SRV = 33, TYPE_ANY = 255;
const CLASS_IN = 1;
const FLUSH = 0x8000;

export interface DiscoveredHost {
  deviceId: string;
  name: string;
  address: string;
  port: number;
}

/* ------------------------------------------------------------- encoding */

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const out: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > 63) throw new Error(`mDNS label too long: ${part}`);
    out.push(Buffer.from([bytes.length]), bytes);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function record(name: string, type: number, ttl: number, data: Buffer, flush = true): Buffer {
  const head = encodeName(name);
  const mid = Buffer.alloc(10);
  mid.writeUInt16BE(type, 0);
  mid.writeUInt16BE(CLASS_IN | (flush ? FLUSH : 0), 2);
  mid.writeUInt32BE(ttl, 4);
  mid.writeUInt16BE(data.length, 8);
  return Buffer.concat([head, mid, data]);
}

function srvData(priority: number, weight: number, port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(priority, 0);
  head.writeUInt16BE(weight, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function txtData(pairs: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(pairs)) {
    const bytes = Buffer.from(`${key}=${value}`, 'utf8');
    if (bytes.length > 255) throw new Error('mDNS TXT entry too long');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  return parts.length ? Buffer.concat(parts) : Buffer.from([0]);
}

function message({ id = 0, response, questions = [], answers = [], additionals = [] }: {
  id?: number; response: boolean; questions?: Buffer[]; answers?: Buffer[]; additionals?: Buffer[];
}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(response ? 0x8400 : 0, 2);      // QR + AA for responses
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, ...questions, ...answers, ...additionals]);
}

function question(name: string, type: number): Buffer {
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([encodeName(name), q]);
}

/* ------------------------------------------------------------- decoding */

interface Reader { buf: Buffer; at: number }

function readName(r: Reader): string {
  const parts: string[] = [];
  let jumped = false;
  let guard = 0;
  for (;;) {
    if (guard++ > 128) throw new Error('mDNS name loop');
    const len = r.buf[r.at];
    if (len === undefined) throw new Error('mDNS truncated name');
    if (len === 0) { if (!jumped) r.at++; break; }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | r.buf[r.at + 1]!;
      if (!jumped) { r.at += 2; jumped = true; }
      const tail = readName({ buf: r.buf, at: pointer });
      if (tail) parts.push(tail);
      break;
    }
    const start = r.at + 1;
    parts.push(r.buf.subarray(start, start + len).toString('utf8'));
    r.at = start + len;
    if (jumped) continue;
  }
  return parts.join('.');
}

interface ParsedRecord { name: string; type: number; data: Buffer }
interface ParsedMessage { response: boolean; questions: { name: string; type: number }[]; records: ParsedRecord[] }

export function parseMdns(buf: Buffer): ParsedMessage {
  const r: Reader = { buf, at: 12 };
  const flags = buf.readUInt16BE(2);
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  const questions: { name: string; type: number }[] = [];
  for (let i = 0; i < counts[0]!; i++) {
    const name = readName(r);
    const type = buf.readUInt16BE(r.at);
    r.at += 4;
    questions.push({ name, type });
  }
  const records: ParsedRecord[] = [];
  for (let section = 1; section < 4; section++) {
    for (let i = 0; i < counts[section]!; i++) {
      const name = readName(r);
      const type = buf.readUInt16BE(r.at);
      const length = buf.readUInt16BE(r.at + 8);
      const data = buf.subarray(r.at + 10, r.at + 10 + length);
      r.at += 10 + length;
      records.push({ name, type, data });
    }
  }
  return { response: (flags & 0x8000) !== 0, questions, records };
}

function parseTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const len = data[at]!;
    const entry = data.subarray(at + 1, at + 1 + len).toString('utf8');
    at += 1 + len;
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** This machine's IPv4 addresses, best first: the one on the asker's subnet. */
function localAddresses(preferSameSubnetAs?: string): string[] {
  const all: { address: string; netmask: string }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) all.push({ address: entry.address, netmask: entry.netmask });
    }
  }
  const sameSubnet = (a: string, b: string, mask: string) => {
    const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
    return (toInt(a) & toInt(mask)) === (toInt(b) & toInt(mask));
  };
  const sorted = preferSameSubnetAs
    ? [...all].sort((x, y) => Number(sameSubnet(y.address, preferSameSubnetAs, y.netmask)) - Number(sameSubnet(x.address, preferSameSubnetAs, x.netmask)))
    : all;
  return sorted.map(e => e.address);
}

/* ------------------------------------------------------------ announcing */

export interface AnnouncerOptions {
  deviceId: string;
  /** The computer's name, shown in another computer's list. */
  name: string;
  /** Port the Host listens on. */
  port: number;
  /** Bind port; only tests use anything but 5353. */
  bindPort?: number;
  /** Refuse to share the port with another responder. */
  exclusive?: boolean;
  /** Multicast group to join, or null to stay unicast (tests). */
  group?: string | null;
}

/**
 * Answers mDNS queries for this computer, and says so once at startup and once
 * on the way out. Failing to bind port 5353 is not fatal: another responder
 * already has it, and connecting by address still works, so the caller is told
 * and carries on.
 */
export class HopdeskAnnouncer {
  private socket: Socket | null = null;
  private failure: string | null = null;

  constructor(private readonly opts: AnnouncerOptions) {}

  get instance() { return `${this.opts.deviceId}.${HOPDESK_SERVICE}`; }
  get hostname() { return `${this.opts.deviceId.toLowerCase()}.local`; }
  /** The UDP port being listened on, or 0 when not running. */
  get listenPort() { return this.socket?.address().port ?? 0; }
  /** Why announcing is not running, or null when it is. */
  get unavailable() { return this.failure; }
  get bound() { return this.socket !== null; }

  async start(): Promise<{ announcing: boolean; detail?: string }> {
    if (this.socket) return { announcing: true };
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => this.answer(msg, rinfo));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind({ port: this.opts.bindPort ?? MDNS_PORT, exclusive: this.opts.exclusive ?? false },
          () => { socket.off('error', reject); resolve(); });
      });
    } catch (err) {
      socket.close();
      this.failure = `Could not listen for network discovery: ${(err as Error).message}`;
      return { announcing: false, detail: this.failure };
    }
    socket.on('error', () => { /* transient network errors must not crash the host */ });
    const group = this.opts.group === undefined ? MDNS_GROUP : this.opts.group;
    if (group) {
      try { socket.addMembership(group); } catch { /* no multicast route: unicast queries still work */ }
    }
    this.socket = socket;
    this.failure = null;
    this.broadcast(120);
    return { announcing: true };
  }

  /** Records describing this computer. */
  private records(askerAddress?: string) {
    const address = localAddresses(askerAddress)[0] ?? '127.0.0.1';
    const ttl = 120;
    return {
      ptr: record(HOPDESK_SERVICE, TYPE_PTR, ttl, encodeName(this.instance), false),
      srv: record(this.instance, TYPE_SRV, ttl, srvData(0, 0, this.opts.port, this.hostname)),
      txt: record(this.instance, TYPE_TXT, ttl, txtData({ id: this.opts.deviceId, name: this.opts.name, v: '1' })),
      a: record(this.hostname, TYPE_A, ttl, Buffer.from(address.split('.').map(Number))),
    };
  }

  private answer(msg: Buffer, rinfo: { address: string; port: number }) {
    let parsed: ParsedMessage;
    try { parsed = parseMdns(msg); } catch { return; }
    if (parsed.response) return;
    const wanted = parsed.questions.some(q =>
      (q.name === HOPDESK_SERVICE && (q.type === TYPE_PTR || q.type === TYPE_ANY))
      || (q.name === this.instance && (q.type === TYPE_SRV || q.type === TYPE_TXT || q.type === TYPE_ANY))
      || (q.name === this.hostname && (q.type === TYPE_A || q.type === TYPE_ANY)));
    if (!wanted) return;
    const { ptr, srv, txt, a } = this.records(rinfo.address);
    const reply = message({ response: true, answers: [ptr], additionals: [srv, txt, a] });
    // Answered by unicast to the asker, as one-shot queries expect.
    this.socket?.send(reply, rinfo.port, rinfo.address, () => { /* best effort */ });
  }

  /** An unsolicited announcement, and with ttl 0 a goodbye. */
  private broadcast(ttl: number) {
    const group = this.opts.group === undefined ? MDNS_GROUP : this.opts.group;
    if (!group || !this.socket) return;
    const { ptr, srv, txt, a } = this.records();
    const answers = ttl === 0
      ? [record(HOPDESK_SERVICE, TYPE_PTR, 0, encodeName(this.instance), false)]
      : [ptr, srv, txt, a];
    this.socket.send(message({ response: true, answers }), MDNS_PORT, group, () => { /* best effort */ });
  }

  async stop() {
    if (!this.socket) return;
    this.broadcast(0);
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>(resolve => setTimeout(resolve, 20));   // let the goodbye leave
    await new Promise<void>(resolve => socket.close(() => resolve()));
  }
}

/* ------------------------------------------------------------- browsing */

export interface FindOptions {
  timeoutMs?: number;
  /** Where to ask; the mDNS group by default. Tests point this at a responder. */
  target?: { address: string; port: number };
  /** Stop as soon as this Device ID answers. */
  deviceId?: string;
  /**
   * Which local addresses to ask from. The default is every IPv4 address this
   * computer has, because one multicast packet leaves by whichever interface
   * the routing table prefers — which on a machine with Docker bridges or a
   * VPN is often not the one the other computer is on.
   */
  sendFrom?: string[];
}

/** One-shot query for HopDesk computers on this network. */
export function findHosts(opts: FindOptions = {}): Promise<DiscoveredHost[]> {
  const target = opts.target ?? { address: MDNS_GROUP, port: MDNS_PORT };
  const timeoutMs = opts.timeoutMs ?? 2000;

  return new Promise(resolve => {
    let socket: Socket;
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const records: ParsedRecord[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(collect(records));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    socket.on('error', finish);
    socket.on('message', msg => {
      try {
        const parsed = parseMdns(msg);
        if (!parsed.response) return;
        records.push(...parsed.records);
      } catch { return; }
      if (opts.deviceId && collect(records).some(h => h.deviceId === opts.deviceId)) finish();
    });
    socket.bind(0, () => {
      const query = message({ response: false, questions: [question(HOPDESK_SERVICE, TYPE_PTR), question(HOPDESK_SERVICE, TYPE_ANY)] });
      const multicast = target.address === MDNS_GROUP;
      const from = multicast ? (opts.sendFrom ?? discoveryAddresses()) : [];
      let sent = 0;
      let failed = 0;
      const attempt = () => {
        socket.send(query, target.port, target.address, err => {
          if (err) failed++;
          if (++sent >= attempts && failed === attempts) finish();   // nothing left
        });
      };
      /* Once per interface, so a query reaches the network the other computer
         is actually on, and once more however the routing table would send it. */
      const attempts = from.length + 1;
      for (const address of from) {
        try { socket.setMulticastInterface(address); } catch { /* not a multicast interface */ }
        attempt();
      }
      try { socket.setMulticastInterface('0.0.0.0'); } catch { /* the default route it is */ }
      attempt();
    });
  });
}

/** Every IPv4 address this computer has, except loopback and the like. */
export function discoveryAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

function collect(records: ParsedRecord[]): DiscoveredHost[] {
  const addresses = new Map<string, string>();
  for (const r of records) {
    if (r.type === TYPE_A && r.data.length === 4) addresses.set(r.name, Array.from(r.data).join('.'));
  }
  const hosts = new Map<string, DiscoveredHost>();
  for (const r of records) {
    if (r.type !== TYPE_SRV) continue;
    const port = r.data.readUInt16BE(4);
    const target = readName({ buf: r.data, at: 6 });
    const txt = records.find(t => t.type === TYPE_TXT && t.name === r.name);
    const fields = txt ? parseTxt(txt.data) : {};
    const deviceId = fields.id ?? r.name.split('.')[0] ?? '';
    const address = addresses.get(target) ?? '';
    if (!deviceId || !address || !port) continue;
    hosts.set(deviceId, { deviceId, name: fields.name ?? deviceId, address, port });
  }
  return [...hosts.values()];
}
