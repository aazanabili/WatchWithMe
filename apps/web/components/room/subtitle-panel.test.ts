import { describe, expect, it, vi } from 'vitest';
import { parseVttTimestamp, parseWebVtt, safeVttSource } from './subtitle-panel';
describe('subtitle source safety', () => {
  it('parses both supported timestamp forms', () => { expect(parseVttTimestamp('01:02.500')).toBe(62.5); expect(parseVttTimestamp('01:02:03.004')).toBe(3723.004); });
  it('parses plain text cues and enforces cue limits', () => { expect(parseWebVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHello')).toEqual([{ startTime: 1, endTime: 2, text: 'Hello' }]); expect(() => parseWebVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nHello', 0)).toThrow('subtitle_limit'); });
  it('accepts VTT and creates a local blob URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    await expect(safeVttSource('https://signed.test/captions', async () => new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nHello'))).resolves.toBe('blob:test');
    expect(create).toHaveBeenCalled(); create.mockRestore();
  });
  it('rejects HTML instead of rendering it as cues', async () => {
    await expect(safeVttSource('signed', async () => new Response('WEBVTT\n<script>alert(1)</script>'))).rejects.toThrow('subtitle_invalid');
  });
});
