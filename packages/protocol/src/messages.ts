import { array, b64, bool, int, literal, num, obj, oneOf, optional, str, tagged, type Infer } from './schema.js';

/**
 * Wire messages. Version 1.
 *
 * Handshake messages travel in the clear over whatever carries signaling
 * (a LAN TCP socket today, the rendezvous server later); they contain nothing
 * secret — the access code never leaves either machine. Everything after the
 * handshake is sealed with a session key (see `sealed`) so a signaling server
 * or relay sees only ciphertext.
 */

export const PROTOCOL_VERSION = 1;

export const DEVICE_ID = /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const deviceId = str({ max: 12, pattern: DEVICE_ID });
const publicKey = b64({ bytes: 32 });
const nonce = b64({ bytes: 32 });
const share = b64({ bytes: 65 });
const mac = b64({ bytes: 32 });
const signature = b64({ bytes: 64 });
const grantId = b64({ bytes: 16 });

export const AUTH_KINDS = ['code', 'grant', 'unattended'] as const;
export type AuthKind = typeof AUTH_KINDS[number];

export const helloMessage = obj({
  type: literal('hello'),
  v: int(1, 1000),
  hostId: deviceId,
  viewerId: deviceId,
  viewerKey: publicKey,
  /** Shown in the host's consent prompt. Authenticated, but chosen by the viewer. */
  viewerName: str({ max: 64 }),
  nonce,
  time: int(0, Number.MAX_SAFE_INTEGER),
  auth: oneOf(AUTH_KINDS),
  grantId: optional(grantId),
  share,
});

export const challengeMessage = obj({
  type: literal('challenge'),
  hostKey: publicKey,
  hostName: str({ max: 64 }),
  nonce,
  share,
  confirm: mac,
  signature,
});

export const confirmMessage = obj({
  type: literal('confirm'),
  confirm: mac,
  signature,
});

export const HANDSHAKE_ERRORS = [
  'unsupported-version', 'unknown-device', 'rate-limited', 'bad-auth', 'grant-invalid',
  'unattended-disabled', 'code-disabled', 'replay', 'clock-skew', 'busy', 'protocol',
] as const;
export type HandshakeErrorCode = typeof HANDSHAKE_ERRORS[number];

export const errorMessage = obj({
  type: literal('error'),
  code: oneOf(HANDSHAKE_ERRORS),
  retryAfterMs: optional(int(0, 24 * 3600 * 1000)),
});

/** A frame of an encrypted channel; `data` is SealedChannel output. */
export const sealedMessage = obj({
  type: literal('sealed'),
  data: b64({ maxBytes: 4 << 20 }),
});

export const signalingMessage = tagged('type', {
  hello: helloMessage,
  challenge: challengeMessage,
  confirm: confirmMessage,
  error: errorMessage,
  sealed: sealedMessage,
});

export type HelloMessage = Infer<typeof helloMessage>;
export type ChallengeMessage = Infer<typeof challengeMessage>;
export type ConfirmMessage = Infer<typeof confirmMessage>;
export type ErrorMessage = Infer<typeof errorMessage>;
export type SealedMessage = Infer<typeof sealedMessage>;
export type SignalingMessage = Infer<typeof signalingMessage>;

/* ------------------------------------------------ sealed control channel */

export const REJECT_REASONS = ['user-rejected', 'timeout', 'busy', 'not-allowed'] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export const END_REASONS = ['user-disconnected', 'host-stopped', 'revoked', 'idle', 'error'] as const;
export type EndReason = typeof END_REASONS[number];

const sdp = str({ min: 1, max: 64 * 1024 });

export const controlMessage = tagged('type', {
  'auth-result': obj({
    type: literal('auth-result'),
    allowed: bool,
    reason: optional(oneOf(REJECT_REASONS)),
    sessionId: optional(b64({ bytes: 16 })),
    /** Lets this viewer reconnect to this session without asking again. */
    grant: optional(obj({ id: grantId, secret: b64({ bytes: 32 }), expiresAt: int(0, Number.MAX_SAFE_INTEGER) })),
  }),
  'rtc-offer': obj({ type: literal('rtc-offer'), sdp }),
  'rtc-answer': obj({ type: literal('rtc-answer'), sdp }),
  'rtc-ice': obj({
    type: literal('rtc-ice'),
    candidate: str({ max: 1024 }),
    sdpMid: optional(str({ max: 64 })),
    sdpMLineIndex: optional(int(0, 64)),
  }),
  'rtc-ice-done': obj({ type: literal('rtc-ice-done') }),
  ping: obj({ type: literal('ping'), t: int(0, Number.MAX_SAFE_INTEGER) }),
  pong: obj({ type: literal('pong'), t: int(0, Number.MAX_SAFE_INTEGER) }),
  bye: obj({ type: literal('bye'), reason: oneOf(END_REASONS) }),
});
export type ControlMessage = Infer<typeof controlMessage>;

/* ---------------------------------------------- sealed session channels */

export const MAX_CLIPBOARD_CHARS = 1 << 20;

export const inputMessage = tagged('type', {
  /** `code` is a DOM KeyboardEvent.code; `key` the produced character, if any. */
  key: obj({ type: literal('key'), code: str({ max: 32 }), key: optional(str({ max: 8 })), down: bool }),
  /** Coordinates normalised to 0..1 of the shared display, so resolution changes cannot misplace clicks. */
  pointer: obj({ type: literal('pointer'), x: num(0, 1), y: num(0, 1), buttons: int(0, 31) }),
  wheel: obj({ type: literal('wheel'), dx: num(-10000, 10000), dy: num(-10000, 10000) }),
  'release-all': obj({ type: literal('release-all') }),
});
export type InputMessage = Infer<typeof inputMessage>;

export const clipboardMessage = obj({
  type: literal('clipboard'),
  seq: int(0, Number.MAX_SAFE_INTEGER),
  text: str({ max: MAX_CLIPBOARD_CHARS }),
});
export type ClipboardMessage = Infer<typeof clipboardMessage>;

export const displayMessage = tagged('type', {
  'display-info': obj({
    type: literal('display-info'),
    displays: array(obj({ id: str({ max: 64 }), width: int(1, 16384), height: int(1, 16384), scale: num(0.25, 8), primary: bool }), 16),
    active: str({ max: 64 }),
  }),
  'select-display': obj({ type: literal('select-display'), id: str({ max: 64 }) }),
  /** Viewer window size in device pixels; the host may resize its display to match. */
  'viewer-size': obj({ type: literal('viewer-size'), width: int(1, 16384), height: int(1, 16384) }),
});
export type DisplayMessage = Infer<typeof displayMessage>;
