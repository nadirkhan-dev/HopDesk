/**
 * What the authorization service says about one installation, and exactly
 * which bytes it signs.
 *
 * Shared by the service and the client because a signature is only meaningful
 * if both sides agree, to the byte, on what was signed. An earlier version of
 * this signed `JSON.stringify(statement)`, which works only while both sides
 * happen to build the object with its keys in the same order and neither adds
 * a field - a signature scheme resting on property order, which is no scheme
 * at all. The encoding below is explicit: named fields, fixed order, a
 * separator that cannot appear in any of them.
 */

export const VERDICT_LABEL = 'hopdesk/installation/verdict/v1';

export interface InstallationVerdict {
  installationId: string;
  status: 'active' | 'blocked';
  reason: string | null;
  /** When the service answered. */
  checkedAt: number;
  /** How long the answer stands without another. */
  validUntil: number;
}

/** The bytes that are signed, and the bytes that are checked. */
export function verdictBytes(verdict: InstallationVerdict): Uint8Array {
  const fields = [
    verdict.installationId,
    verdict.status,
    verdict.reason ?? '',
    String(verdict.checkedAt),
    String(verdict.validUntil),
  ];
  return new TextEncoder().encode(fields.join('\u0000'));
}

/** The statement out of a reply that may carry other things beside it. */
export function verdictFrom(reply: Record<string, unknown>): InstallationVerdict | null {
  const status = reply.status;
  if (status !== 'active' && status !== 'blocked') return null;
  if (typeof reply.installationId !== 'string') return null;
  if (typeof reply.checkedAt !== 'number' || typeof reply.validUntil !== 'number') return null;
  return {
    installationId: reply.installationId,
    status,
    reason: typeof reply.reason === 'string' ? reply.reason : null,
    checkedAt: reply.checkedAt,
    validUntil: reply.validUntil,
  };
}
