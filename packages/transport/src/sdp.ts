import { createHash } from 'node:crypto';

/**
 * SDP checks for WebRTC sessions.
 *
 * Media and data channels are encrypted by DTLS/SRTP, and a DTLS endpoint is
 * authenticated only by the certificate fingerprint in the peer's SDP. HopDesk
 * sends SDP exclusively through the sealed control channel, so those
 * fingerprints come from the authenticated peer and a signaling server or
 * relay cannot substitute its own. These helpers refuse SDP that would weaken
 * that: no fingerprint, a weak hash, or a non-DTLS transport.
 */

export interface SdpFingerprint { algorithm: string; value: string }

const STRONG = new Set(['sha-256', 'sha-384', 'sha-512']);

export function sdpFingerprints(sdp: string): SdpFingerprint[] {
  const out: SdpFingerprint[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (m) out.push({ algorithm: m[1]!.toLowerCase(), value: m[2]!.toUpperCase() });
  }
  return out;
}

export class InsecureSdpError extends Error {}

/** Throws unless every media section is DTLS protected with a strong fingerprint. */
export function assertSecureSdp(sdp: string): SdpFingerprint[] {
  const fingerprints = sdpFingerprints(sdp);
  if (!fingerprints.length) throw new InsecureSdpError('The session description has no DTLS fingerprint');
  const weak = fingerprints.find(f => !STRONG.has(f.algorithm));
  if (weak) throw new InsecureSdpError(`Refusing weak DTLS fingerprint hash ${weak.algorithm}`);
  const values = new Set(fingerprints.filter(f => f.algorithm === 'sha-256').map(f => f.value));
  if (values.size > 1) throw new InsecureSdpError('The session description has conflicting DTLS fingerprints');
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^m=\S+\s+\d+\s+(\S+)/.exec(line);
    if (m && !/(^|\/)(DTLS|TLS)(\/|$)/.test(m[1]!)) {
      throw new InsecureSdpError(`Refusing unencrypted media transport ${m[1]}`);
    }
  }
  return fingerprints;
}

/** The SDP-style SHA-256 fingerprint of a DER certificate, for checking the live DTLS peer. */
export function certificateFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}

/** True when the certificate the DTLS peer actually presented matches the authenticated SDP. */
export function certificateMatchesSdp(der: Uint8Array, sdp: string): boolean {
  const expected = sdpFingerprints(sdp).filter(f => f.algorithm === 'sha-256').map(f => f.value);
  return expected.length > 0 && expected.every(v => v === certificateFingerprint(der));
}
