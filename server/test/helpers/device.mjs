import { generateIdentity, deviceIdFromPublicKey, sign, toBase64, utf8 } from '@hopdesk/crypto';

/**
 * Enrols a freshly generated device against a signed-in account, the way the
 * app does: ask for a challenge, sign it with the device key, send the key.
 */
export async function enrolDevice(server, session, name = 'Test computer') {
  const identity = generateIdentity();
  const deviceId = deviceIdFromPublicKey(identity.publicKey);
  const { body: challenge } = await server.call('POST', '/api/devices/challenge', { token: session.accessToken });
  const signature = enrolSignature(identity, challenge.nonce, session.account.id);
  const enrolled = await server.call('POST', '/api/devices', {
    token: session.accessToken,
    body: { deviceId, publicKey: toBase64(identity.publicKey), name, nonce: challenge.nonce, signature },
  });
  return { identity, deviceId, name, response: enrolled, deviceToken: enrolled.body?.deviceToken };
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
