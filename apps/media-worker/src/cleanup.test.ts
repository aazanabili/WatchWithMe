import { describe, expect, it, vi } from 'vitest';
import { cleanupExpired, isExpired } from './cleanup.js';

describe('expired media cleanup', () => {
  it('uses the supplied clock at the three-hour expiry boundary', () => {
    const now = new Date('2026-01-01T03:00:00Z');
    expect(
      isExpired(
        { id: 'a', objectKey: 'a', expiresAt: new Date('2026-01-01T00:00:00Z'), subtitles: [] },
        now,
      ),
    ).toBe(true);
  });
  it('removes objects before deleting database assets', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const deleteAssets = vi.fn().mockResolvedValue(undefined);
    const count = await cleanupExpired(
      () => new Date('2026-01-01T03:00:00Z'),
      {
        findExpired: async () => [
          {
            id: 'a',
            objectKey: 'source/a',
            expiresAt: new Date('2026-01-01T00:00:00Z'),
            subtitles: [{ objectKey: 'sub/a.vtt' }],
          },
        ],
        deleteAssets,
      },
      { remove },
    );
    expect(count).toBe(1);
    expect(remove).toHaveBeenCalledWith(['source/a', 'sub/a.vtt']);
    expect(deleteAssets).toHaveBeenCalledWith(['a']);
  });
});
