import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import type { IceCandidate, PeerAdapter } from '@hopdesk/transport';

/**
 * The seam between the session logic in the main process and the
 * RTCPeerConnection that has to live in a renderer.
 *
 * WebRTC exists only in Chromium's renderer, while the keys, the handshake and
 * the consent decision must stay in the main process — a renderer never sees
 * the device private key or the session keys. So the main process drives the
 * peer connection by remote control: it calls methods on a renderer and
 * receives candidates and state changes back, and it is main that decides what
 * to put on the wire.
 *
 * Every message carries a session id, and replies are matched to their call, so
 * two sessions in the same renderer cannot be confused for one another.
 */

interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void }

export interface RtcPeerHandle extends PeerAdapter {
  /** Stops accepting messages for this session. */
  dispose(): void;
}

export class RtcBridge {
  private readonly peers = new Map<string, {
    contents: WebContents;
    candidates: ((c: IceCandidate | null) => void)[];
    state: { connected?: () => void; failed?: (e: Error) => void; settled: boolean };
    /** 'local', 'direct', 'relay' or 'unknown', once connected. */
    kind?: string;
  }>();
  private readonly calls = new Map<number, PendingCall>();
  private nextCall = 1;

  constructor(
    private readonly log: { info(m: string): void; warn(m: string): void },
    /** Only messages this returns true for are accepted; see ipc-guard. */
    private readonly trusted: (event: IpcMainEvent) => boolean,
  ) {
    ipcMain.on('rtc:reply', (event, reply: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }) => {
      if (!this.trusted(event)) return;
      const id = typeof reply?.id === 'number' ? reply.id : null;
      if (id === null) return;
      const pending = this.calls.get(id);
      if (!pending) return;
      this.calls.delete(id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(typeof reply.error === 'string' ? reply.error : 'The media connection failed'));
    });

    ipcMain.on('rtc:event', (event, message: { sessionId?: unknown; type?: unknown; candidate?: unknown; error?: unknown }) => {
      if (!this.trusted(event)) return;
      const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : null;
      const peer = sessionId ? this.peers.get(sessionId) : null;
      if (!peer || peer.contents !== event.sender) return;

      switch (message.type) {
        case 'candidate': {
          const c = message.candidate as Partial<IceCandidate> | null;
          if (c && typeof c.candidate === 'string') {
            const candidate: IceCandidate = { candidate: c.candidate };
            if (typeof c.sdpMid === 'string') candidate.sdpMid = c.sdpMid;
            if (typeof c.sdpMLineIndex === 'number') candidate.sdpMLineIndex = c.sdpMLineIndex;
            for (const handler of peer.candidates) handler(candidate);
          }
          return;
        }
        case 'candidates-done':
          for (const handler of peer.candidates) handler(null);
          return;
        case 'connected':
          peer.state.settled = true;
          if (typeof (message as { kind?: unknown }).kind === 'string') peer.kind = String((message as { kind?: unknown }).kind);
          peer.state.connected?.();
          return;
        case 'failed': {
          peer.state.settled = true;
          const detail = typeof message.error === 'string' ? message.error : 'the connection could not be established';
          peer.state.failed?.(new Error(detail));
          return;
        }
        default:
          return;
      }
    });
  }

  /**
   * A PeerAdapter backed by the peer connection in `contents`. The ICE servers
   * are sent with the first call, since the peer connection is created there and
   * cannot be given them later.
   */
  attach(sessionId: string, contents: WebContents, iceServers: unknown[] = [], iceTransportPolicy?: 'all' | 'relay'): RtcPeerHandle {
    const entry = { contents, candidates: [] as ((c: IceCandidate | null) => void)[], state: { settled: false } as { connected?: () => void; failed?: (e: Error) => void; settled: boolean } };
    this.peers.set(sessionId, entry);

    const call = (method: string, arg?: unknown, timeoutMs = 15_000): Promise<unknown> => {
      if (contents.isDestroyed()) return Promise.reject(new Error('The media window closed'));
      const id = this.nextCall++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.calls.delete(id);
          reject(new Error(`The media connection did not answer ${method} in time`));
        }, timeoutMs);
        this.calls.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        contents.send('rtc:call', { id, sessionId, method, arg });
      });
    };

    const asSdp = async (value: unknown) => {
      if (typeof value !== 'string' || !value.length) throw new Error('The media connection produced no session description');
      return value;
    };

    return {
      createOffer: async () => asSdp(await call('createOffer', { iceServers, iceTransportPolicy })),
      answer: async (offerSdp: string) => asSdp(await call('answer', { sdp: offerSdp, iceServers, iceTransportPolicy })),
      applyAnswer: async (answerSdp: string) => { await call('applyAnswer', answerSdp); },
      addRemoteCandidate: async (candidate: IceCandidate | null) => { await call('addRemoteCandidate', candidate); },
      onLocalCandidate: handler => { entry.candidates.push(handler); },
      connected: (timeoutMs: number) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The direct connection could not be established in time')), timeoutMs);
        entry.state.connected = () => { clearTimeout(timer); resolve(); };
        entry.state.failed = error => { clearTimeout(timer); reject(error); };
        if (entry.state.settled) { clearTimeout(timer); resolve(); }
      }),
      dispose: () => {
        this.peers.delete(sessionId);
        if (!contents.isDestroyed()) contents.send('rtc:call', { id: 0, sessionId, method: 'close' });
      },
    };
  }

  /** How a session is connected, once it is: directly or through the relay. */
  connectionKind(sessionId: string): string | undefined {
    return this.peers.get(sessionId)?.kind;
  }

  /** Sends a message to the renderer holding this session's peer connection. */
  post(sessionId: string, channel: string, payload: unknown) {
    const peer = this.peers.get(sessionId);
    if (!peer || peer.contents.isDestroyed()) return;
    peer.contents.send(channel, payload);
  }
}
