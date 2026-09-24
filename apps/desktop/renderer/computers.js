/**
 * One list of computers, out of the two HopDesk keeps.
 *
 * A computer can be known twice over: because this one connected to it before
 * (devices.json, with the key pinned the first time) and because both are
 * signed in to the same account (the server's device list, which knows whether
 * it is online). Showing those as two lists made a person hold the join in
 * their head - the same Mac, in two places, with a different button under
 * each. They are the same computer, so they are one row.
 *
 * The join is the public key, not the name and not the Device ID. A name is
 * whatever someone typed; a Device ID is a 40-bit hash and short enough that
 * two computers could in principle share one. The key is the identity - it is
 * what the handshake proves - so it is what says "these are the same machine".
 *
 * Pure: no Electron, no DOM, so every rule below is tested rather than
 * demonstrated by hand.
 */

/** Ways in to a computer, strongest first. */
export const METHODS = ['trusted', 'ask', 'code'];

/**
 * What each way in means to the person choosing it. Written from their side -
 * what will happen - rather than from the protocol's.
 */
export const METHOD_LABELS = {
  trusted: 'Connect',
  ask: 'Ask to share screen',
  code: 'Use access code',
};

export const METHOD_HINTS = {
  trusted: 'It has agreed to let this computer in without asking.',
  ask: 'Someone at that computer has to allow it.',
  code: 'You type the six digits shown on that computer.',
};

/**
 * Merges the account's devices with the computers connected to before.
 *
 * @param account devices from the server: deviceId, name, os, publicKey, online, lastSeen, self
 * @param known   devices.json: deviceId, key, name, lastConnected, paired, lastAddress, lastPort
 */
export function mergeComputers({ account = [], known = [], signedIn = false } = {}) {
  const rows = new Map();                       // join key → row
  const keyOf = entry => entry.publicKey || entry.key || `id:${entry.deviceId}`;

  for (const device of account) {
    if (device.self) continue;                  // the computer you are sitting at
    rows.set(keyOf(device), {
      deviceId: device.deviceId,
      name: device.name || device.deviceId,
      os: device.os ?? null,
      online: device.online === true,
      lastSeen: device.lastSeen ?? null,
      onAccount: true,
      /* A computer on the account that nobody has vouched for yet. It is
         listed - it has to be, or nobody could decide about it - but it is
         not somewhere to connect to. */
      waiting: device.approved === false,
      publicKey: device.publicKey,
      paired: false,
      address: undefined,
      port: undefined,
    });
  }

  for (const device of known) {
    const join = keyOf(device);
    const existing = rows.get(join);
    if (existing) {
      /* The account knows whether it is online; the local record knows whether
         it will let this computer in without asking, and where it answered. */
      existing.paired = device.paired === true;
      existing.address = device.lastAddress;
      existing.port = device.lastPort;
      existing.lastSeen = existing.lastSeen ?? device.lastConnected ?? null;
      if (!existing.name || existing.name === existing.deviceId) existing.name = device.name || existing.name;
      continue;
    }
    rows.set(join, {
      deviceId: device.deviceId,
      name: device.name || device.deviceId,
      os: null,
      /* Not on the account, so nothing says whether it is reachable. Unknown
         is not offline: it may be sitting on this network right now, and
         saying "offline" would stop someone even trying. */
      online: signedIn ? false : null,
      lastSeen: device.lastConnected ?? null,
      onAccount: false,
      paired: device.paired === true,
      address: device.lastAddress,
      port: device.lastPort,
    });
  }

  return [...rows.values()]
    .map(row => ({ ...row, methods: methodsFor(row), status: statusFor(row) }))
    .sort(compare);
}

/** Every way this computer can be reached, best first. */
export function methodsFor(row) {
  // Nothing to offer until somebody vouches for it.
  if (row.waiting) return [];
  const methods = [];
  if (row.paired) methods.push('trusted');
  if (row.onAccount) methods.push('ask');
  methods.push('code');
  return methods;
}

/** The way in that will be used unless the person picks another. */
export function defaultMethod(row, remembered) {
  const methods = row.methods ?? methodsFor(row);
  return methods.includes(remembered) ? remembered : methods[0];
}

/**
 * Whether connecting can be attempted, and what to say when it cannot.
 *
 * Only a computer the account says is offline is refused: that is the one case
 * where something authoritative is known. A computer that is merely not on the
 * account is left alone to try, because this network may well be able to reach
 * it.
 */
export function connectability(row, method) {
  if (row.waiting) {
    return { ok: false, why: `${row.name} is waiting to be approved from a computer already on your account.` };
  }
  if (row.onAccount && !row.online && method !== 'code') {
    return { ok: false, why: `${row.name} is not online, so the server cannot reach it.` };
  }
  return { ok: true };
}

function statusFor(row) {
  if (row.online === true) return 'online';
  if (row.online === false) return 'offline';
  return 'unknown';
}

/** Online first, then whoever was seen most recently. */
function compare(a, b) {
  const rank = row => (row.status === 'online' ? 0 : row.status === 'unknown' ? 1 : 2);
  const byStatus = rank(a) - rank(b);
  if (byStatus !== 0) return byStatus;
  return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
}
