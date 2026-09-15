import { describe, expect, it } from 'vitest';
import { expectedPosition } from './player-adapter';

describe('expectedPosition', () => {
  it('advances a playing snapshot by server elapsed time', () => {
    expect(
      expectedPosition(
        10,
        '2026-01-01T00:00:00.000Z',
        'playing',
        Date.parse('2026-01-01T00:00:05.000Z'),
      ),
    ).toBe(15);
  });
  it('does not advance a paused snapshot', () => {
    expect(
      expectedPosition(
        10,
        '2026-01-01T00:00:00.000Z',
        'paused',
        Date.parse('2026-01-01T00:01:00.000Z'),
      ),
    ).toBe(10);
  });
});
