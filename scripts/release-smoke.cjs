'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runProcess } = require('../src/core/process.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  let output = path.join(root, 'dist', `Agent-Studio-${version}-win-x64`);
  const testRoot = await fs.mkdtemp(path.join(root, '.build', 'release-clean-'));
  if (process.argv.includes('--archive')) {
    const archive = path.join(root, 'dist', `Agent-Studio-${version}-win-x64.zip`);
    const listed = await runProcess('tar.exe', ['-tf', archive], { timeoutMs: 30000 });
    assert.equal(listed.code, 0);
    const names = listed.stdout.split(/\r?\n/).filter(Boolean);
    const folder = `Agent-Studio-${version}-win-x64`;
    assert.ok(names.length > 100);
    assert.ok(names.every((name) => name.replaceAll('\\', '/').startsWith(folder + '/') && !name.replaceAll('\\', '/').split('/').includes('..')));
    const extracted = await runProcess('tar.exe', ['-xf', archive, '-C', testRoot], { timeoutMs: 120000 });
    assert.equal(extracted.code, 0);
    output = path.join(testRoot, folder);
  }
  const profile = path.join(testRoot, 'profile');
  const codexHome = path.join(testRoot, 'codex');
  await fs.mkdir(profile);
  for (const directory of ['Documents', 'Roaming', 'Local']) await fs.mkdir(path.join(profile, directory));
  await fs.mkdir(codexHome);
  const dataDirectory = path.join(testRoot, 'data');
  await fs.mkdir(dataDirectory);
  await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ claudeCommand: path.join(profile, 'missing-claude.exe'), claudeSettingsPath: path.join(profile, 'no-user-settings.json'), ollamaUrl: 'http://127.0.0.1:1' }));
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  const env = {
    PATH: [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'), process.env.SystemRoot].join(path.delimiter),
    CODEX_HOME: codexHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined,
    npm_execpath: undefined, npm_node_execpath: undefined, NODE_PATH: undefined, NODE_OPTIONS: undefined, ELECTRON_RUN_AS_NODE: undefined,
    AGENT_STUDIO_DATA_DIR: dataDirectory, AGENT_STUDIO_CAPTURE_DIR: testRoot,
  };
  const result = await runProcess(path.join(output, 'Agent Studio.exe'), ['--ui-smoke', '--setup-smoke', '--projects-smoke'], { env, timeoutMs: 120000 });
  assert.equal(result.code, 0, 'Packaged clean-profile startup failed; inspect isolated ui-error.json.');
  const ui = JSON.parse(await fs.readFile(path.join(testRoot, 'ui-smoke.json'), 'utf8'));
  const setup = JSON.parse(await fs.readFile(path.join(testRoot, 'setup-smoke.json'), 'utf8'));
  assert.deepEqual(ui.problems, []);
  assert.equal(ui.npm.code, 0);
  assert.equal(ui.scrollWidth <= ui.width, true);
  assert.ok(ui.small.width <= 960 && ui.small.width >= 800);
  assert.equal(ui.small.scrollWidth <= ui.small.width, true);
  for (const value of Object.values(ui.views)) assert.ok(value.scrollWidth <= value.width);
  console.log(JSON.stringify({ passed: true, testRoot, fromArchive: process.argv.includes('--archive'), setup, npm: ui.npm, hostToolsHidden: true, oauthAndInferenceNotStarted: true }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
