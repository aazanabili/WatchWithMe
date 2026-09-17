import { describe, expect, it } from 'vitest';
import { conferenceTokenHeaders, limitConferenceTiles } from './conference-panel';

describe('conference UI boundaries', () => {
  it('uses the room capability as a bearer token', () => {
    expect(conferenceTokenHeaders('secret')).toMatchObject({ Authorization: 'Bearer secret' });
  });
  it('caps the visible conference grid at six participants', () => {
    expect(limitConferenceTiles([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
