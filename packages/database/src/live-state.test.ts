import { describe, expect, it } from 'vitest';
import { InMemoryLiveStateStore } from './live-state';

describe('in-memory live state', () => {
  it('stores snapshots and presence without external services', async () => {
    const store = new InMemoryLiveStateStore();
    await store.setSnapshot(
      'room',
      {
        provider: 'YOUTUBE',
        mediaId: 'abc',
        positionMs: 4,
        isPlaying: true,
        version: 1,
        capturedAt: 'now',
      },
      10,
    );
    await store.touchPresence('room', 'participant');
    expect(await store.getSnapshot('room')).toMatchObject({ mediaId: 'abc', version: 1 });
    expect(await store.getPresence('room')).toHaveLength(1);
    await store.removePresence('room', 'participant');
    expect(await store.getPresence('room')).toEqual([]);
  });

  it('expires snapshots and individual presence entries', async () => {
    const store = new InMemoryLiveStateStore();
    await store.setSnapshot(
      'room',
      {
        provider: 'YOUTUBE',
        mediaId: 'abc',
        positionMs: 0,
        isPlaying: false,
        version: 1,
        capturedAt: 'now',
      },
      1,
    );
    await store.touchPresence('room', 'participant', 1);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(await store.getSnapshot('room')).toBeNull();
    expect(await store.getPresence('room')).toEqual([]);
  });
});
