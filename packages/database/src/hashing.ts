import { createHash, timingSafeEqual } from 'node:crypto';

/** Store only this digest; callers must never persist or log the raw token. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifySecret(value: string, digest: string): boolean {
  const actual = Buffer.from(hashSecret(value), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
