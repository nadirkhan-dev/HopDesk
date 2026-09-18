/**
 * The RTCPeerConnection half of a HopDesk session.
 *
 * WebRTC only exists in a renderer, but every decision about the session is
 * made in the main process, which holds the keys. So this file is a driven
 * thing: main asks it to make an offer, answer one, or add a candidate, and it
 * reports candidates and connection state back. It never sees a key, an access
 * code or the handshake.
 *
 * Media and data channels are encrypted by DTLS/SRTP. The certificate
 * fingerprints that authenticate that encryption travel inside the sealed
 * control channel, so they come from the authenticated peer — and once
 * connected, the certificate the peer actually presented is checked against
 * them here as well.
 */

export function createPeerSession({ role, sessionId, bridge, iceServers = [], getStream, onTrack, onChannelMessage, log = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

  /**
   * Relay and STUN servers arrive with the first call from the main process,
   * which is the only place that knows whether this session needs them. They
   * can be set after construction as long as no candidate has been gathered.
   */
  function configureIce(servers, policy) {
    const wanted = Array.isArray(servers) ? servers : [];
    if (!wanted.length && policy !== 'relay') return;
    try {
      pc.setConfiguration({
        iceServers: wanted,
        bundlePolicy: 'max-bundle',
        ...(policy ? { iceTransportPolicy: policy } : {}),
      });
      log(`using ${wanted.length} ICE server group(s)${policy === 'relay' ? ', relay only' : ''}`);
    } catch (err) {
      log(`could not apply ICE servers: ${err?.message ?? err}`);
    }
  }

  /**
   * How the session ended up connected: directly, or through the relay. Worth
   * showing, because it tells the user whether their traffic is going through
   * the server and why a session might be slower.
   */
  async function connectionKind() {
    try {
      const stats = await pc.getStats();
      let pair = null;
      const candidates = new Map();
      for (const report of stats.values()) {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') candidates.set(report.id, report);
        if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded' && report.nominated)) pair = report;
      }
      if (!pair) return 'unknown';
      const local = candidates.get(pair.localCandidateId);
      const remote = candidates.get(pair.remoteCandidateId);
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
      if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'local';
      return 'direct';
    } catch {
      return 'unknown';
    }
  }
  const channels = new Map();
  let closed = false;

  const event = (type, extra = {}) => bridge.rtcEvent({ sessionId, type, ...extra });

  pc.onicecandidate = e => {
    if (e.candidate) {
      event('candidate', {
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid ?? undefined,
          sdpMLineIndex: e.candidate.sdpMLineIndex ?? undefined,
        },
      });
    } else {
      event('candidates-done');
    }
  };

  pc.onconnectionstatechange = async () => {
    log(`connection state: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      const problem = await certificateMismatch(pc);
      if (problem) {
        // The DTLS peer is not the one the authenticated description named.
        event('failed', { error: problem });
        close();
        return;
      }
      event('connected', { kind: await connectionKind() });
    } else if (pc.connectionState === 'failed') {
      event('failed', { error: 'the direct connection failed' });
    }
  };

  pc.ontrack = e => { if (onTrack) onTrack(e.streams[0] ?? new MediaStream([e.track]), e.track); };

  pc.ondatachannel = e => wireChannel(e.channel);

  function wireChannel(channel) {
    channels.set(channel.label, channel);
    channel.onmessage = ev => {
      if (!onChannelMessage) return;
      try {
        onChannelMessage(channel.label, JSON.parse(ev.data));
      } catch {
        // A channel sending anything but JSON is not one of ours.
      }
    };
    channel.onclose = () => channels.delete(channel.label);
  }

  /** Sends one JSON message on a channel, if it is open. */
  function send(label, message) {
    const channel = channels.get(label);
    if (channel && channel.readyState === 'open') channel.send(JSON.stringify(message));
  }

  async function createOffer(arg) {
    configureIce(arg?.iceServers, arg?.iceTransportPolicy);
    // The viewer receives video and opens the channels it will send on.
    pc.addTransceiver('video', { direction: 'recvonly' });
    for (const label of ['input', 'clipboard', 'display']) {
      wireChannel(pc.createDataChannel(label, { ordered: true }));
    }
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription.sdp;
  }

  async function answer(arg) {
    const offerSdp = typeof arg === 'string' ? arg : arg?.sdp;
    configureIce(typeof arg === 'object' ? arg?.iceServers : undefined, typeof arg === 'object' ? arg?.iceTransportPolicy : undefined);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const stream = getStream ? await getStream() : null;
    for (const track of stream ? stream.getVideoTracks() : []) {
      const transceiver = pc.getTransceivers().find(t => (t.receiver.track?.kind ?? t.mid) === 'video' || t.mid === '0');
      if (transceiver) {
        await transceiver.sender.replaceTrack(track);
        transceiver.direction = 'sendonly';
      } else {
        pc.addTrack(track, stream);
      }
    }
    await pc.setLocalDescription(await pc.createAnswer());
    return pc.localDescription.sdp;
  }

  async function applyAnswer(answerSdp) {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  async function addRemoteCandidate(candidate) {
    // null means the peer has finished gathering.
    if (!candidate) { await pc.addIceCandidate(null).catch(() => {}); return; }
    await pc.addIceCandidate(candidate);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const channel of channels.values()) { try { channel.close(); } catch { /* already gone */ } }
    channels.clear();
    for (const sender of pc.getSenders()) { try { sender.track?.stop(); } catch { /* already stopped */ } }
    try { pc.close(); } catch { /* already closed */ }
  }

  return {
    role, sessionId, pc, createOffer, answer, applyAnswer, addRemoteCandidate, send, close, connectionKind,
    get closed() { return closed; },
  };
}

/**
 * Compares the certificate the DTLS peer presented with the fingerprints in the
 * session description that arrived through the authenticated channel. Returns a
 * reason when they disagree, or null when they match (or when the browser does
 * not expose the certificate, in which case Chromium has already enforced it).
 */
async function certificateMismatch(pc) {
  const sdp = pc.remoteDescription?.sdp ?? '';
  const expected = [...sdp.matchAll(/^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/gm)].map(m => m[1].toUpperCase());
  if (!expected.length) return 'the remote session description had no DTLS fingerprint';

  const transport = pc.sctp?.transport ?? pc.getSenders()[0]?.transport ?? pc.getReceivers()[0]?.transport;
  const certificates = transport?.getRemoteCertificates?.() ?? [];
  if (!certificates.length) return null;                 // nothing to compare against

  for (const der of certificates) {
    const digest = await crypto.subtle.digest('SHA-256', der);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    if (expected.includes(hex)) return null;
  }
  return 'the certificate presented by the other computer does not match the authenticated session';
}

/**
 * Serves the calls main makes on a peer session: one peer per session id.
 * `create(sessionId)` builds the session the first time main asks for it.
 */
export function servePeerCalls({ bridge, create }) {
  const sessions = new Map();
  bridge.onRtcCall(async ({ id, sessionId, method, arg }) => {
    try {
      if (method === 'close') {
        sessions.get(sessionId)?.close();
        sessions.delete(sessionId);
        if (id) bridge.rtcReply({ id, ok: true, value: null });
        return;
      }
      let session = sessions.get(sessionId);
      if (!session) {
        session = await create(sessionId);
        sessions.set(sessionId, session);
      }
      const value = await session[method](arg);
      bridge.rtcReply({ id, ok: true, value: value ?? null });
    } catch (err) {
      bridge.rtcReply({ id, ok: false, error: err?.message ?? String(err) });
    }
  });
  return sessions;
}
