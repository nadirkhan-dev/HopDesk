import type { Duplex } from 'node:stream';
import type { MessageLink, SignalingMessage } from '@hopdesk/protocol';

/**
 * A MessageLink over a byte stream (a TCP socket on the LAN): each message is
 * a 4-byte big-endian length followed by that many bytes of UTF-8 JSON.
 * The length is checked before any buffering, so a peer cannot make us
 * allocate more than MAX_FRAME_BYTES by announcing a huge frame.
 */

export const MAX_FRAME_BYTES = 6 * 1024 * 1024;

export class FramedLink implements MessageLink {
  private handler: (message: unknown) => void = () => {};
  private readonly closeHandlers: ((error?: Error) => void)[] = [];
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private expected = -1;
  private backlog: unknown[] = [];
  private hasHandler = false;
  closed = false;

  constructor(private readonly stream: Duplex, private readonly maxFrame = MAX_FRAME_BYTES) {
    stream.on('data', (chunk: Buffer) => this.receive(chunk));
    stream.on('error', err => this.close(err));
    stream.on('close', () => this.close());
    stream.on('end', () => this.close());
  }

  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    for (;;) {
      if (this.expected < 0) {
        if (this.bufferedBytes < 4) return;
        const header = this.take(4);
        this.expected = header.readUInt32BE(0);
        if (this.expected > this.maxFrame) {
          this.close(new Error(`Frame of ${this.expected} bytes exceeds the ${this.maxFrame} byte limit`));
          return;
        }
      }
      if (this.bufferedBytes < this.expected) return;
      const body = this.take(this.expected);
      this.expected = -1;
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        this.close(new Error('Received a frame that is not valid JSON'));
        return;
      }
      if (this.hasHandler) this.handler(message);
      else this.backlog.push(message);
      if (this.closed) return;
    }
  }

  private take(n: number): Buffer {
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.buffered = rest.length ? [rest] : [];
    this.bufferedBytes = rest.length;
    return out;
  }

  send(message: SignalingMessage) {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > this.maxFrame) throw new Error('Message too large to send');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.stream.write(Buffer.concat([header, body]));
  }

  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    this.hasHandler = true;
    for (const m of this.backlog.splice(0)) handler(m);
  }

  onClose(handler: (error?: Error) => void) {
    if (this.closed) handler();
    else this.closeHandlers.push(handler);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.buffered = [];
    // end() flushes anything already queued (e.g. a final error reply) before closing.
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 2000).unref();
    for (const h of this.closeHandlers.splice(0)) h(error);
  }
}
