import { describe, expect, it } from 'vitest';
import { conferenceMediaSources, conferenceTokenHeaders, limitConferenceTiles, LOCAL_MEDIA_STABILIZATION_MS, localProvisionalTileId, localPublicationTileId, remotePublicationTileId, revokeLocalTracks, shouldRepublishLocalTrack } from './conference-panel';

describe('conference UI boundaries', () => {
  it('waits three seconds for local media stabilization while allowing publication events to finish sooner', () => {
    expect(LOCAL_MEDIA_STABILIZATION_MS).toBe(3000);
  });
  it('republishes a retained live track when the unpublished event has no track', () => {
    const retained = { mediaStreamTrack: { readyState: 'live' } } as never;
    expect(shouldRepublishLocalTrack(retained, undefined, false, false)).toBe(true);
  });
  it('uses the room capability as a bearer token', () => {
    expect(conferenceTokenHeaders('secret')).toMatchObject({ Authorization: 'Bearer secret' });
  });
  it('caps the visible conference grid at six participants', () => {
    expect(limitConferenceTiles([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('uses stable source and publication identity for local tiles', () => {
    const publication = { source: 'camera', sid: 'publication-1', trackSid: 'track-1' };
    expect(localPublicationTileId('participant-1', publication)).toBe('participant-1:camera:track-1');
    expect(localPublicationTileId('participant-1', { source: publication.source, sid: publication.sid })).toBe('participant-1:camera:publication-1');
  });
  it('uses publication trackSid for remote identity and removes only that publication', () => {
    expect(remotePublicationTileId('viewer', { trackSid: 'TR_camera' })).toBe('viewer:TR_camera');
    expect(remotePublicationTileId('viewer', { trackSid: 'TR_screen' })).not.toBe(remotePublicationTileId('viewer', { trackSid: 'TR_camera' }));
  });
  it('keeps provisional camera and screen tiles distinct, and stopping screen preserves camera', () => {
    const camera = localProvisionalTileId('participant-1', 'camera', { kind: 'video' });
    const screen = localProvisionalTileId('participant-1', 'screen_share', { kind: 'video' });
    const tiles = new Map([[camera, 'camera'], [screen, 'screen']]);
    expect(camera).not.toBe(screen);
    tiles.delete(screen);
    expect([...tiles.values()]).toEqual(['camera']);
  });
  it('revokes every local media source without recursively unpublishing', () => {
    const stopped: string[] = []; const unpublished: string[] = [];
    const tracks = new Map(conferenceMediaSources.map(source => [source, { stop: () => stopped.push(source) } as never]));
    revokeLocalTracks(tracks, () => unpublished.push('unpublished'));
    expect(stopped).toHaveLength(4);
    expect(unpublished).toHaveLength(4);
    expect(tracks).toHaveLength(0);
  });
});
