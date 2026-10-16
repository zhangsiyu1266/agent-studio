'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'dist', 'Agent-Studio');
  const runtime = path.join(root, 'node_modules', 'electron', 'dist');
  const githubTool = path.join(root, 'tools', 'github');
  await fs.access(path.join(githubTool, 'bin', 'gh.exe')).catch(() => { throw new Error('Run powershell -File scripts/prepare-github.ps1 before packaging to include GitHub login.'); });
  if (!output.startsWith(root + path.sep) || path.relative(root, output) !== path.join('dist', 'Agent-Studio')) throw new Error('Invalid packaging path');
  await fs.mkdir(output, { recursive: true });
  await fs.cp(runtime, output, { recursive: true, force: true });
  const application = path.join(output, 'resources', 'app');
  await fs.mkdir(application, { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(application, 'src'), { recursive: true, force: true });
  await fs.cp(githubTool, path.join(application, 'tools', 'github'), { recursive: true, force: true });
  const source = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: source.name, version: source.version, main: source.main, description: source.description }, null, 2));
  const executable = path.join(output, 'Agent Studio.exe');
  await fs.copyFile(path.join(output, 'electron.exe'), executable);
  await fs.copyFile(path.join(root, 'README.md'), path.join(output, '使用说明.md'));
  console.log(`Desktop application built: ${executable}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
