import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

export interface ChildProcessRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<string>;
}
export const childProcessRunner: ChildProcessRunner = {
  run(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(err || `${command} exited ${code}`));
      });
    });
  },
};
export async function ffprobeDuration(file: string, runner = childProcessRunner): Promise<number> {
  const output = await runner.run(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ],
    30_000,
  );
  const duration = Number.parseFloat(output.trim());
  if (!Number.isFinite(duration) || duration < 0) throw new Error('invalid media duration');
  return duration;
}
export async function convertMedia(
  input: string,
  output: string,
  ext: string,
  runner = childProcessRunner,
): Promise<void> {
  if (ext === '.mp4' || ext === '.webm') {
    await ffprobeDuration(input, runner);
    await fs.copyFile(input, output);
    return;
  }
  await runner.run(
    'ffmpeg',
    ['-nostdin', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output],
    10 * 60_000,
  );
}
export function srtToVtt(input: string): string {
  if (!validateSubtitle(input, 'srt')) throw new Error('invalid_subtitle');
  return `WEBVTT\n\n${input
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<[^>]*>/g, '')
    .trim()}\n`;
}
export async function writeStream(
  stream: NodeJS.ReadableStream,
  file: string,
  maxBytes: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(file);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(
          new Error('media exceeds size limit'),
        );
        out.destroy();
        reject(new Error('media exceeds size limit'));
      }
    });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve(size));
    stream.pipe(out);
  });
}
export function tempPath(dir: string, key: string): string {
  return path.join(dir, `${Date.now()}-${path.basename(key)}`);
}

export function validateSubtitle(content: string, format: 'srt' | 'vtt'): boolean {
  if (content.length > 20_000_000 || /<[^>]*>/i.test(content)) return false;
  if (/\b(?:https?|javascript|data):/i.test(content)) return false;
  if (format === 'vtt') return /^WEBVTT(?:\r?\n|$)/.test(content);
  return /(?:^|\r?\n)\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+/.test(content);
}
