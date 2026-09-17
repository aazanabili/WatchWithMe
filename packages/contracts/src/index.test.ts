import { describe, expect, it } from 'vitest';
import { Command, Snapshot } from './index';

describe('v1 contracts', () => {
  it('accepts the supported playback commands', () => {
    expect(Command.parse({ type: 'seek', positionSeconds: 12 })).toEqual({
      type: 'seek',
      positionSeconds: 12,
    });
    const load = Command.parse({
      type: 'load',
      provider: 'youtube',
      videoId: 'abc',
      durationSeconds: null,
    });
    expect(load).toMatchObject({ type: 'load', provider: 'youtube' });
  });

  it('accepts every registered provider with explicit sync mode', () => {
    for (const provider of [
      'youtube',
      'mp4',
      'upload',
      'instagram',
      'tiktok',
      'vimeo',
      'dailymotion',
      'twitch',
      'facebook',
    ]) {
      const value = Command.parse({
        type: 'load',
        provider,
        videoId: provider === 'youtube' ? 'abc' : `https://${provider}.com/video/abc`,
        durationSeconds: null,
        syncMode:
          provider === 'youtube' || provider === 'mp4' || provider === 'upload'
            ? 'full'
            : 'view_only',
      });
      expect(value).toMatchObject({ type: 'load', provider });
    }
  });

  it('requires snapshot protocol metadata', () => {
    expect(() => Snapshot.parse({ roomId: 'room', participants: [], sequence: 0 })).toThrow();
  });
});
