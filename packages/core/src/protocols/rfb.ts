import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { constants as zlib, deflateSync, inflateSync } from 'node:zlib';
import { desEncryptEcb } from './des.js';

/**
 * RFB (VNC) client.
 *
 * Implemented directly rather than shelling out to a viewer, because the whole
 * point of this app is rendering the remote screen *inside* it — with our own
 * scaling, input handling and reconnect. A spawned `vncviewer` window cannot be
 * embedded, styled, or recovered from when it dies.
 *
 * Protocol: RFB 3.8 (RFC 6143). The handshake is short and rigid:
 *
 *   server → "RFB 003.008\n"
 *   client → "RFB 003.008\n"
 *   server → [count][security types...]
 *   client → [chosen type]
 *   ... type-specific auth ...
 *   server → [security result]
 *   client → [shared flag]          (ClientInit)
 *   server → [width][height][pixel format][name]   (ServerInit)
 *
 * After that it is request/update ping-pong, driven by the client asking for
 * regions it wants.
 */

export interface RfbOptions {
  host: string;
  port?: number;
  password?: string;
  /** false tells the server to disconnect other clients. Default true. */
  shared?: boolean;
  /** Milliseconds before giving up on connect or handshake. */
  timeoutMs?: number;
}

export interface ServerInfo {
  width: number;
  height: number;
  name: string;
  bitsPerPixel: number;
  depth: number;
  trueColour: boolean;
}

export interface Rect {
  x: number; y: number; width: number; height: number;
  encoding: number;
  /** RGBA, 4 bytes per pixel, ready for a canvas or texture upload. */
  data?: Buffer;
  /**
   * CopyRect only: the top-left of the region, already on screen, to copy
   * into this rectangle. The pixels are not sent again — the client must copy
   * them from its own framebuffer.
   */
  src?: { x: number; y: number };
}

/** Security types we understand. Others are rejected by name so the error is useful. */
const SEC_NONE = 1;
const SEC_VNC_AUTH = 2;

const SEC_NAMES: Record<number, string> = {
  0: 'Invalid', 1: 'None', 2: 'VNC Authentication',
  5: 'RA2', 6: 'RA2ne', 16: 'Tight', 18: 'TLS', 19: 'VeNCrypt',
  30: 'Apple Remote Desktop',
};

export const ENCODING_RAW = 0;
export const ENCODING_COPY_RECT = 1;
export const ENCODING_RRE = 2;
export const ENCODING_HEXTILE = 5;
export const ENCODING_DESKTOP_SIZE = -223;
/** Server-side resizing of the remote desktop, and multi-screen layouts. */
export const ENCODING_EXTENDED_DESKTOP_SIZE = -308;
/**
 * Extended Clipboard: UTF-8 text, negotiated capabilities, zlib-compressed.
 * The original cut-text messages are Latin-1 only, which silently mangles
 * Arabic, CJK and most of the world's text.
 */
export const ENCODING_EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0;

/**
 * Preference order sent to the server. CopyRect first because moving a window
 * costs eight bytes instead of the whole region; Hextile before Raw because a
 * mostly flat desktop compresses by an order of magnitude with no zlib state to
 * keep in sync. Raw last, which every server supports.
 */
export const SUPPORTED_ENCODINGS = [
  ENCODING_COPY_RECT, ENCODING_HEXTILE, ENCODING_RRE, ENCODING_RAW, ENCODING_DESKTOP_SIZE,
  ENCODING_EXTENDED_DESKTOP_SIZE, ENCODING_EXTENDED_CLIPBOARD,
];

/* Extended Clipboard flags: formats in the low bits, actions in the high byte. */
const CLIP_TEXT = 1 << 0;
const CLIP_CAPS = 1 << 24;
const CLIP_REQUEST = 1 << 25;
const CLIP_PEEK = 1 << 26;
const CLIP_NOTIFY = 1 << 27;
const CLIP_PROVIDE = 1 << 28;
/** Largest clipboard text accepted or sent, to bound memory use. */
const CLIP_MAX_BYTES = 10 * 1024 * 1024;

/** One screen of the remote desktop, as ExtendedDesktopSize reports it. */
export interface RemoteScreen { id: number; x: number; y: number; width: number; height: number; flags: number }

