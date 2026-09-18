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
  capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  for (const track of capture.getVideoTracks()) {
    try { await track.applyConstraints({ frameRate: { ideal: 30, max: 60 } }); } catch { /* the default rate is fine */ }
  }
  bridge.hostLog(`screen acquired: ${capture.getVideoTracks().map(t => t.label).join(', ')}`);
  return capture;
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
  if (session) session.send(label, message);
});

bridge.hostReady();
