'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inventory, fingerprint, assertComplete, changedFiles, makeContext, matchesScope, sourceSnapshot } = require('../src/core/context.cjs');
const { Store } = require('../src/core/store.cjs');
const { validateSettings } = require('../src/core/settings.cjs');

test('context excludes credentials, dependencies and symlinks and tracks changed files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'src'));
  await fs.mkdir(path.join(directory, 'node_modules'));
  await fs.mkdir(path.join(directory, '.claude'));
  await fs.writeFile(path.join(directory, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_AUTH_TOKEN":"must-not-appear"}}');
  await fs.writeFile(path.join(directory, '.env'), 'SECRET=must-not-appear');
  await fs.writeFile(path.join(directory, 'node_modules', 'dependency.js'), 'ignored');
  await fs.writeFile(path.join(directory, 'src', 'index.js'), 'before');
  assert.deepEqual(await inventory(directory), ['src/index.js']);
  const before = await fingerprint(directory);
  const beforeSource = await sourceSnapshot(directory);
  assert.equal(beforeSource['src/index.js'], 'before');
  assert.equal(beforeSource['.env'], undefined);
  await fs.writeFile(path.join(directory, 'src', 'index.js'), 'after');
  await fs.writeFile(path.join(directory, 'README.md'), 'readme');
  assert.deepEqual(changedFiles(before, await fingerprint(directory)), [
    { path: 'src/index.js', status: 'modified' }, { path: 'README.md', status: 'added' },
  ]);
  const context = await makeContext(directory, ['src/**']);
  assert.equal(context.includes('must-not-appear'), false);
  assert.equal(context.includes('after'), true);
});

test('glob scopes match nested modules without matching sibling paths', () => {
  assert.equal(matchesScope('src/a/index.ts', 'src/**/*.ts'), true);
  assert.equal(matchesScope('src/index.ts', 'src/**/*.ts'), true);
  assert.equal(matchesScope('src-other/index.ts', 'src/**'), false);
  assert.equal(matchesScope('src/index.ts', 'src'), true);
});

test('truncated inventory never reports an unseen existing file as deleted or added', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coverage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'b.txt'), 'unchanged');
  const before = await fingerprint(directory, { limit: 1 });
  assertComplete(before);
  await fs.writeFile(path.join(directory, 'a.txt'), 'new file shifts window');
  const after = await fingerprint(directory, { limit: 1 });
  assert.throws(() => assertComplete(after), /扫描不完整/);
  assert.deepEqual(changedFiles(before, after), [{ path: 'a.txt', status: 'added' }]);
  assert.deepEqual(changedFiles(after, before), [{ path: 'a.txt', status: 'deleted' }]);
  assert.equal(changedFiles(before, after).some((item) => item.path === 'b.txt'), false);
});

test('backup noise is excluded and large source files remain covered by hashes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coverage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['.BACKUPS', '.vs', '_internal']) {
    await fs.mkdir(path.join(directory, name));
    await fs.writeFile(path.join(directory, name, 'noise.txt'), 'ignored');
  }
  await fs.writeFile(path.join(directory, 'large.txt'), 'a'.repeat(2100000));
  const before = await fingerprint(directory, { limit: 1 });
  assertComplete(before);
  assert.deepEqual(Object.keys(before.files), ['large.txt']);
  await fs.appendFile(path.join(directory, 'large.txt'), 'changed');
  assert.deepEqual(changedFiles(before, await fingerprint(directory)), [{ path: 'large.txt', status: 'modified' }]);
  const capped = await fingerprint(directory, { maxBytes: 100 });
  assert.equal(capped.coverage.complete, false);
});

test('scoped context prefers task files to unrelated nested READMEs and respects budget', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'src'));
  await fs.mkdir(path.join(directory, 'unrelated'));
  await fs.writeFile(path.join(directory, 'src', 'target.js'), 'TARGET_EVIDENCE');
  await fs.writeFile(path.join(directory, 'unrelated', 'README.md'), 'UNRELATED_CONTENT');
  await fs.writeFile(path.join(directory, 'README.md'), 'ROOT_CONTEXT'.repeat(1000));
  const context = await makeContext(directory, ['src/target.js'], 700);
  assert.match(context, /TARGET_EVIDENCE/);
  assert.doesNotMatch(context, /UNRELATED_CONTENT/);
  assert.ok(context.length <= 700);
});

test('store survives restart and marks unfinished runs interrupted', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = new Store(directory, { gptModel: '' });
  first.saveSettings({ qwenModel: 'qwen3:8b' });
  const run = first.createRun(directory, 'Build a tiny application OPENAI_API_KEY=dummy-private-key');
  assert.equal(run.request.includes('dummy-private-key'), false);
  assert.equal((await fs.readFile(path.join(directory, 'runs', `${run.id}.json`), 'utf8')).includes('dummy-private-key'), false);
  first.addEvent(run, { provider: 'gpt', message: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz' });
  const second = new Store(directory);
  assert.equal(second.getRun(run.id).status, 'interrupted');
  assert.equal(second.settings.qwenModel, 'qwen3:8b');
  assert.equal(second.getRun(run.id).events[0].message.includes('sk-'), false);
});

test('settings reject credentials, invalid URLs and invalid round counts', () => {
  assert.throws(() => validateSettings({ ollamaUrl: 'file:///etc/passwd' }));
  assert.throws(() => validateSettings({ ollamaUrl: 'http://user:pass@localhost' }));
  assert.throws(() => validateSettings({ maxReviewRounds: 0 }));
  assert.deepEqual(validateSettings({ apiKey: 'should-not-persist', gptModel: '' }), { gptModel: '' });
});
