import { createHash, timingSafeEqual } from 'node:crypto';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const verifyTokenHash = (token: string, expected: string) => {
  const actual = Buffer.from(hashToken(token));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
};
