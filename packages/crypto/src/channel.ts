import { createCipheriv, createDecipheriv } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes.js';

/**
 * Authenticated encryption for everything HopDesk sends after the handshake:
 * signaling (SDP, ICE), input, clipboard and control messages.
 *
 * AES-256-GCM from node:crypto (hardware accelerated, and available in
 * Electron's BoringSSL build, unlike some other AEADs). Every named channel
 * gets its own pair of direction-specific keys derived from the session root,
 * so a frame can be replayed neither to the other direction nor onto another
 * channel. Frames carry an explicit 64-bit counter that is also the nonce; the
 * receiver accepts only counters greater than any it has seen, which rejects
 * replays and reordering while tolerating loss on unreliable channels.
 */

export type PeerRole = 'host' | 'viewer';

const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
/** Far below GCM's limits; a session reaching it must re-handshake. */
export const MAX_COUNTER = 2 ** 48;

/** Session root key from the SPAKE2 secret and a hash binding the whole handshake. */
export function deriveSessionRoot(Ke: Uint8Array, handshakeHash: Uint8Array): Uint8Array {
  if (Ke.length < 16) throw new Error('Session secret too short');
  if (handshakeHash.length !== 32) throw new Error('Handshake hash must be 32 bytes');
  return hkdf(sha256, Ke, handshakeHash, utf8('hopdesk/session-root/v1'), 32);
}

function channelKey(root: Uint8Array, label: string, from: PeerRole): Uint8Array {
  const to = from === 'host' ? 'viewer' : 'host';
  return hkdf(sha256, root, undefined, utf8(`hopdesk/channel/v1\0${label}\0${from}->${to}`), 32);
}

function nonceFor(counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

export class SealedChannel {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private readonly labelBytes: Uint8Array;
  private sent = 0;
  private highestReceived = 0;

  constructor(root: Uint8Array, readonly label: string, readonly localRole: PeerRole) {
    if (root.length !== 32) throw new Error('Session root must be 32 bytes');
    if (!label || label.length > 64) throw new Error('Channel label must be 1-64 characters');
    const peer: PeerRole = localRole === 'host' ? 'viewer' : 'host';
    this.sendKey = channelKey(root, label, localRole);
    this.recvKey = channelKey(root, label, peer);
    this.labelBytes = utf8(label);
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (this.sent + 1 >= MAX_COUNTER) throw new Error('Channel exhausted; reconnect to rekey');
    const counter = ++this.sent;
    const header = Buffer.alloc(COUNTER_BYTES);
    header.writeBigUInt64BE(BigInt(counter));
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonceFor(counter), { authTagLength: TAG_BYTES });
    cipher.setAAD(concat(this.labelBytes, header));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return concat(header, body, cipher.getAuthTag());
  }

  /** Throws on tampering, a replayed or reordered frame, or a malformed one. */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length < COUNTER_BYTES + TAG_BYTES) throw new Error('Sealed frame too short');
    const header = frame.subarray(0, COUNTER_BYTES);
    const counterBig = Buffer.from(header).readBigUInt64BE();
    if (counterBig === 0n || counterBig >= BigInt(MAX_COUNTER)) throw new Error('Sealed frame counter out of range');
    const counter = Number(counterBig);
    if (counter <= this.highestReceived) throw new Error('Replayed or reordered frame rejected');

    const decipher = createDecipheriv('aes-256-gcm', this.recvKey, nonceFor(counter), { authTagLength: TAG_BYTES });
    decipher.setAAD(concat(this.labelBytes, header));
    decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(frame.subarray(COUNTER_BYTES, frame.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new Error('Sealed frame failed authentication');
    }
    // Only advance after the tag verified, so a forged counter cannot jam the channel.
    this.highestReceived = counter;
    return new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
  }
}
