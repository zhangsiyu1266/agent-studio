'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveCommand, runProcess } = require('./core/process.cjs');

// Real packaged IPC and native runtime checks. Never starts OAuth or model inference.
async function testSetup(window, output) {
  const evaluate = (script) => window.webContents.executeJavaScript(script, true);
  const connections = await evaluate('window.studio.probe()');
  assert.equal(connections.codex.available, true);
  assert.equal(connections.codex.authenticated, false);
  assert.equal(connections.deepseek.available, false);
  const npm = resolveCommand('npm');
  assert.ok(npm.command.includes(path.join('resources', 'app', 'tools', 'node')));
  assert.ok(npm.argsPrefix[0].includes(path.join('resources', 'app', 'tools', 'node')));
  const nodeResult = await runProcess('node', ['-p', 'process.execPath'], { timeoutMs: 10000 });
  assert.equal(nodeResult.code, 0);
  assert.ok(nodeResult.stdout.includes(path.join('resources', 'app', 'tools', 'node')));
  assert.ok(connections.codex.command.includes('resources'));
  const state = await evaluate('window.studio.getState()');
  assert.equal(state.readiness.ready, false);
  assert.equal(state.runs.length, 0);
  assert.equal(await evaluate('!!document.querySelector("#workbench-setup [data-setup-action=login]") && !document.querySelector("#workbench-setup [data-setup-action=login]").disabled'), true);
  assert.match(await evaluate('document.querySelector("#workbench-setup").textContent'), /浏览器中登录 ChatGPT/);
  await fs.writeFile(path.join(output, 'onboarding.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  const rejected = await evaluate('window.studio.setupHelp("https://evil.example").then(() => false, () => true)');
  assert.equal(rejected, true);
  await evaluate('document.querySelector("[data-view=connections]").click()');
  assert.ok(await evaluate('!!document.querySelector("#connections-setup [data-setup-action=login]")'));
  await fs.writeFile(path.join(output, 'setup-smoke.json'), JSON.stringify({ kind: 'packaged-runtime-and-ui-only', authenticated: false, codex: connections.codex.version, nodeBundled: true, npmBundled: true, loginButton: true, invalidHelpRejected: true, noModelCalls: true }, null, 2));
}

module.exports = { testSetup };
