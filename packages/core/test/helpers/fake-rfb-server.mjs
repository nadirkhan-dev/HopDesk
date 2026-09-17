/**
 * A scriptable RFB server for deterministic tests.
 *
 * It speaks enough of RFC 6143 to exercise the client end to end — handshake,
 * security, every message the client sends, and FramebufferUpdates built by
 * the test — while recording what the client did. Pixel values in the helpers
 * below are [r, g, b] and are put on the wire in the format the client asks
 * for (32 bpp, little endian, red shift 16), i.e. as B G R X bytes.
 */
import { createServer } from 'node:net';
import { constants as zlib, deflateSync, inflateSync } from 'node:zlib';
import { vncEncrypt } from '../../dist/index.js';

export async function startFakeRfbServer(opts = {}) {
  const {
    version = 'RFB 003.008\n',
    securityTypes = [1],
    password = null,
    width = 64, height = 48, name = 'fake-desktop',
    /** Called for every FramebufferUpdateRequest; return a Buffer to send, or null. */
    onRequest = null,
    /** Bytes per write when sending updates, to exercise partial reads. */
    chunkSize = 0,
    /** Announce Extended Clipboard support, as TigerVNC and RealVNC do. */
    extendedClipboard = false,
    onClipboard = null,
    onSetDesktopSize = null,
  } = opts;

  const events = [];
  const sockets = new Set();
  let connections = 0;
  let lastSocket = null;

  const server = createServer(socket => {
    connections++;
    lastSocket = socket;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'version';
    let challenge = null;

    const write = data => {
      if (!chunkSize) { socket.write(data); return; }
      for (let i = 0; i < data.length; i += chunkSize) socket.write(data.subarray(i, i + chunkSize));
    };
    const serverInit = () => {
      const nameBuf = Buffer.from(name);
      const m = Buffer.alloc(24 + nameBuf.length);
      m.writeUInt16BE(width, 0); m.writeUInt16BE(height, 2);
      m.writeUInt8(32, 4); m.writeUInt8(24, 5); m.writeUInt8(0, 6); m.writeUInt8(1, 7);
      m.writeUInt16BE(255, 8); m.writeUInt16BE(255, 10); m.writeUInt16BE(255, 12);
      m.writeUInt8(16, 14); m.writeUInt8(8, 15); m.writeUInt8(0, 16);
      m.writeUInt32BE(nameBuf.length, 20); nameBuf.copy(m, 24);
      socket.write(m);
    };
    const minor = Number(version.slice(8, 11));

    socket.write(version);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const before = buf.length;
        step();
        if (buf.length === before) return;
      }
    });

    function take(n) {
      if (buf.length < n) return null;
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    }

    function step() {
      switch (stage) {
        case 'version': {
          const v = take(12); if (!v) return;
          events.push({ type: 'version', value: v.toString() });
          if (minor === 3) {
            const type = securityTypes[0];
            const m = Buffer.alloc(4); m.writeUInt32BE(type); socket.write(m);
            if (type === 2) { challenge = Buffer.alloc(16, 9); socket.write(challenge); stage = 'auth'; }
            else stage = 'clientinit';
          } else {
            socket.write(Buffer.from([securityTypes.length, ...securityTypes]));
            stage = 'security';
          }
          return;
        }
        case 'security': {
          const t = take(1); if (!t) return;
          events.push({ type: 'security', value: t[0] });
          if (t[0] === 2) { challenge = Buffer.alloc(16, 9); socket.write(challenge); stage = 'auth'; return; }
          if (minor >= 8) socket.write(Buffer.alloc(4));
          stage = 'clientinit';
          return;
        }
        case 'auth': {
          const r = take(16); if (!r) return;
          const ok = password !== null && vncEncrypt(challenge, password).equals(r);
          if (ok) { socket.write(Buffer.alloc(4)); stage = 'clientinit'; return; }
          const reason = Buffer.from('Authentication failure');
          const m = Buffer.alloc(8 + reason.length); m.writeUInt32BE(1, 0); m.writeUInt32BE(reason.length, 4); reason.copy(m, 8);
          socket.end(minor >= 8 ? m : m.subarray(0, 4));
          stage = 'dead';
          return;
        }
        case 'clientinit': {
          const s = take(1); if (!s) return;
          events.push({ type: 'clientinit', shared: s[0] });
          serverInit();
          stage = 'ready';
          return;
        }
        case 'ready': {
          const type = buf[0];
          if (type === undefined) return;
          if (type === 0) { if (!take(20)) return; events.push({ type: 'setPixelFormat' }); return; }
          if (type === 2) {
            if (buf.length < 4) return;
            const n = buf.readUInt16BE(2);
            const m = take(4 + n * 4); if (!m) return;
            const encodings = Array.from({ length: n }, (_, i) => m.readInt32BE(4 + i * 4));
            events.push({ type: 'setEncodings', encodings });
            // Like TigerVNC: announce clipboard capabilities once the client says it understands them.
            if (extendedClipboard && encodings.includes(CLIP.encoding)) {
              socket.write(extendedClipboardMessage(CLIP.caps | CLIP.text | CLIP.request | CLIP.peek | CLIP.notify | CLIP.provide, u32(10 * 1024 * 1024)));
            }
            return;
          }
          if (type === 3) {
            const m = take(10); if (!m) return;
            const req = { type: 'request', incremental: m[1] === 1, x: m.readUInt16BE(2), y: m.readUInt16BE(4), width: m.readUInt16BE(6), height: m.readUInt16BE(8), at: Date.now() };
            events.push(req);
            const reply = onRequest?.(req, { socket, events });
            if (reply) write(reply);
            return;
          }
          if (type === 4) { const m = take(8); if (!m) return; events.push({ type: 'key', down: m[1] === 1, keysym: m.readUInt32BE(4) }); return; }
          if (type === 5) { const m = take(6); if (!m) return; events.push({ type: 'pointer', mask: m[1], x: m.readUInt16BE(2), y: m.readUInt16BE(4) }); return; }
          if (type === 6) {
            if (buf.length < 8) return;
            const len = buf.readInt32BE(4);
            const m = take(8 + Math.abs(len)); if (!m) return;
            if (len >= 0) {
              events.push({ type: 'cutText', text: m.subarray(8).toString('latin1') });
              return;
            }
            const flags = m.readUInt32BE(8);
            const ev = { type: 'extClip', flags };
            if (flags & CLIP.provide && !(flags & CLIP.caps)) {
              const raw = inflateSync(m.subarray(12));
              ev.text = raw.subarray(4, 4 + raw.readUInt32BE(0)).toString('utf8');
            }
            events.push(ev);
            onClipboard?.(ev, { socket, events });
            return;
          }
          if (type === 251) {
            const m = buf.length >= 8 ? buf : null; if (!m) return;
            const n = buf[6];
            const msg = take(8 + n * 16); if (!msg) return;
            events.push({ type: 'setDesktopSize', width: msg.readUInt16BE(2), height: msg.readUInt16BE(4), screens: n, screenId: msg.readUInt32BE(8) });
            const reply = onSetDesktopSize?.({ width: msg.readUInt16BE(2), height: msg.readUInt16BE(4) }, { socket, events });
            if (reply) socket.write(reply);
            return;
          }
          throw new Error(`fake server: unknown client message ${type}`);
        }
        default:
          buf = Buffer.alloc(0);
      }
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    events,
    get connections() { return connections; },
    /** The most recently accepted client socket, for writing unsolicited messages. */
    get lastSocket() { return lastSocket; },
    of: type => events.filter(e => e.type === type),
    /** Drops every client, as a network failure would. */
    dropAll() { for (const s of sockets) s.destroy(); },
    close() { for (const s of sockets) s.destroy(); return new Promise(r => server.close(r)); },
  };
}

