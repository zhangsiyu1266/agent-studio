'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, validateTasks, validateWorker, validateReview, validScope, isAccepted, redact } = require('../src/core/contracts.cjs');
const path = require('node:path');

function task(id, dependencies = []) {
  return { id, title: id, provider: 'deepseek', instructions: 'Implement behavior', allowedPaths: ['src/**'], dependencies, acceptance: ['Behavior works'] };
}

test('dependency graph orders tasks and rejects cycles and missing dependencies', () => {
  assert.deepEqual(validateTasks([task('b', ['a']), task('a')]).map((item) => item.id), ['a', 'b']);
  assert.throws(() => validateTasks([task('a', ['b']), task('b', ['a'])]), /依赖/);
  assert.throws(() => validateTasks([task('a', ['missing'])]), /依赖/);
  assert.throws(() => validateTasks([task('a'), task('a')]), /唯一/);
});

test('file scopes reject traversal and control directories on Windows and POSIX', () => {
  for (const value of ['../outside', 'src/../../file', 'C:\\outside', '/tmp/file', '.git/config', 'src/.claude/settings.json', '\\\\server\\share']) {
    assert.equal(validScope(value), false, value);
  }
  assert.equal(validScope('src/**/*.ts'), true);
  assert.equal(validScope('README.md'), true);
});

test('acceptance cannot bypass failed checks or unresolved findings', () => {
  const approved = { approved: true, findings: [], repairTasks: [] };
  assert.equal(isAccepted(approved, [{ code: 0 }]), true);
  assert.equal(isAccepted(approved, [{ code: 1 }]), false);
  assert.equal(isAccepted({ ...approved, findings: [{ severity: 'major' }] }, []), false);
  assert.equal(isAccepted({ ...approved, repairTasks: [task('repair')] }, []), false);
  assert.equal(isAccepted({ ...approved, approved: false }, []), false);
});

test('planning and review require actual acceptance evidence', () => {
  assert.throws(() => validatePlan({ title: 'x', summary: '', acceptance: [], tasks: [task('a')], checks: [] }));
  assert.throws(() => validatePlan({ title: 'x', summary: '', acceptance: ['works'], tasks: [task('a')], checks: [{ command: 'node', args: 'bad' }] }));
  assert.throws(() => validateReview({ approved: 'yes', summary: '', findings: [], repairTasks: [] }));
});

test('secrets are removed from logs', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123';
  const result = redact(`ANTHROPIC_AUTH_TOKEN=${secret} Authorization: Bearer ${secret}`);
  assert.equal(result.includes(secret), false);
  const json = redact(JSON.stringify({ api_key: 'dummy-secret-123', ANTHROPIC_AUTH_TOKEN: 'dummy-token-456' }));
  assert.equal(json.includes('dummy-secret-123'), false);
  assert.equal(json.includes('dummy-token-456'), false);
});

test('reference paths may be external but must be bounded absolute paths; write scopes remain relative', () => {
  const plan = { title: 'Docs', summary: 'Read external source', status: 'ready', projectPath: path.resolve('output'),
    blockedReason: '', evidence: [], acceptance: ['Correct docs'], checks: [], tasks: [task('docs')] };
  const reference = path.resolve('external-source');
  assert.deepEqual(validatePlan({ ...plan, referencePaths: [reference] }).referencePaths, [reference]);
  for (const referencePaths of [['relative/source'], [reference + '\0'], [4], 'invalid', Array(41).fill(reference)]) {
    assert.throws(() => validatePlan({ ...plan, referencePaths }), /参考路径/);
  }
  assert.equal(validScope(reference), false);
  assert.deepEqual(validatePlan(plan).referencePaths, []);
});

test('worker cannot claim completion with blockers or omit a blocking reason', () => {
  const outcome = { status: 'completed', projectPath: path.resolve('project'), summary: 'Done', changedFiles: [], checks: [], blockers: [] };
  assert.equal(validateWorker(outcome).status, 'completed');
  assert.throws(() => validateWorker({ ...outcome, blockers: ['Missing source'] }), /不能视为已完成/);
  assert.throws(() => validateWorker({ ...outcome, status: 'blocked' }), /不能视为已完成/);
  assert.equal(validateWorker({ ...outcome, status: 'blocked', blockers: ['Missing source'] }).status, 'blocked');
  assert.throws(() => validateWorker({ ...outcome, projectPath: 'relative-project' }), /不能视为已完成/);
});
