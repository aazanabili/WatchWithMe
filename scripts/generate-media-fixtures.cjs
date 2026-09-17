const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-with-me-media-'));
const container = execFileSync('docker', ['compose', 'ps', '-q', 'media-worker'], { encoding: 'utf8' }).trim();
if (!container) throw new Error('media-worker container is not running');
const run = (args) => execFileSync('docker', ['compose', 'exec', '-T', 'media-worker', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const copy = (name) => execFileSync('docker', ['cp', `${container}:/tmp/${name}`, path.join(dir, name)], { stdio: 'inherit' });

run(['ffmpeg', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', '/tmp/wwm-tiny.mp4']);
run(['ffmpeg', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12', '-t', '2', '-c:v', 'mpeg2video', '-f', 'mpegts', '/tmp/wwm-tiny.ts']);
copy('wwm-tiny.mp4');
copy('wwm-tiny.ts');
let webm = false;
try {
  run(['ffmpeg', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12', '-t', '2', '-c:v', 'libvpx', '-an', '/tmp/wwm-tiny.webm']);
  copy('wwm-tiny.webm');
  webm = true;
} catch (error) {
  fs.writeFileSync(path.join(dir, 'webm-unavailable.txt'), `WebM fixture unavailable: ${error.message}\nCommand: ffmpeg -c:v libvpx\n`);
}
process.stdout.write(JSON.stringify({ dir, mp4: path.join(dir, 'wwm-tiny.mp4'), ts: path.join(dir, 'wwm-tiny.ts'), webm }));
