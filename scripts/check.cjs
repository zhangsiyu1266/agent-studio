'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : /\.(?:cjs|js)$/.test(entry.name) ? [target] : [];
  });
}

let failed = false;
for (const file of [...files('src'), ...files('scripts'), ...files('tests')]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(result.stderr); }
}
const html = fs.readFileSync('src/renderer/index.html', 'utf8');
if (!/Content-Security-Policy/.test(html)) { failed = true; console.error('Renderer CSP missing'); }
if (failed) process.exitCode = 1;
else console.log('JavaScript syntax and renderer CSP checks passed.');