/* Hextile subencoding bits (RFC 6143 §7.7.4). */
const HEXTILE_RAW = 1;
const HEXTILE_BACKGROUND = 2;
const HEXTILE_FOREGROUND = 4;
const HEXTILE_ANY_SUBRECTS = 8;
const HEXTILE_SUBRECTS_COLOURED = 16;

export declare interface RfbClient {
  on(e: 'connected', l: (info: ServerInfo) => void): this;
  on(e: 'rect', l: (rect: Rect) => void): this;
  /** Every rectangle of the current FramebufferUpdate has been delivered. */
  on(e: 'updateEnd', l: () => void): this;
  on(e: 'resize', l: (size: { width: number; height: number }) => void): this;
  on(e: 'clipboard', l: (text: string) => void): this;
  /** The server supports resizing the desktop; `screens` is its layout. */
  on(e: 'screens', l: (screens: RemoteScreen[]) => void): this;
  /** A SetDesktopSize request was refused (status is the RFB result code). */
  on(e: 'resizeRejected', l: (status: number) => void): this;
  on(e: 'error', l: (err: Error) => void): this;
  on(e: 'close', l: (reason: string) => void): this;
}

export class RfbClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private state: 'version' | 'security' | 'security33' | 'auth' | 'result' | 'init' | 'ready' = 'version';
  private info: ServerInfo | null = null;
  private closed = false;
  /** Negotiated protocol minor version: 3, 7 or 8. */
  private minor = 8;
  /** Actions the server's Extended Clipboard supports, or null for Latin-1 cut text only. */
  private clipActions: number | null = null;
  /** Local text waiting for the server to request it. */
  private clipPending: string | null = null;
  /** The server's screen layout, once it has shown it supports resizing. */
  private screens: RemoteScreen[] | null = null;

  /** Whether clipboard text of any script reaches the server intact. */
  get unicodeClipboard() { return this.clipActions !== null; }
  /** Whether the remote desktop can be resized from here. */
  get canResize() { return this.screens !== null; }

  constructor(private readonly opts: RfbOptions) { super(); }

  get serverInfo() { return this.info; }

  connect(): Promise<ServerInfo> {
    const port = this.opts.port ?? 5900;
    const timeout = this.opts.timeoutMs ?? 10_000;

    return new Promise((resolve, reject) => {
      // A handshake that stalls must fail loudly. Without this the promise
      // hangs forever on a host that accepts TCP and then says nothing —
      // which is exactly what a misconfigured firewall looks like.
      const timer = setTimeout(() => {
        // Reported as an error, not a plain close, so listeners see why.
        this.fail(new Error(`No response from ${this.opts.host}:${port} after ${timeout}ms`));
      }, timeout);

      const settle = (err?: Error) => {
        clearTimeout(timer);
        this.off('connected', onOk);
        this.off('error', onErr);
        this.off('close', onClose);
        if (err) reject(err);
      };
      const onOk = (info: ServerInfo) => { settle(); resolve(info); };
      const onErr = (err: Error) => settle(err);
      // A server that hangs up mid-handshake (or a disconnect() during it) must
      // settle the promise now, not when the timeout eventually fires.
      const onClose = (reason: string) => settle(new Error(
        reason === 'Connection closed' ? 'The server closed the connection during the handshake' : reason));

      this.once('connected', onOk);
      this.once('error', onErr);
      this.once('close', onClose);

      const socket = createConnection({ host: this.opts.host, port });
      this.socket = socket;

      // Remote desktop is latency-sensitive and its packets are tiny. Nagle
      // would coalesce keystrokes into 40ms batches and make typing feel awful.
      socket.setNoDelay(true);

      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try { this.drain(); }
        catch (e) { this.fail(e as Error); }
      });
      socket.on('error', e => this.fail(e));
      socket.on('close', () => {
        if (!this.closed) { this.closed = true; this.emit('close', 'Connection closed'); }
      });
    });
  }

  /* ------------------------------------------------------------ parsing */

  /** Consumes whatever complete messages are in the buffer. */
  private drain() {
    for (;;) {
      const before = this.buffer.length;
      switch (this.state) {
        case 'version': this.readVersion(); break;
        case 'security': this.readSecurity(); break;
        case 'security33': this.readSecurity33(); break;
        case 'auth': this.readAuthChallenge(); break;
        case 'result': this.readSecurityResult(); break;
        case 'init': this.readServerInit(); break;
        case 'ready': this.readMessage(); break;
      }
      // No progress means we need more bytes; wait for the next chunk.
      if (this.buffer.length === before) return;
    }
  }

  private take(n: number): Buffer | null {
    if (this.buffer.length < n) return null;
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  private readVersion() {
    const head = this.take(12);
    if (!head) return;
    const version = head.toString('ascii');
    if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) {
      throw new Error(`Not a VNC server — it replied "${version.trim().slice(0, 20)}"`);
    }
    const minor = Number(version.slice(8, 11));
    // Speak 3.8 when we can; 3.3 and 3.7 differ in the security handshake and
    // are still common on embedded devices and older macOS.
    this.minor = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this.send(Buffer.from(`RFB 003.00${this.minor}\n`, 'ascii'));
    // 3.3 has no list to choose from: the server announces the one type it picked.
    this.state = this.minor === 3 ? 'security33' : 'security';
  }

  /** RFB 3.3: a single u32 security type chosen by the server, 0 meaning failure. */
  private readSecurity33() {
    if (this.buffer.length < 4) return;
    const type = this.buffer.readUInt32BE(0);

    if (type === 0) {
      if (this.buffer.length < 8) return;
      const len = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + len) return;
      const reason = this.buffer.subarray(8, 8 + len).toString('utf8');
      this.take(8 + len);
      throw new Error(`Server refused the connection: ${reason}`);
    }

    this.take(4);
    if (type === SEC_NONE) {
      // No SecurityResult follows None in 3.3.
      this.send(Buffer.from([this.opts.shared === false ? 0 : 1]));
      this.state = 'init';
      return;
    }
    if (type === SEC_VNC_AUTH) {
      if (!this.opts.password) throw new Error('This server needs a password');
      this.state = 'auth';
      return;
    }
    throw new Error(
      `No supported authentication method. The server requires: ${SEC_NAMES[type] ?? `type ${type}`}`);
  }

  private readSecurity() {
    const countByte = this.buffer[0];
    if (countByte === undefined) return;

    if (countByte === 0) {
      // Failure: the server follows with a reason string.
      const head = this.take(5);
      if (!head) return;
      const len = head.readUInt32BE(1);
      const reason = this.take(len);
      if (!reason) { this.buffer = Buffer.concat([head, this.buffer]); return; }
      throw new Error(`Server refused the connection: ${reason.toString('utf8')}`);
    }

    const total = 1 + countByte;
    const block = this.take(total);
    if (!block) return;

    const offered = [...block.subarray(1)];
    if (offered.includes(SEC_VNC_AUTH) && this.opts.password) {
      this.send(Buffer.from([SEC_VNC_AUTH]));
      this.state = 'auth';
      return;
    }
    if (offered.includes(SEC_NONE)) {
      this.send(Buffer.from([SEC_NONE]));
      // 3.8 sends a SecurityResult even for None; earlier versions do not.
      if (this.minor >= 8) {
        this.state = 'result';
      } else {
        this.send(Buffer.from([this.opts.shared === false ? 0 : 1]));   // ClientInit
        this.state = 'init';
      }
      return;
    }
    if (offered.includes(SEC_VNC_AUTH) && !this.opts.password) {
      throw new Error('This server needs a password');
    }

    const names = offered.map(t => SEC_NAMES[t] ?? `type ${t}`).join(', ');
    throw new Error(
      `No supported authentication method. The server offers: ${names}`);
  }

  private readAuthChallenge() {
    const challenge = this.take(16);
    if (!challenge) return;
    this.send(vncEncrypt(challenge, this.opts.password ?? ''));
    this.state = 'result';
  }

  private readSecurityResult() {
    const result = this.take(4);
    if (!result) return;
    if (result.readUInt32BE(0) === 0) {
      this.send(Buffer.from([this.opts.shared === false ? 0 : 1]));   // ClientInit
      this.state = 'init';
      return;
    }
    // 3.8 appends a reason; 3.3 and 3.7 do not, so absence is not an error.
    if (this.minor >= 8) {
      if (this.buffer.length < 4) { this.buffer = Buffer.concat([result, this.buffer]); return; }
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) { this.buffer = Buffer.concat([result, this.buffer]); return; }
      const reason = this.buffer.subarray(4, 4 + len).toString('utf8');
      this.take(4 + len);
      if (reason) throw new Error(`Authentication failed: ${reason}`);
    }
    throw new Error('Authentication failed — check the password');
  }

  private readServerInit() {
    if (this.buffer.length < 24) return;
    const nameLen = this.buffer.readUInt32BE(20);
    const block = this.take(24 + nameLen);
    if (!block) return;

    this.info = {
      width: block.readUInt16BE(0),
      height: block.readUInt16BE(2),
      bitsPerPixel: block.readUInt8(4),
      depth: block.readUInt8(5),
      trueColour: block.readUInt8(7) !== 0,
      name: block.subarray(24, 24 + nameLen).toString('utf8'),
    };

    /* Ask for 32-bit true colour regardless of what the server proposed. It is
       what a canvas or GPU texture wants, and converting palette or 16-bit
       formats on our side would cost more than the bandwidth saved. */
    this.setPixelFormat();
    this.setEncodings(SUPPORTED_ENCODINGS);

    this.state = 'ready';
    this.emit('connected', this.info);
  }

  /* --------------------------------------------------------- messages */

  private pendingRect: Omit<Rect, 'data'> | null = null;
  private rectsLeft = 0;
  /** The last FramebufferUpdateRequest, so it can be repeated if unanswered. */
  private lastRequest: { incremental: boolean; area: { x: number; y: number; width: number; height: number } } | null = null;
  /** What the update being read contained. */
  private updateHadContent = false;
  private updateAnnouncedLayout = false;
  /** Decoder state for a Hextile rectangle that arrives across several reads. */
  private hextile: { out: Buffer; tile: number; bg: Buffer; fg: Buffer } | null = null;

  private readMessage() {
    if (this.rectsLeft > 0) { this.readRect(); return; }

    const type = this.buffer[0];
    if (type === undefined) return;

    switch (type) {
      case 0: {                                  // FramebufferUpdate
        const head = this.take(4);
        if (!head) return;
        this.rectsLeft = head.readUInt16BE(2);
        this.updateHadContent = false;
        this.updateAnnouncedLayout = false;
        if (this.rectsLeft === 0) this.endUpdate();
        break;
      }
      case 2:                                     // Bell
        this.take(1);
        break;
      case 3: {                                   // ServerCutText
        if (this.buffer.length < 8) return;
        const len = this.buffer.readInt32BE(4);
        const size = Math.abs(len);
        if (size > CLIP_MAX_BYTES) throw new Error('The server sent an oversized clipboard message');
        const block = this.take(8 + size);
        if (!block) return;
        if (len < 0) this.readExtendedClipboard(block.subarray(8));
        // Latin-1 by definition in RFB 3.8.
        else this.emit('clipboard', block.subarray(8).toString('latin1'));
        break;
      }
      case 150: {                                 // EndOfContinuousUpdates: never requested, ignore
        this.take(1);
        break;
      }
      default:
        // An unknown message type means the stream is out of sync; continuing
        // would produce garbage rectangles rather than an error.
        throw new Error(`Unexpected message type ${type} from server`);
    }
  }

  private readRect() {
    if (!this.pendingRect) {
      const head = this.take(12);
      if (!head) return;
      this.pendingRect = {
        x: head.readUInt16BE(0), y: head.readUInt16BE(2),
        width: head.readUInt16BE(4), height: head.readUInt16BE(6),
        encoding: head.readInt32BE(8),
      };
    }

    const r = this.pendingRect;

    if (r.encoding === ENCODING_EXTENDED_DESKTOP_SIZE) {
      if (this.buffer.length < 4) return;
      const count = this.buffer[0]!;
      const block = this.take(4 + count * 16);
      if (!block) return;
      const screens: RemoteScreen[] = [];
      for (let i = 0; i < count; i++) {
        const o = 4 + i * 16;
        screens.push({
          id: block.readUInt32BE(o), x: block.readUInt16BE(o + 4), y: block.readUInt16BE(o + 6),
          width: block.readUInt16BE(o + 8), height: block.readUInt16BE(o + 10), flags: block.readUInt32BE(o + 12),
        });
      }
      // x is the reason (0 server, 1 this client, 2 another client), y the status.
      if (r.x === 1 && r.y !== 0) {
        this.emit('resizeRejected', r.y);
      } else {
        this.screens = screens;
        const changed = this.info && (this.info.width !== r.width || this.info.height !== r.height);
        if (this.info) { this.info.width = r.width; this.info.height = r.height; }
        this.emit('screens', screens);
        if (changed) {
          this.updateHadContent = true;
          this.emit('resize', { width: r.width, height: r.height });
        } else {
          this.updateAnnouncedLayout = true;
        }
      }
      this.finishRect();
      return;
    }

    if (r.encoding === ENCODING_DESKTOP_SIZE) {
      // A pseudo-encoding: no pixel data, the framebuffer just changed size.
      if (this.info) { this.info.width = r.width; this.info.height = r.height; }
      // Before finishing: if this ends the update, listeners must already know
      // the new size when they send the next request.
      this.updateHadContent = true;
      this.emit('resize', { width: r.width, height: r.height });
      this.finishRect();
      return;
    }

    if (r.encoding === ENCODING_RAW) {
      const needed = r.width * r.height * 4;
      const data = this.take(needed);
      if (!data) return;                         // wait for the rest
      this.finishRect({ ...r, data: bgraToRgba(data) });
      return;
    }

    if (r.encoding === ENCODING_COPY_RECT) {
      const src = this.take(4);
      if (!src) return;
      this.finishRect({ ...r, src: { x: src.readUInt16BE(0), y: src.readUInt16BE(2) } });
      return;
    }

    if (r.encoding === ENCODING_RRE) {
      if (this.buffer.length < 8) return;
      const count = this.buffer.readUInt32BE(0);
      const block = this.take(8 + count * 12);
      if (!block) return;
      this.finishRect({ ...r, data: decodeRre(block, r.width, r.height) });
      return;
    }

    if (r.encoding === ENCODING_HEXTILE) {
      if (this.readHextile(r)) {
        const data = this.hextile!.out;
        this.hextile = null;
        this.finishRect({ ...r, data });
      }
      return;
    }

    throw new Error(`Server used encoding ${r.encoding}, which is not supported`);
  }

  /** Completes the current rectangle, and the update if it was the last one. */
  private finishRect(rect?: Rect) {
    this.pendingRect = null;
    this.rectsLeft--;
    if (rect) {
      this.updateHadContent = true;
      this.emit('rect', rect);
    }
    if (this.rectsLeft === 0) this.endUpdate();
  }

  /**
   * Servers that support ExtendedDesktopSize (TigerVNC among them) answer the
   * full-repaint request with nothing but their screen layout — every time,
   * since each full request re-triggers the announcement. The region stays
   * marked as changed on the server, so an *incremental* request for the same
   * area delivers the pixels. The update is not reported as finished, so
   * whoever asked still gets exactly one answer with pixels in it.
   */
  private endUpdate() {
    const last = this.lastRequest;
    if (!this.updateHadContent && this.updateAnnouncedLayout && last && !last.incremental) {
      this.updateAnnouncedLayout = false;
      this.requestUpdate(true, last.area);
      return;
    }
    this.emit('updateEnd');
  }

  /**
   * Decodes as many complete 16×16 tiles as the buffer holds, consuming only
   * whole tiles so decoding resumes cleanly when the next chunk arrives.
   * Returns true once every tile of the rectangle is decoded.
   */
  private readHextile(r: Omit<Rect, 'data'>): boolean {
    const cols = Math.ceil(r.width / 16);
    const tiles = cols * Math.ceil(r.height / 16);
    if (!this.hextile) {
      this.hextile = { out: Buffer.alloc(r.width * r.height * 4), tile: 0, bg: Buffer.alloc(4), fg: Buffer.alloc(4) };
    }
    const h = this.hextile;

    while (h.tile < tiles) {
      const tx = (h.tile % cols) * 16;
      const ty = Math.floor(h.tile / cols) * 16;
      const tw = Math.min(16, r.width - tx);
      const th = Math.min(16, r.height - ty);

      const buf = this.buffer;
      if (buf.length < 1) return false;
      const sub = buf[0]!;
      let pos = 1;

      if (sub & HEXTILE_RAW) {
        const n = tw * th * 4;
        if (buf.length < pos + n) return false;
        const pixels = bgraToRgba(buf.subarray(pos, pos + n));
        for (let row = 0; row < th; row++) {
          pixels.copy(h.out, ((ty + row) * r.width + tx) * 4, row * tw * 4, (row + 1) * tw * 4);
        }
        pos += n;
      } else {
        let bg = h.bg;
        let fg = h.fg;
        if (sub & HEXTILE_BACKGROUND) {
          if (buf.length < pos + 4) return false;
          bg = pixelToRgba(buf, pos); pos += 4;
        }
        if (sub & HEXTILE_FOREGROUND) {
          if (buf.length < pos + 4) return false;
          fg = pixelToRgba(buf, pos); pos += 4;
        }
        let count = 0;
        if (sub & HEXTILE_ANY_SUBRECTS) {
          if (buf.length < pos + 1) return false;
          count = buf[pos]!; pos += 1;
          const each = sub & HEXTILE_SUBRECTS_COLOURED ? 6 : 2;
          if (buf.length < pos + count * each) return false;
        }

        // The whole tile is present; only now is state committed.
        h.bg = bg; h.fg = fg;
        fillRgba(h.out, r.width, tx, ty, tw, th, bg);
        for (let i = 0; i < count; i++) {
          let colour = fg;
          if (sub & HEXTILE_SUBRECTS_COLOURED) { colour = pixelToRgba(buf, pos); pos += 4; }
          const xy = buf[pos]!; const wh = buf[pos + 1]!; pos += 2;
          const sx = xy >> 4; const sy = xy & 15;
          const sw = (wh >> 4) + 1; const sh = (wh & 15) + 1;
          fillRgba(h.out, r.width, tx + sx, ty + sy, Math.min(sw, tw - sx), Math.min(sh, th - sy), colour);
        }
      }

      this.take(pos);
      h.tile++;
    }
    return true;
  }

  /* ----------------------------------------------------------- output */

  private send(buf: Buffer) { this.socket?.write(buf); }

  private setPixelFormat() {
    const m = Buffer.alloc(20);
    m.writeUInt8(0, 0);                 // SetPixelFormat
    m.writeUInt8(32, 4);                // bits per pixel
    m.writeUInt8(24, 5);                // depth
    m.writeUInt8(0, 6);                 // little endian
    m.writeUInt8(1, 7);                 // true colour
    m.writeUInt16BE(255, 8);            // red max
    m.writeUInt16BE(255, 10);           // green max
    m.writeUInt16BE(255, 12);           // blue max
    m.writeUInt8(16, 14);               // red shift
    m.writeUInt8(8, 15);                // green shift
    m.writeUInt8(0, 16);                // blue shift
    this.send(m);
  }

  private setEncodings(encodings: number[]) {
    const m = Buffer.alloc(4 + encodings.length * 4);
    m.writeUInt8(2, 0);
    m.writeUInt16BE(encodings.length, 2);
    encodings.forEach((e, i) => m.writeInt32BE(e, 4 + i * 4));
    this.send(m);
  }

  /** Asks for a region. `incremental` false forces a full repaint. */
  requestUpdate(incremental = true, area?: { x: number; y: number; width: number; height: number }) {
    if (!this.info) return;
    const a = area ?? { x: 0, y: 0, width: this.info.width, height: this.info.height };
    this.lastRequest = { incremental, area: { ...a } };
    const m = Buffer.alloc(10);
    m.writeUInt8(3, 0);
    m.writeUInt8(incremental ? 1 : 0, 1);
    m.writeUInt16BE(a.x, 2);
    m.writeUInt16BE(a.y, 4);
    m.writeUInt16BE(a.width, 6);
    m.writeUInt16BE(a.height, 8);
    this.send(m);
  }

  /** X11 keysym, not a character code. The UI layer does the mapping. */
  sendKey(keysym: number, down: boolean) {
    const m = Buffer.alloc(8);
    m.writeUInt8(4, 0);
    m.writeUInt8(down ? 1 : 0, 1);
    m.writeUInt32BE(keysym, 4);
    this.send(m);
  }

  /** buttonMask is a bitfield: 1 left, 2 middle, 4 right, 8/16 wheel. */
  sendPointer(x: number, y: number, buttonMask: number) {
    const m = Buffer.alloc(6);
    m.writeUInt8(5, 0);
    m.writeUInt8(buttonMask, 1);
    m.writeUInt16BE(x, 2);
    m.writeUInt16BE(y, 4);
    this.send(m);
  }

  /**
   * Offers local clipboard text to the server.
   *
   * With Extended Clipboard the server is notified and asks for the text,
   * which then travels as UTF-8. Without it the only option is Latin-1 cut
   * text; the return value says whether the text survived that intact, so a
   * UI can warn instead of silently delivering question marks.
   */
  sendClipboard(text: string): { lossless: boolean } {
    if (this.clipActions !== null) {
      this.clipPending = text;
      if (this.clipActions & CLIP_NOTIFY) this.sendExtendedClipboard(CLIP_NOTIFY | CLIP_TEXT);
      else if (this.clipActions & CLIP_PROVIDE) this.provideClipboard();
      return { lossless: true };
    }
    const body = Buffer.from(text, 'latin1');    // RFB 3.8 predates UTF-8 here
    const m = Buffer.alloc(8 + body.length);
    m.writeUInt8(6, 0);
    m.writeUInt32BE(body.length, 4);
    body.copy(m, 8);
    this.send(m);
    // Latin-1 holds U+0000–U+00FF; anything else was replaced.
    return { lossless: [...text].every(ch => ch.codePointAt(0)! <= 0xff) };
  }

  private readExtendedClipboard(payload: Buffer) {
    if (payload.length < 4) return;
    const flags = payload.readUInt32BE(0);
    const body = payload.subarray(4);

    if (flags & CLIP_CAPS) {
      this.clipActions = flags & (CLIP_REQUEST | CLIP_PEEK | CLIP_NOTIFY | CLIP_PROVIDE);
      // Answer with our own capabilities: text only, every action, and the
      // largest text we will accept unannounced.
      const caps = Buffer.alloc(8);
      caps.writeUInt32BE(CLIP_CAPS | CLIP_TEXT | CLIP_REQUEST | CLIP_PEEK | CLIP_NOTIFY | CLIP_PROVIDE, 0);
      caps.writeUInt32BE(CLIP_MAX_BYTES, 4);
      this.sendClientCutText(caps);
      return;
    }
    if (flags & CLIP_REQUEST) {
      if (flags & CLIP_TEXT) this.provideClipboard();
      return;
    }
    if (flags & CLIP_PEEK) {
      this.sendExtendedClipboard(CLIP_NOTIFY | (this.clipPending !== null ? CLIP_TEXT : 0));
      return;
    }
    if (flags & CLIP_NOTIFY) {
      // The remote clipboard changed; ask for the text if there is any.
      if (flags & CLIP_TEXT) this.sendExtendedClipboard(CLIP_REQUEST | CLIP_TEXT);
      return;
    }
    if (flags & CLIP_PROVIDE && flags & CLIP_TEXT) {
      let raw: Buffer;
      try {
        // Servers such as TigerVNC end the stream with a sync flush rather than
        // finishing it; a strict inflate would reject every such message.
        raw = inflateSync(body, { maxOutputLength: CLIP_MAX_BYTES + 4, finishFlush: zlib.Z_SYNC_FLUSH });
      } catch {
        return;                                   // a damaged clipboard is not worth a disconnect
      }
      if (raw.length < 4) return;
      const size = Math.min(raw.readUInt32BE(0), raw.length - 4);
      // UTF-8, NUL-terminated, CRLF line endings on the wire.
      const text = raw.subarray(4, 4 + size).toString('utf8').replace(/\0+$/, '').replace(/\r\n/g, '\n');
      this.emit('clipboard', text);
    }
  }

  private provideClipboard() {
    if (this.clipPending === null) return;
    const text = Buffer.from(`${this.clipPending.replace(/\r?\n/g, '\r\n')}\0`, 'utf8');
    if (text.length > CLIP_MAX_BYTES) return;
    const size = Buffer.alloc(4);
    size.writeUInt32BE(text.length, 0);
    const flags = Buffer.alloc(4);
    flags.writeUInt32BE(CLIP_PROVIDE | CLIP_TEXT, 0);
    this.sendClientCutText(Buffer.concat([flags, deflateSync(Buffer.concat([size, text]))]));
  }

  private sendExtendedClipboard(flags: number) {
    const m = Buffer.alloc(4);
    m.writeUInt32BE(flags >>> 0, 0);
    this.sendClientCutText(m);
  }

  /** ClientCutText with a negative length: the Extended Clipboard form. */
  private sendClientCutText(payload: Buffer) {
    const m = Buffer.alloc(8);
    m.writeUInt8(6, 0);
    m.writeInt32BE(-payload.length, 4);
    this.send(Buffer.concat([m, payload]));
  }

  /**
   * Asks the server to change the remote desktop to this size. Only servers
   * that announced ExtendedDesktopSize support it; the answer arrives as a
   * `screens`/`resize` event, or `resizeRejected`.
   */
  requestDesktopSize(width: number, height: number): boolean {
    if (!this.screens || width < 1 || height < 1) return false;
    const w = Math.min(Math.round(width), 16384);
    const h = Math.min(Math.round(height), 16384);
    const first = this.screens[0] ?? { id: 0, flags: 0 };
    const m = Buffer.alloc(8 + 16);
    m.writeUInt8(251, 0);                         // SetDesktopSize
    m.writeUInt16BE(w, 2);
    m.writeUInt16BE(h, 4);
    m.writeUInt8(1, 6);                           // one screen covering everything
    m.writeUInt32BE(first.id, 8);
    m.writeUInt16BE(0, 12); m.writeUInt16BE(0, 14);
    m.writeUInt16BE(w, 16); m.writeUInt16BE(h, 18);
    m.writeUInt32BE(first.flags, 20);
    this.send(m);
    return true;
  }

  disconnect() { this.destroy('Disconnected'); }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    this.emit('error', err);
    this.socket?.destroy();
  }

  private destroy(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.emit('close', reason);
  }
}

