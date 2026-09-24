import { generateIdentity, deviceIdFromPublicKey, sign, toBase64, utf8 } from '@hopdesk/crypto';

/**
 * Enrols a freshly generated device against a signed-in account, the way the
 * app does: ask for a challenge, sign it with the device key, send the key.
 *
 * The first computer on an account vouches for itself; every one after it
 * waits to be approved from one already approved. By default this helper does
 * that approving too, with the first approved device it enrolled for the same
 * account - which is what a person pressing Approve does, and it keeps the
 * tests that are about the relay from having to care. Pass
 * `{ approve: false }` to leave a computer waiting, which is what the
 * approval tests are about.
 */
const approvers = new Map();
export async function enrolDevice(server, session, name = 'Test computer', opts = {}) {
  const identity = generateIdentity();
  const deviceId = deviceIdFromPublicKey(identity.publicKey);
  const { body: challenge } = await server.call('POST', '/api/devices/challenge', { token: session.accessToken });
  const signature = enrolSignature(identity, challenge.nonce, session.account.id);
  const enrolled = await server.call('POST', '/api/devices', {
    token: session.accessToken,
    body: { deviceId, publicKey: toBase64(identity.publicKey), name, nonce: challenge.nonce, signature },
  });
  const device = { identity, deviceId, name, response: enrolled, deviceToken: enrolled.body?.deviceToken };
  device.approved = enrolled.body?.device?.approved === true;

  const key = `${session.account?.id}`;
  if (device.approved) {
    if (!approvers.has(key)) approvers.set(key, device.deviceToken);
  } else if (opts.approve !== false) {
    const approver = opts.approveWith ?? approvers.get(key);
    if (approver) {
      const answer = await approveDevice(server, approver, deviceId);
      device.approved = answer.status === 200;
    }
  }
  return device;
}

/** One computer vouching for another, as pressing Approve does. */
export function approveDevice(server, approverDeviceToken, deviceId) {
  return server.call('POST', `/api/devices/${encodeURIComponent(deviceId)}/approve`,
    { token: approverDeviceToken });
}

export function enrolSignature(identity, nonce, accountId) {
  return toBase64(sign(identity, 'hopdesk/enrol/v1', utf8(`${nonce}\0${accountId}`)));
}

/** Signs in (creating the account first) and returns the session tokens. */
export async function signIn(server, email = 'owner@example.com', password = 'a-long-enough-password') {
  await server.call('POST', '/api/register', { body: { email, password } });
  const { body } = await server.call('POST', '/api/login', { body: { email, password } });
  return body;
}
