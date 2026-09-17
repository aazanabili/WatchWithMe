import { describe, expect, it } from 'vitest';
import { TrackSource } from 'livekit-server-sdk';
import { liveKitSourcesFor } from './adapters';

describe('LiveKit participant permissions', () => {
  it('maps source-specific publish grants and never grants subscribe away', () => {
    expect(liveKitSourcesFor({ canPublishAudio: false, canPublishVideo: false, canPublishScreen: false })).toEqual([]);
    expect(liveKitSourcesFor({ canPublishAudio: true, canPublishVideo: true, canPublishScreen: true })).toEqual([
      TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO,
    ]);
  });
});