/* ------------------------------------------------------ message builders */

const wirePixel = ([r, g, b]) => Buffer.from([b, g, r, 0]);

function rectHeader(x, y, w, h, encoding) {
  const m = Buffer.alloc(12);
  m.writeUInt16BE(x, 0); m.writeUInt16BE(y, 2); m.writeUInt16BE(w, 4); m.writeUInt16BE(h, 6);
  m.writeInt32BE(encoding, 8);
  return m;
}

export function update(...rects) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(rects.length, 2);
  return Buffer.concat([head, ...rects]);
}

/** Raw rectangle; `colourAt(x, y)` returns [r, g, b] for each pixel. */
export function rawRect(x, y, w, h, colourAt) {
  const px = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px.push(wirePixel(colourAt(i, j)));
  return Buffer.concat([rectHeader(x, y, w, h, 0), ...px]);
}

export function copyRect(x, y, w, h, srcX, srcY) {
  const src = Buffer.alloc(4);
  src.writeUInt16BE(srcX, 0); src.writeUInt16BE(srcY, 2);
  return Buffer.concat([rectHeader(x, y, w, h, 1), src]);
}

export function rreRect(x, y, w, h, background, subrects) {
  const count = Buffer.alloc(4); count.writeUInt32BE(subrects.length);
  const parts = subrects.map(s => {
    const m = Buffer.alloc(8);
    m.writeUInt16BE(s.x, 0); m.writeUInt16BE(s.y, 2); m.writeUInt16BE(s.w, 4); m.writeUInt16BE(s.h, 6);
    return Buffer.concat([wirePixel(s.colour), m]);
  });
  return Buffer.concat([rectHeader(x, y, w, h, 2), count, wirePixel(background), ...parts]);
}

