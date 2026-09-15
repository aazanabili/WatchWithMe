import { describe, expect, it } from 'vitest';
import { Command, Snapshot } from './index';

describe('v1 contracts', () => {
  it('accepts the supported playback commands', () => {
    expect(Command.parse({ type: 'seek', positionSeconds: 12 })).toEqual({
      type: 'seek',
      positionSeconds: 12,
    });
    const load = Command.parse({ type: 'load', provider: 'youtube', videoId: 'abc' });
    expect(load).toMatchObject({ type: 'load', provider: 'youtube' });
  });

  it('rejects unsupported providers', () => {
    expect(() => Command.parse({ type: 'load', provider: 'vimeo', videoId: 'abc' })).toThrow();
  });

  it('requires snapshot protocol metadata', () => {
    expect(() => Snapshot.parse({ roomId: 'room', participants: [], sequence: 0 })).toThrow();
  });
});
