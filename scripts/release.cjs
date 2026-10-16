'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { runProcess } = require('../src/core/process.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const name = `Agent-Studio-${version}-win-x64`;
  const archive = path.join(root, 'dist', `${name}.zip`);
  await fs.access(path.join(root, 'dist', name, 'Agent Studio.exe'));
  const handle = await fs.open(archive, 'wx');
  await handle.close();
  const result = await runProcess('tar.exe', ['-a', '-c', '-f', archive, '-C', path.join(root, 'dist'), name], { timeoutMs: 600000 });
  if (result.code !== 0) throw new Error('Release archive failed. Partial archive retained.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const checksum = `${hash.digest('hex')}  ${path.basename(archive)}\n`;
  await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS.txt'), checksum);
  console.log(JSON.stringify({ archive, bytes: (await fs.stat(archive)).size, checksum: checksum.trim() }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
