'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Setup, helpUrl, readiness } = require('../src/core/setup.cjs');

test('setup distinguishes missing, API-key, GPT-only and optional multi-model readiness', () => {
  assert.equal(readiness().ready, false);
  assert.equal(readiness({ codex: { available: true, authenticated: true, authMode: 'api_key' } }).ready, false);
  const codex = { available: true, authenticated: true, authMode: 'chatgpt' };
  assert.equal(readiness({ codex }).mode, 'gpt-only');
  assert.equal(readiness({ codex, deepseek: { available: true, configured: true } }).mode, 'multi-model');
});

test('setup help accepts only fixed known topics, not arbitrary URLs or object properties', () => {
  assert.equal(new URL(helpUrl('codex')).hostname, 'learn.chatgpt.com');
  for (const value of ['https://evil.example', '../auth.json', '__proto__', 'constructor', {}, null]) assert.throws(() => helpUrl(value));
});

test('ChatGPT browser login verifies authentication without returning OAuth output or credentials', async () => {
  const events = [];
  const calls = [];
  const setup = new Setup(() => ({}), (event) => events.push(event), {
    resolveCodex: () => 'codex.exe', environment: async () => ({}),
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return args[1] === 'status' ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }
        : { code: 0, stdout: 'OAUTH_PRIVATE_RESPONSE', stderr: '' };
    },
  });
  assert.equal(setup.startLogin().status, 'running');
  assert.throws(() => setup.startLogin(), /登录正在进行/);
  await setup.pending;
  assert.equal(setup.operation.status, 'completed');
  assert.deepEqual(calls[0].args, ['login', '-c', 'forced_login_method="chatgpt"']);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(events).includes('OAUTH_PRIVATE_RESPONSE'), false);
  assert.equal(setup.controller, null);
});

test('login errors and API-key authentication cannot be reported as verified ChatGPT login', async () => {
  for (const mode of ['throw', 'api-key', 'exit']) {
    const setup = new Setup(() => ({}), () => {}, {
      resolveCodex: () => 'codex.exe', environment: async () => ({}),
      runProcess: async (_command, args) => {
        if (mode === 'throw') throw new Error('OAUTH_PRIVATE_RESPONSE');
        return { code: mode === 'exit' ? 1 : 0, stdout: args[1] === 'status' ? 'Logged in using API key' : '', stderr: '' };
      },
    });
    setup.startLogin();
    await setup.pending;
    assert.equal(setup.operation.status, 'failed');
    assert.equal(JSON.stringify(setup.operation).includes('OAUTH_PRIVATE_RESPONSE'), false);
  }
});

test('login cancellation reaches the running child and does not claim success', async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const setup = new Setup(() => ({}), () => {}, {
    resolveCodex: () => 'codex.exe', environment: async () => ({}),
    runProcess: async (_command, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      entered();
    }),
  });
  setup.startLogin();
  await started;
  setup.cancelLogin();
  await setup.pending;
  assert.equal(setup.operation.status, 'cancelled');
  assert.equal(setup.controller, null);
});

test('missing Codex fails visibly before login starts', () => {
  const setup = new Setup(() => ({}), () => {}, { resolveCodex: () => null });
  assert.throws(() => setup.startLogin(), /未找到 Codex/);
  assert.equal(setup.pending, null);
});
