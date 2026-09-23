/**
 * The Host's capture and media window: hidden, with no interface.
 *
 * It captures the screen through getDisplayMedia (the main process answers the
 * request with the display the user is sharing), sends it over WebRTC, and
 * passes the viewer's input and clipboard messages to the main process, which
 * validates them before anything reaches the platform.
 */
import { createPeerSession, servePeerCalls } from './peer.js';

const bridge = window.hopdesk;
let capture = null;

async function screenStream() {
  if (capture && capture.getVideoTracks().some(t => t.readyState === 'live')) return capture;
  bridge.hostLog('requesting the screen');
  /* Plain `video: true`: the main process chooses the screen, and Chromium
     rejects constraint objects on this path ("Invalid capture constraints").
     The frame rate is applied to the track afterwards instead. */
  try {
    capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    // Chromium's own words ("Invalid capture constraints") say nothing useful.
    bridge.hostLog(`screen capture refused: ${err?.message ?? err}`);
    throw new Error('this computer has no screen HopDesk can share');
  }
  for (const track of capture.getVideoTracks()) {
    try { await track.applyConstraints({ frameRate: { ideal: 30, max: 60 } }); } catch { /* the default rate is fine */ }
  }
  bridge.hostLog(`screen acquired: ${capture.getVideoTracks().map(t => t.label).join(', ')}`);
  void measure(capture);
  return capture;
}

/**
 * The size of what was captured, told to the main process.
 *
 * A track's settings are not filled in until frames arrive, so this waits for
 * one rather than reporting zeroes. It is only used to notice that the picture
 * is of a different monitor than the one being shared.
 */
async function measure(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    const { width, height } = track.getSettings();
    if (width && height) { bridge.hostCaptured({ width, height }); return; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/**
 * The person sharing chose a different screen. The picture has to change for
 * whoever is already watching, and reconnecting them to do it would be rude:
 * the new track goes into the sender that is already sending, which WebRTC
 * carries without renegotiating.
 */
async function switchScreen() {
  const old = capture;
  capture = null;
  let fresh;
  try {
    fresh = await screenStream();
  } catch (err) {
    bridge.hostLog(`could not change screen: ${err?.message ?? err}`);
    capture = old;                       // keep sending what is already working
    return;
  }
  const track = fresh.getVideoTracks()[0] ?? null;
  for (const session of sessions.values()) {
    for (const sender of session.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try { await sender.replaceTrack(track); } catch (err) {
        bridge.hostLog(`could not change screen for a session: ${err?.message ?? err}`);
      }
    }
  }
  // Only once nobody is sending it any more: stopping it first freezes the picture.
  for (const t of old ? old.getTracks() : []) { try { t.stop(); } catch { /* already stopped */ } }
  bridge.hostLog('screen changed');
}

const sessions = servePeerCalls({
  bridge,
  create: sessionId => createPeerSession({
    role: 'host',
    sessionId,
    bridge,
    getStream: screenStream,
    onChannelMessage: (label, message) => {
      // Validated in the main process against the protocol schema.
      if (label === 'input') bridge.hostInput(sessionId, message);
      else if (label === 'clipboard') bridge.hostClipboard(sessionId, message);
      else if (label === 'display') bridge.hostDisplay(sessionId, message);
    },
    log: text => bridge.hostLog(`session ${sessionId}: ${text}`),
  }),
});

/** This computer's clipboard changed: pass it to every viewer. */
bridge.onHostSend(({ sessionId, label, message }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  // Notices go out as soon as a session connects, which can be before its channel is open.
  const dropped = session.send(label, message, { queue: label === 'display' });
  if (dropped) bridge.hostLog(`session ${sessionId}: ${label} message not sent: ${dropped}`);
});

bridge.onHostRecapture(() => { void switchScreen(); });

bridge.hostReady();
