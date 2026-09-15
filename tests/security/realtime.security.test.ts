import { describe, expect, it } from 'vitest';
import { CommandEnvelope, CreateRoomRequest } from '@watch-with-me/contracts';
import { validateMedia } from '../../apps/realtime/src/index';

describe('realtime hostile input boundaries', () => {
  it.each([
    'http://localhost/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://2130706433/video.mp4',
    'https://[::1]/video.mp4',
    'https://service.internal/video.mp4',
    'https://user:pass@example.com/video.mp4',
  ])('rejects SSRF-prone media URL %s without fetching', (url) => {
    expect(validateMedia('mp4', url)).toBe(false);
  });

  it('rejects unknown fields and oversized command identifiers', () => {
    expect(
      CommandEnvelope.safeParse({
        version: 'v1',
        commandId: 'x',
        command: { type: 'play' },
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelope.safeParse({
        version: 'v1',
        commandId: 'x'.repeat(129),
        command: { type: 'play' },
      }).success,
    ).toBe(false);
  });

  it('rejects oversized or role-spoofing room input', () => {
    expect(CreateRoomRequest.safeParse({ displayName: 'x'.repeat(81) }).success).toBe(false);
    expect(CreateRoomRequest.safeParse({ displayName: 'host', role: 'host' }).success).toBe(false);
  });
});
