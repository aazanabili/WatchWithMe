import { describe, expect, it } from 'vitest';
import { shouldCommitRangeChange } from './playback-panel';
describe('playback range interaction policy', () => {
  it('previews pointer changes and commits only on release', () => { expect(shouldCommitRangeChange(true, true)).toBe(false); expect(shouldCommitRangeChange(false, true)).toBe(true); });
  it('commits keyboard/programmatic host changes and never viewer changes', () => { expect(shouldCommitRangeChange(false, true)).toBe(true); expect(shouldCommitRangeChange(false, false)).toBe(false); expect(shouldCommitRangeChange(true, false)).toBe(false); });
});
