import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertMedia, srtToVtt } from './process.js';
import { parseJob } from './job.js';
describe('media worker', () => {
  it('parses queue jobs', () =>
    expect(parseJob('{"assetId":"a","objectKey":"x.mp4","contentType":"video/mp4"}').assetId).toBe(
      'a',
    ));
  it('rejects malformed jobs', () => expect(() => parseJob('{}')).toThrow());
  it('converts SRT timestamps', () =>
    expect(srtToVtt('1\n00:00:01,500 --> 00:00:02,000\nHi')).toContain('00:00:01.500'));
  it('validates direct media without ffmpeg', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'worker-test-'));
    const input = path.join(dir, 'a');
    const output = path.join(dir, 'b');
    await writeFile(input, 'sample');
    const runner = { run: vi.fn().mockResolvedValue('2.5') };
    await convertMedia(input, output, '.mp4', runner);
    expect(runner.run).toHaveBeenCalledWith('ffprobe', expect.any(Array), 30000);
  });
});
