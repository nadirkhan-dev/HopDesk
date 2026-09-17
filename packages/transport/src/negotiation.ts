import type { ControlMessage, SecureControl } from '@hopdesk/protocol';
import { assertSecureSdp } from './sdp.js';

/**
 * WebRTC offer/answer and ICE exchange over the sealed control channel.
 *
 * `PeerAdapter` is the seam to the platform's RTCPeerConnection (in Electron
 * it lives in a renderer; main forwards control messages to it). Keeping the
 * seam this small means the negotiation rules — who offers, which messages are
 * legal in which state, SDP security checks, timeouts — are ordinary code
 * with ordinary tests, independent of where the peer connection runs.
 *
 * The viewer always offers (it knows which streams it wants); the host answers.
 */

export interface IceCandidate { candidate: string; sdpMid?: string; sdpMLineIndex?: number }

export interface PeerAdapter {
  /** Viewer: create and apply a local offer. */
  createOffer(): Promise<string>;
  /** Host: apply the remote offer, create and apply the answer. */
  answer(offerSdp: string): Promise<string>;
  /** Viewer: apply the remote answer. */
  applyAnswer(answerSdp: string): Promise<void>;
  addRemoteCandidate(candidate: IceCandidate | null): Promise<void>;
  /** Local candidates as they are gathered; null when gathering is complete. */
  onLocalCandidate(handler: (candidate: IceCandidate | null) => void): void;
  /** Resolves when the peer connection reports 'connected'; rejects on 'failed'. */
  connected(timeoutMs: number): Promise<void>;
}

export class NegotiationError extends Error {}

function forwardCandidates(control: SecureControl, adapter: PeerAdapter) {
  adapter.onLocalCandidate(c => {
    if (c === null) control.send({ type: 'rtc-ice-done' });
    else control.send({ type: 'rtc-ice', candidate: c.candidate, ...(c.sdpMid !== undefined ? { sdpMid: c.sdpMid } : {}), ...(c.sdpMLineIndex !== undefined ? { sdpMLineIndex: c.sdpMLineIndex } : {}) });
  });
}

type Handler = (m: ControlMessage) => Promise<void> | void;

/** Serialises handling so a candidate is never applied before its description. */
function sequential(control: SecureControl, handle: Handler, fail: (e: Error) => void) {
  let chain = Promise.resolve();
  control.onMessage(m => {
    chain = chain.then(() => handle(m)).catch(err => fail(err as Error));
  });
}

async function run(control: SecureControl, adapter: PeerAdapter, timeoutMs: number, role: 'viewer' | 'host') {
  let failed: (e: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { failed = reject; });
  failure.catch(() => {});
  control.onClose(err => failed(new NegotiationError(`The control connection closed during setup${err ? `: ${err.message}` : ''}`)));

  let described = false;
  const pendingCandidates: (IceCandidate | null)[] = [];
  const addCandidate = async (c: IceCandidate | null) => {
    if (!described) { pendingCandidates.push(c); return; }
    await adapter.addRemoteCandidate(c);
  };
  const flush = async () => {
    described = true;
    for (const c of pendingCandidates.splice(0)) await adapter.addRemoteCandidate(c);
  };

  sequential(control, async m => {
    switch (m.type) {
      case 'rtc-offer':
        if (role !== 'host' || described) throw new NegotiationError('Unexpected offer');
        assertSecureSdp(m.sdp);
        forwardCandidates(control, adapter);
        control.send({ type: 'rtc-answer', sdp: await adapter.answer(m.sdp) });
        await flush();
        return;
      case 'rtc-answer':
        if (role !== 'viewer' || described) throw new NegotiationError('Unexpected answer');
        assertSecureSdp(m.sdp);
        await adapter.applyAnswer(m.sdp);
        await flush();
        return;
      case 'rtc-ice':
        await addCandidate({ candidate: m.candidate, ...(m.sdpMid !== undefined ? { sdpMid: m.sdpMid } : {}), ...(m.sdpMLineIndex !== undefined ? { sdpMLineIndex: m.sdpMLineIndex } : {}) });
        return;
      case 'rtc-ice-done':
        await addCandidate(null);
        return;
      case 'ping':
        control.send({ type: 'pong', t: m.t });
        return;
      case 'pong':
        return;
      case 'bye':
        throw new NegotiationError(`The other side ended the session (${m.reason})`);
      default:
        throw new NegotiationError(`Unexpected ${m.type} during setup`);
    }
  }, err => failed(err));

  if (role === 'viewer') {
    forwardCandidates(control, adapter);
    const offer = await adapter.createOffer();
    assertSecureSdp(offer);
    control.send({ type: 'rtc-offer', sdp: offer });
  }
  await Promise.race([adapter.connected(timeoutMs), failure]);
}

export async function negotiateAsViewer(control: SecureControl, adapter: PeerAdapter, timeoutMs = 20_000) {
  try { await run(control, adapter, timeoutMs, 'viewer'); }
  catch (err) { control.send({ type: 'bye', reason: 'error' }); throw err; }
}

export async function negotiateAsHost(control: SecureControl, adapter: PeerAdapter, timeoutMs = 20_000) {
  try { await run(control, adapter, timeoutMs, 'host'); }
  catch (err) { control.send({ type: 'bye', reason: 'error' }); throw err; }
}
