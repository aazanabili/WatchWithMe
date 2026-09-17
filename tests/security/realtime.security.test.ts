import { describe, expect, it } from 'vitest';
import { CommandEnvelope, CreateRoomRequest } from '@watch-with-me/contracts';
import { validateMedia } from '../../apps/realtime/src/index';
import { validateSubtitle, validateUpload } from '../../apps/realtime/src/services/collaboration';
import {
  ConferenceService,
  FakeConferenceSigner,
} from '../../apps/realtime/src/services/conference';

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

  it.each([
    ['movie.mp4', 'video/mp4'],
    ['movie.webm', 'video/webm'],
    ['movie.ts', 'video/mp2t'],
    ['captions.vtt', 'text/vtt'],
    ['captions.srt', 'application/x-subrip'],
    ['MOVIE.MP4', 'VIDEO/MP4'],
  ])('accepts the exact upload extension/MIME pair %s + %s', (fileName, contentType) => {
    expect(validateUpload({ fileName, contentType, sizeBytes: 1 })).toBe(true);
  });

  it.each([
    ['mp4', 'video/mp4'],
    ['webm', 'video/webm'],
    ['ts', 'video/mp2t'],
    ['vtt', 'text/vtt'],
    ['srt', 'application/x-subrip'],
  ].flatMap(([extension, acceptedMime]) => [
    ...['video/mp4', 'video/webm', 'video/mp2t', 'text/vtt', 'application/x-subrip']
      .filter((mime) => mime !== acceptedMime)
      .map((mime) => [`movie.${extension}`, mime]),
  ]))('rejects mismatched extension/MIME pair %s + %s', (fileName, contentType) => {
    expect(validateUpload({ fileName, contentType, sizeBytes: 1 })).toBe(false);
  });

  it.each([
    ['../escape.mp4', 'video/mp4'],
    ['movie.mp4/other', 'video/mp4'],
    ['movie.mp4\\other', 'video/mp4'],
    ['movie.mp4?download=1', 'video/mp4'],
    ['movie.mp4#fragment', 'video/mp4'],
    ['movie.mp4;evil.exe', 'video/mp4'],
    ['movie.exe', 'video/mp4'],
    ['movie.mp4', 'video/mp4; codecs=avc1'],
    ['captions.srt', 'text/plain'],
  ])('rejects hostile or non-exact upload input %s + %s', (fileName, contentType) => {
    expect(validateUpload({ fileName, contentType, sizeBytes: 1 })).toBe(false);
  });

  it('rejects oversized files', () => {
    expect(
      validateUpload({ fileName: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 2_000_000_001 }),
    ).toBe(false);
  });

  it('rejects subtitle HTML and external references', () => {
    expect(validateSubtitle('WEBVTT\n\n<b>bad</b>', 'vtt')).toBe(false);
    expect(validateSubtitle('WEBVTT\n\nhttps://attacker.invalid/x', 'vtt')).toBe(false);
  });

  it('bounds conference token TTL and refuses more than six publishers', async () => {
    await expect(
      new ConferenceService(new FakeConferenceSigner(), 59).issue('r', 'p', true, {
        enabled: true,
        requireHostApproval: true,
      }),
    ).rejects.toThrow('invalid_token_ttl');
  });

  it('allows a viewer to subscribe only after policy enablement and scopes publishing to grants', async () => {
    const service = new ConferenceService(new FakeConferenceSigner());
    await expect(service.issue('r', 'viewer', false, { enabled: false, requireHostApproval: true }))
      .rejects.toThrow('conference_disabled');
    const viewer = await service.issue('r', 'viewer', false, { enabled: true, requireHostApproval: true });
    expect(viewer.permissions).toEqual({ canPublishAudio: false, canPublishVideo: false, canPublishScreen: false, canSubscribe: true });
    const granted = await service.issue('r', 'viewer', false, { enabled: true, requireHostApproval: true }, {
      canPublishAudio: true, canPublishVideo: true, canPublishScreen: true,
    });
    expect(granted.permissions).toEqual({ canPublishAudio: true, canPublishVideo: true, canPublishScreen: true, canSubscribe: true });
  });
});
