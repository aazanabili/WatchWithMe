import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTurnIceServer } from './turn-credentials';

describe('TURN REST credentials', () => {
  it('uses expiry:participant username and HMAC-SHA1 secret', () => {
    const nowMs = 1_700_000_000_000;
    const result = createTurnIceServer({ participantId: 'p-1', expiresAt: new Date(nowMs + 3600_000).toISOString(), secret: 'strong-test-secret', url: 'turn:localhost:3478?transport=tcp', nowMs, maxTtlSeconds: 300 });
    expect(result.username).toBe('1700000300:p-1');
    expect(result.credential).toBe(createHmac('sha1', 'strong-test-secret').update(result.username).digest('base64'));
  });
  it('never outlives the LiveKit token', () => {
    const nowMs = 1_700_000_000_000;
    const result = createTurnIceServer({ participantId: 'p-1', expiresAt: new Date(nowMs + 30_000).toISOString(), secret: 'secret', url: 'turn:localhost:3478?transport=tcp', nowMs });
    expect(Number(result.username.split(':', 1)[0])).toBe(1_700_000_030);
  });
  it('rejects expired token lifetime', () => {
    expect(() => createTurnIceServer({ participantId: 'p-1', expiresAt: new Date(1_699_999_000_000).toISOString(), secret: 'secret', url: 'turn:localhost:3478?transport=tcp', nowMs: 1_700_000_000_000 })).toThrow('turn_credential_expired');
  });
});
