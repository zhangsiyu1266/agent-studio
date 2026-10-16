'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function packageApplication() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This release target requires Windows x64.');
  const root = path.resolve(__dirname, '..');
  const source = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const output = path.join(root, 'dist', `Agent-Studio-${source.version}-win-x64`);
  // A fresh folder prevents stale code, credentials or earlier build files entering a release.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  try {
    const required = ['tools/github/bin/gh.exe', 'tools/github/LICENSE', 'tools/node/node.exe', 'tools/node/LICENSE',
      'tools/node/node_modules/npm/bin/npm-cli.js', 'tools/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      'tools/codex/LICENSE', 'tools/codex/NOTICE', 'tools/runtime-manifest.json'];
    for (const filename of required) await fs.access(path.join(root, filename));
    await fs.cp(path.join(root, 'node_modules/electron/dist'), output, { recursive: true });
    const application = path.join(output, 'resources/app');
    await fs.mkdir(application, { recursive: true });
    for (const directory of ['src', 'docs']) await fs.cp(path.join(root, directory), path.join(application, directory), { recursive: true });
    for (const directory of ['github', 'node', 'codex']) await fs.cp(path.join(root, 'tools', directory), path.join(application, 'tools', directory), { recursive: true });
    await fs.copyFile(path.join(root, 'tools/runtime-manifest.json'), path.join(application, 'tools/runtime-manifest.json'));
    await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: source.name, version: source.version, main: source.main, description: source.description, license: source.license }, null, 2));
    await fs.rename(path.join(output, 'electron.exe'), path.join(output, 'Agent Studio.exe'));
    for (const filename of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
      await fs.copyFile(path.join(root, filename), path.join(output, filename === 'LICENSE' ? 'LICENSE.agent-studio.txt' : filename));
    }
    await fs.copyFile(path.join(root, 'docs/GETTING-STARTED.md'), path.join(output, 'START-HERE.md'));
    await fs.writeFile(path.join(output, 'Start Agent Studio.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0Agent Studio.exe"\r\n');
    console.log(`Desktop application built: ${output}`);
    return output;
  } catch (error) {
    throw new Error(`Build failed; partial folder retained at ${output}. Prepare runtime tools first. ${error.message}`);
  }
}

if (require.main === module) packageApplication().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { packageApplication };
