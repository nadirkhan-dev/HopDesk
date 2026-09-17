import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { browseLan, decodeMessage, encodeName, encodeQuery } from '../dist/index.js';

/* A minimal mDNS responder speaking to one-shot queries by unicast, using
   name compression the way Avahi and Bonjour do. */

function nameWithPointers(name, table, offsetOf) {
  // Compress against names already written: longest known suffix becomes a pointer.
  const labels = name.split('.');
  const parts = [];
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (table.has(suffix)) {
      const p = table.get(suffix);
      parts.push(Buffer.from([0xc0 | (p >> 8), p & 0xff]));
      return Buffer.concat(parts);
    }
    table.set(suffix, offsetOf() + parts.reduce((n, b) => n + b.length, 0));
    const b = Buffer.from(labels[i]);
    parts.push(Buffer.concat([Buffer.from([b.length]), b]));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function response(records) {
  const table = new Map();
  const chunks = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  chunks.push(header);
  const offset = () => chunks.reduce((n, b) => n + b.length, 0);
  for (const r of records) {
    chunks.push(nameWithPointers(r.name, table, offset));
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(120, 4);
    chunks.push(fixed);
    const lenAt = offset() - 2;
    let rdata;
    if (r.type === 12) rdata = nameWithPointers(r.data, table, offset);
    else if (r.type === 33) {
      const head = Buffer.alloc(6); head.writeUInt16BE(r.data.port, 4);
      chunks.push(head);
      rdata = Buffer.concat([head, nameWithPointers(r.data.target, table, offset)]);
      chunks.pop();
    } else if (r.type === 1) rdata = Buffer.from(r.data.split('.').map(Number));
    else if (r.type === 16) rdata = Buffer.concat(r.data.map(s => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)])));
    const all = Buffer.concat(chunks);
    all.writeUInt16BE(rdata.length, lenAt);
    chunks.length = 0;
    chunks.push(all, rdata);
  }
  return Buffer.concat(chunks);
}

async function responder(records, { garbage = false } = {}) {
  const sock = createSocket('udp4');
  const queries = [];
  sock.on('message', (msg, rinfo) => {
    queries.push(msg);
    if (garbage) {
      sock.send(Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 0x0c]), rinfo.port, rinfo.address);
      sock.send(Buffer.from('definitely not dns'), rinfo.port, rinfo.address);
    }
    sock.send(response(records), rinfo.port, rinfo.address);
  });
  await new Promise(r => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, queries, close: () => sock.close() };
}

const MAC = [
  { name: '_rfb._tcp.local', type: 12, data: 'Office Mac._rfb._tcp.local' },
  { name: 'Office Mac._rfb._tcp.local', type: 33, data: { port: 5900, target: 'office-mac.local' } },
  { name: 'office-mac.local', type: 1, data: '192.168.1.20' },
  { name: 'Office Mac._device-info._tcp.local', type: 16, data: ['model=MacBookPro18,3', 'osxvers=23'] },
];
const LINUX = [
  { name: '_rdp._tcp.local', type: 12, data: 'build-server._rdp._tcp.local' },
  { name: 'build-server._rdp._tcp.local', type: 33, data: { port: 3389, target: 'build-server.local' } },
  { name: 'build-server.local', type: 1, data: '192.168.1.30' },
];

test('advertised Macs and RDP hosts are found, with name compression, and macOS is recognised', async () => {
  const r = await responder([...MAC, ...LINUX]);
  const found = await browseLan({ target: { address: '127.0.0.1', port: r.port }, timeoutMs: 700 });
  r.close();
  assert.deepEqual(found, [
    { name: 'build-server', address: '192.168.1.30', hostname: 'build-server.local', port: 3389, protocol: 'rdp', os: undefined, service: '_rdp._tcp.local' },
    { name: 'Office Mac', address: '192.168.1.20', hostname: 'office-mac.local', port: 5900, protocol: 'vnc', os: 'macos', service: '_rfb._tcp.local' },
  ]);
  // The question asked for the screen-sharing services, as PTR queries.
  const q = r.queries[0];
  assert.equal(q.readUInt16BE(4), 3, 'expected questions for _rfb, _rdp and _device-info');
  assert.ok(q.includes(encodeName('_rfb._tcp.local')));
});

test('incomplete answers, garbage packets and compression loops are ignored safely', async () => {
  const partial = [
    { name: '_rfb._tcp.local', type: 12, data: 'No Address._rfb._tcp.local' },
    { name: 'No Address._rfb._tcp.local', type: 33, data: { port: 5900, target: 'nowhere.local' } },
  ];
  const r = await responder(partial, { garbage: true });
  const found = await browseLan({ target: { address: '127.0.0.1', port: r.port }, timeoutMs: 600 });
  r.close();
  assert.deepEqual(found, [], 'an entry without an address must not be offered');

  // A pointer to itself.
  const loop = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 1, 2, 3, 4]);
  assert.throws(() => decodeMessage(loop), /loop/);
  // Queries are not answers.
  assert.deepEqual(decodeMessage(encodeQuery(['_rfb._tcp.local'])), []);
});

test('with nothing answering, browsing ends empty after the timeout', async () => {
  const silent = createSocket('udp4');
  await new Promise(r => silent.bind(0, '127.0.0.1', r));
  const t0 = Date.now();
  const found = await browseLan({ target: { address: '127.0.0.1', port: silent.address().port }, timeoutMs: 400 });
  silent.close();
  assert.deepEqual(found, []);
  assert.ok(Date.now() - t0 < 1500);
});