/** Hextile rectangle from pre-encoded tiles (see `hextileTile`). */
export function hextileRect(x, y, w, h, tiles) {
  return Buffer.concat([rectHeader(x, y, w, h, 5), ...tiles]);
}

export function hextileTile({ raw, bg, fg, subrects }) {
  if (raw) return Buffer.concat([Buffer.from([1]), ...raw.map(wirePixel)]);
  let flags = 0;
  const parts = [];
  if (bg) { flags |= 2; parts.push(wirePixel(bg)); }
  if (fg) { flags |= 4; parts.push(wirePixel(fg)); }
  if (subrects?.length) {
    flags |= 8;
    const coloured = subrects.some(s => s.colour);
    if (coloured) flags |= 16;
    parts.push(Buffer.from([subrects.length]));
    for (const s of subrects) {
      if (coloured) parts.push(wirePixel(s.colour));
      parts.push(Buffer.from([(s.x << 4) | s.y, ((s.w - 1) << 4) | (s.h - 1)]));
    }
  }
  return Buffer.concat([Buffer.from([flags]), ...parts]);
}

export function desktopSize(w, h) {
  return rectHeader(0, 0, w, h, -223);
}

export function serverCutText(text) {
  const body = Buffer.from(text, 'latin1');
  const m = Buffer.alloc(8 + body.length);
  m.writeUInt8(3, 0); m.writeUInt32BE(body.length, 4); body.copy(m, 8);
  return m;
}

/** Applies decoded rectangles to an RGBA framebuffer, as a UI would. */
export function applyRects(fb, fbWidth, rects) {
  for (const r of rects) {
    if (r.src) {
      // Copy through a temporary so overlapping source and destination work.
      const tmp = Buffer.alloc(r.width * r.height * 4);
      for (let j = 0; j < r.height; j++) {
        fb.copy(tmp, j * r.width * 4, ((r.src.y + j) * fbWidth + r.src.x) * 4, ((r.src.y + j) * fbWidth + r.src.x + r.width) * 4);
      }
      for (let j = 0; j < r.height; j++) {
        tmp.copy(fb, ((r.y + j) * fbWidth + r.x) * 4, j * r.width * 4, (j + 1) * r.width * 4);
      }
    } else if (r.data) {
      for (let j = 0; j < r.height; j++) {
        r.data.copy(fb, ((r.y + j) * fbWidth + r.x) * 4, j * r.width * 4, (j + 1) * r.width * 4);
      }
    }
  }
}

export const rgbaAt = (fb, fbWidth, x, y) => [...fb.subarray((y * fbWidth + x) * 4, (y * fbWidth + x) * 4 + 4)];

/* ---------------------------------------------------- extensions */

export const CLIP = {
  encoding: 0xc0a1e5ce | 0,
  text: 1, caps: 1 << 24, request: 1 << 25, peek: 1 << 26, notify: 1 << 27, provide: 1 << 28,
};

const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

/** ServerCutText in its Extended Clipboard form (negative length). */
export function extendedClipboardMessage(flags, body = Buffer.alloc(0)) {
  const payload = Buffer.concat([u32(flags), body]);
  const head = Buffer.alloc(8);
  head.writeUInt8(3, 0);
  head.writeInt32BE(-payload.length, 4);
  return Buffer.concat([head, payload]);
}

/**
 * A Provide message carrying UTF-8 text. By default compressed the way
 * TigerVNC does it — a sync flush, not a finished zlib stream — which a strict
 * decompressor rejects. `finished: true` produces a complete stream instead.
 */
export function extendedClipboardProvide(text, { finished = false } = {}) {
  const data = Buffer.from(`${text.replace(/\n/g, '\r\n')}\0`, 'utf8');
  const packed = deflateSync(Buffer.concat([u32(data.length), data]),
    finished ? {} : { finishFlush: zlib.Z_SYNC_FLUSH });
  return extendedClipboardMessage(CLIP.provide | CLIP.text, packed);
}

/** ExtendedDesktopSize rectangle: reason (x), status (y), one screen. */
export function extendedDesktopSize(w, h, { reason = 0, status = 0, screenId = 7 } = {}) {
  const head = rectHeader(reason, status, w, h, -308);
  const screens = Buffer.alloc(4 + 16);
  screens.writeUInt8(1, 0);
  screens.writeUInt32BE(screenId, 4);
  screens.writeUInt16BE(w, 12); screens.writeUInt16BE(h, 14);
  return Buffer.concat([head, screens]);
}