/**
 * VNC's authentication DES, which is not quite DES.
 *
 * The password is truncated or padded to 8 bytes, and then **every byte has its
 * bits reversed** before being used as the key — a quirk of the original
 * implementation that every server has copied ever since. Get this wrong and
 * authentication fails with no clue as to why, which is why it is isolated and
 * tested against a known vector.
 */
export function vncEncrypt(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]!);

  return desEncryptEcb(challenge, key);
}

function reverseBits(b: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) out |= 0x80 >> i;
  return out;
}

/** One pixel in the negotiated wire format, as opaque RGBA. */
function pixelToRgba(buf: Buffer, offset: number): Buffer {
  return Buffer.from([buf[offset + 2]!, buf[offset + 1]!, buf[offset]!, 255]);
}

function fillRgba(out: Buffer, stride: number, x: number, y: number, w: number, h: number, rgba: Buffer) {
  for (let row = y; row < y + h; row++) {
    for (let i = (row * stride + x) * 4, end = i + w * 4; i < end; i += 4) {
      out[i] = rgba[0]!; out[i + 1] = rgba[1]!; out[i + 2] = rgba[2]!; out[i + 3] = 255;
    }
  }
}

/** RRE: a background colour and a list of solid subrectangles. */
export function decodeRre(block: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  const count = block.readUInt32BE(0);
  fillRgba(out, width, 0, 0, width, height, pixelToRgba(block, 4));
  for (let i = 0, pos = 8; i < count; i++, pos += 12) {
    const colour = pixelToRgba(block, pos);
    const x = block.readUInt16BE(pos + 4);
    const y = block.readUInt16BE(pos + 6);
    // Clamped: a malformed subrectangle must not write outside the buffer.
    const w = Math.min(block.readUInt16BE(pos + 8), width - x);
    const h = Math.min(block.readUInt16BE(pos + 10), height - y);
    if (w > 0 && h > 0) fillRgba(out, width, x, y, w, h, colour);
  }
  return out;
}

/** The wire format we requested is BGRA; canvases and GL want RGBA. */
export function bgraToRgba(src: Buffer): Buffer {
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2]!;
    out[i + 1] = src[i + 1]!;
    out[i + 2] = src[i]!;
    out[i + 3] = 255;                 // servers leave the alpha byte undefined
  }
  return out;
}
