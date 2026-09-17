import { randomInt } from 'node:crypto';

/**
 * The short-lived access code shown under "This computer".
 *
 * Six digits is about 20 bits. That is only acceptable because SPAKE2 gives an
 * attacker exactly one online guess per handshake and the host limits and
 * rotates on failures (see the protocol package); the code is never sent over
 * the network and cannot be tested offline.
 */

export const ACCESS_CODE_DIGITS = 6;

export function generateAccessCode(): string {
  let code = '';
  // randomInt is uniform (rejection sampling), unlike Math.random or modulo tricks.
  for (let i = 0; i < ACCESS_CODE_DIGITS; i++) code += String(randomInt(10));
  return code;
}

/** "739421" → "739 421", for display only. */
export function formatAccessCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Strips spaces and dashes; returns null unless exactly six digits remain. */
export function normalizeAccessCode(input: string): string | null {
  const s = String(input).replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${ACCESS_CODE_DIGITS}}$`).test(s) ? s : null;
}
