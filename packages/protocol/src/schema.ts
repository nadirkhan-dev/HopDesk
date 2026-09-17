/**
 * A deliberately small runtime validator for network messages.
 *
 * Everything arriving from a peer, a signaling server or a relay is hostile
 * until proven otherwise, so every message is checked field by field against
 * a schema with explicit size limits before any code touches it. Unknown
 * fields are dropped rather than passed through.
 */

export class SchemaError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`Invalid message at ${path || '<root>'}: ${detail}`);
  }
}

export type Check<T> = (value: unknown, path: string) => T;
export type Infer<C> = C extends Check<infer T> ? T : never;

export const str = (opts: { min?: number; max: number; pattern?: RegExp }): Check<string> => (v, p) => {
  if (typeof v !== 'string') throw new SchemaError(p, 'expected a string');
  if (v.length < (opts.min ?? 0) || v.length > opts.max) throw new SchemaError(p, `length must be ${opts.min ?? 0}-${opts.max}`);
  if (opts.pattern && !opts.pattern.test(v)) throw new SchemaError(p, 'has an invalid format');
  return v;
};

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 that must decode to exactly `bytes` bytes (or a range). */
export const b64 = (opts: { bytes?: number; maxBytes?: number }): Check<string> => (v, p) => {
  if (typeof v !== 'string' || v.length % 4 || !B64.test(v)) throw new SchemaError(p, 'expected base64');
  const len = (v.length / 4) * 3 - (v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0);
  if (opts.bytes !== undefined && len !== opts.bytes) throw new SchemaError(p, `expected ${opts.bytes} bytes`);
  if (opts.maxBytes !== undefined && len > opts.maxBytes) throw new SchemaError(p, `more than ${opts.maxBytes} bytes`);
  return v;
};

export const int = (min: number, max: number): Check<number> => (v, p) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new SchemaError(p, `expected an integer in ${min}..${max}`);
  return v;
};

export const num = (min: number, max: number): Check<number> => (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new SchemaError(p, `expected a number in ${min}..${max}`);
  return v;
};

export const bool: Check<boolean> = (v, p) => {
  if (typeof v !== 'boolean') throw new SchemaError(p, 'expected a boolean');
  return v;
};

export const literal = <const T extends string | number>(value: T): Check<T> => (v, p) => {
  if (v !== value) throw new SchemaError(p, `expected ${JSON.stringify(value)}`);
  return value;
};

export const oneOf = <const T extends string>(values: readonly T[]): Check<T> => (v, p) => {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new SchemaError(p, `expected one of ${values.join(', ')}`);
  return v as T;
};

export const optional = <T>(check: Check<T>): Check<T | undefined> & { optional: true } =>
  Object.assign((v: unknown, p: string) => (v === undefined ? undefined : check(v, p)), { optional: true as const });

export const array = <T>(check: Check<T>, max: number): Check<T[]> => (v, p) => {
  if (!Array.isArray(v)) throw new SchemaError(p, 'expected an array');
  if (v.length > max) throw new SchemaError(p, `more than ${max} items`);
  return v.map((item, i) => check(item, `${p}[${i}]`));
};

type Shape = Record<string, Check<unknown>>;
type ObjectOf<S extends Shape> =
  { [K in keyof S as S[K] extends { optional: true } ? never : K]: Infer<S[K]> } &
  { [K in keyof S as S[K] extends { optional: true } ? K : never]?: Infer<S[K]> };

export const obj = <S extends Shape>(shape: S): Check<ObjectOf<S>> => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SchemaError(p, 'expected an object');
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(shape)) {
    const value = check((v as Record<string, unknown>)[key], p ? `${p}.${key}` : key);
    if (value !== undefined) out[key] = value;
  }
  return out as ObjectOf<S>;
};

/** A union discriminated by a string field (default `type`). */
export const tagged = <M extends Record<string, Check<unknown>>>(field: string, variants: M): Check<Infer<M[keyof M]>> => (v, p) => {
  if (typeof v !== 'object' || v === null) throw new SchemaError(p, 'expected an object');
  const tag = (v as Record<string, unknown>)[field];
  if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(variants, tag)) {
    throw new SchemaError(p ? `${p}.${field}` : field, 'unknown message type');
  }
  return variants[tag]!(v, p) as Infer<M[keyof M]>;
};

/** Parses JSON text with a size cap, then validates it. */
export function parseJson<T>(check: Check<T>, text: string, maxLength = 1 << 20): T {
  if (text.length > maxLength) throw new SchemaError('', `message larger than ${maxLength} characters`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new SchemaError('', 'not valid JSON'); }
  return check(value, '');
}
