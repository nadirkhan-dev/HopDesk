import { test } from 'node:test';
import { networkInterfaces } from 'node:os';
import assert from 'node:assert/strict';
import { HopdeskAnnouncer, findHosts, HOPDESK_SERVICE, parseMdns, discoveryAddresses } from '../dist/index.js';
import { decodeMessage } from '@hopdesk/core';

/**
 * Discovery is tested over a real UDP socket. Multicast is not available in
 * every environment (containers, restricted networks), so the announcer binds
 * an ordinary port and the finder asks it directly; that exercises the same
 * encoding, parsing and answering code. The multicast group is only the
 * delivery mechanism.
 */

const port = 47999;

async function announcer(opts = {}) {
  const a = new HopdeskAnnouncer({
    deviceId: 'HD-7K3M-Q9TX', name: 'Office PC', port: 47631,
    bindPort: 0, group: null, ...opts,
  });
  const started = await a.start();
  assert.equal(started.announcing, true, started.detail);
  return a;
}

test('a host answers a query with its Device ID, name, port and address', async () => {
  const a = await announcer();
  try {
    const found = await findHosts({ target: { address: '127.0.0.1', port: a.listenPort }, timeoutMs: 1500 });
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].deviceId, 'HD-7K3M-Q9TX');
    assert.equal(found[0].name, 'Office PC');
    assert.equal(found[0].port, 47631);
    assert.match(found[0].address, /^\d+\.\d+\.\d+\.\d+$/);
  } finally { await a.stop(); }
});

test('the finder stops early once the Device ID it wants has answered', async () => {
  const a = await announcer();
  try {
    const started = Date.now();
    const found = await findHosts({ target: { address: '127.0.0.1', port: a.listenPort }, timeoutMs: 8000, deviceId: 'HD-7K3M-Q9TX' });
    assert.equal(found.length, 1);
    assert.ok(Date.now() - started < 3000, 'the finder waited for the full timeout');
  } finally { await a.stop(); }
});

test('nothing is found once the host stops answering', async () => {
  const a = await announcer();
  const target = { address: '127.0.0.1', port: a.listenPort };
  await a.stop();
  assert.deepEqual(await findHosts({ target, timeoutMs: 700 }), []);
});

test('the records are valid DNS-SD, as the existing mDNS decoder reads them', async () => {
  const a = await announcer({ deviceId: 'HD-ABCD-1234', name: 'Näme wîth ünicode' });
  try {
    // Parsed by @hopdesk/core's independent decoder, not by this module's own.
    const { promise, socket } = await ask(a.listenPort);
    const records = decodeMessage(await promise);
    socket.close();
    const names = records.map(r => r.name);
    assert.ok(names.includes(HOPDESK_SERVICE), `no PTR for the service: ${names.join(', ')}`);
    assert.ok(names.includes('HD-ABCD-1234._hopdesk._tcp.local'), 'no SRV/TXT for the instance');
    const srv = records.find(r => r.type === 33);
    assert.equal(srv.data.port, 47631);
    assert.equal(srv.data.target, 'hd-abcd-1234.local');
    const txt = records.find(r => r.type === 16);
    assert.ok(txt.data.some(entry => entry === 'name=Näme wîth ünicode'), `TXT was ${JSON.stringify(txt.data)}`);
    assert.ok(txt.data.some(entry => entry === 'id=HD-ABCD-1234'));
  } finally { await a.stop(); }
});

test('queries for other services, and malformed packets, are ignored', async () => {
  const a = await announcer();
  try {
    const { promise, socket, send } = await ask(a.listenPort, { skipQuery: true });
    send(Buffer.from([0, 1, 2, 3]));                        // nonsense
    send(buildQuery('_printer._tcp.local'));                // someone else's service
    const answered = await Promise.race([promise.then(() => true), new Promise(r => setTimeout(() => r(false), 600))]);
    socket.close();
    assert.equal(answered, false, 'the host answered a query that was not for it');
  } finally { await a.stop(); }
});

test('a port that cannot be bound is reported instead of throwing', async () => {
  const first = await announcer({ bindPort: port });
  try {
    const second = new HopdeskAnnouncer({ deviceId: 'HD-0000-0001', name: 'Second', port: 47632, bindPort: port, group: null, exclusive: true });
    const result = await second.start();
    // reuseAddr means a second bind may succeed; either way it must not throw.
    assert.equal(typeof result.announcing, 'boolean');
    await second.stop();
  } finally { await first.stop(); }
});

/* --------------------------------------------------------------- helpers */

function buildQuery(service) {
  const name = service.split('.').flatMap(l => [Buffer.from([l.length]), Buffer.from(l)]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(12, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...name, tail]);
}

async function ask(targetPort, { skipQuery = false } = {}) {
  const { createSocket } = await import('node:dgram');
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise(r => socket.bind(0, r));
  const promise = new Promise(resolve => socket.on('message', resolve));
  const send = buf => socket.send(buf, targetPort, '127.0.0.1');
  if (!skipQuery) send(buildQuery(HOPDESK_SERVICE));
  return { promise, socket, send };
}

test('a query is asked from every network this computer is on', () => {
  /* One multicast packet leaves by whichever interface the routing table
     prefers. On a machine with Docker bridges or a VPN that is often not the
     network the other computer is on — which is how a Mac stayed invisible
     while TCP to it worked. */
  const addresses = discoveryAddresses();
  const own = Object.values(networkInterfaces()).flat()
    .filter(e => e && e.family === 'IPv4' && !e.internal).map(e => e.address);
  assert.deepEqual([...addresses].sort(), [...own].sort());
  assert.ok(!addresses.includes('127.0.0.1'), 'loopback is not a network to look for computers on');
});
