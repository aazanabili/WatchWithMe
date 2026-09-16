const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const bash = fs.readFileSync(path.join(root, 'scripts/watch-with-me.sh'), 'utf8');
const ps = fs.readFileSync(path.join(root, 'scripts/watch-with-me.ps1'), 'utf8');
for (const command of [
  'start',
  'stop',
  'restart',
  'status',
  'health',
  'logs',
  'remove',
  'clean',
  'test',
  'doctor',
  'help',
]) {
  assert.match(bash, new RegExp(`(?:case|${command})`));
  assert.match(ps, new RegExp(`'${command}'|${command}`));
}
assert.match(bash, /set -Eeuo pipefail/);
assert.doesNotMatch(bash, /eval|Invoke-Expression/);
assert.doesNotMatch(ps, /Invoke-Expression/);
assert.match(bash, /test:e2e:docker/);
assert.match(ps, /test:e2e:docker/);
console.log('watch-with-me contract: passed');
