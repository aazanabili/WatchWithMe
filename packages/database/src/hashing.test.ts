import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret } from './hashing';

describe('secret hashing', () => {
  it('is deterministic but does not validate a different secret', () => {
    const digest = hashSecret('one-time-token');
    expect(digest).not.toContain('one-time-token');
    expect(verifySecret('one-time-token', digest)).toBe(true);
    expect(verifySecret('other-token', digest)).toBe(false);
  });
});
