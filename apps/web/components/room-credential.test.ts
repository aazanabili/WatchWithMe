import { describe, expect, it } from 'vitest';
import { saveRoomCredential } from './room-credential';

describe('saveRoomCredential', () => {
  it('stores only the token from the current create response and returns the room route', () => {
    const values = new Map<string, string>();
    const response = {
      version: 'v1',
      roomId: 'moon/7k2',
      roomCode: 'moon/7k2',
      token: 'host-token',
      participantId: 'participant-1',
      role: 'host',
      serverTime: '2026-09-16T00:00:00.000Z',
    };

    const route = saveRoomCredential(response, {
      setItem: (key, value) => values.set(key, value),
    });

    expect(values.get('watch-with-me:moon/7k2')).toBe(JSON.stringify({ token: 'host-token' }));
    expect(route).toBe('/room/moon%2F7k2');
  });
});
