'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, finished } = require('../src/renderer/progress.js');

test('completed workspace includes only accepted deliveries and searches by title and project', () => {
  const runs = [
    { id: 'ok', title: '微信助手', projectPath: 'C:/projects/assistant', status: 'completed', updatedAt: '2026-10-12' },
    { id: 'fail', title: 'failed', status: 'failed', updatedAt: '2026-10-13' },
    { id: 'review', title: 'review', status: 'reviewing', updatedAt: '2026-10-13' },
    { id: 'new', title: 'X筛选器', projectPath: 'C:/projects/filter', status: 'completed', completedAt: '2026-10-13', updatedAt: '2026-10-13' },
  ];
  assert.deepEqual(finished(runs).map((run) => run.id), ['new', 'ok']);
  assert.deepEqual(finished(runs, 'ASSISTANT').map((run) => run.id), ['ok']);
  assert.equal(finished(runs, '微信').length, 1);
  assert.equal(finished(runs, 'missing').length, 0);
});

test('approval alone never marks delivery completed and partial checks stay incomplete', () => {
  const run = { status: 'checking', round: 1, review: { approved: true }, tasks: [{ status: 'completed' }],
    plan: { checks: [{}, {}] }, checks: [{ code: 0 }] };
  const result = describe(run);
  assert.equal(result.completed, false);
  assert.equal(result.stages[2].state, 'current');
  assert.equal(result.stages[3].state, 'pending');
  assert.equal(result.stages[4].state, 'pending');
  assert.equal(result.passedChecks, 1);
  assert.equal(result.expectedChecks, 2);
});

test('manual acceptance, repaired tasks and old records show truthful states', () => {
  const completed = describe({ status: 'completed', tasks: [{ status: 'superseded' }], plan: { checks: [] } });
  assert.equal(completed.doneTasks, 1);
  assert.ok(completed.stages.every((stage) => stage.state === 'done'));
  assert.match(completed.stages[2].note, /未配置自动检查/);
  const interrupted = describe({ status: 'interrupted', plan: { checks: [] }, tasks: [{ status: 'running' }] });
  assert.equal(interrupted.stages[1].state, 'attention');
  assert.equal(interrupted.doneTasks, 0);
  assert.ok(!interrupted.stages.some((stage) => stage.state === 'current'));
  assert.equal(describe({ status: 'planning' }).stages[0].state, 'current');
});

test('blocked planning is highlighted before execution rather than shown as ready', () => {
  for (const extra of [{ planningBlocked: true }, { plan: { status: 'blocked', checks: [] } }]) {
    const result = describe({ status: 'needs_attention', plan: { checks: [] }, tasks: [], ...extra });
    assert.equal(result.stages[0].state, 'attention');
    assert.match(result.stages[0].note, /前置条件/);
    assert.equal(result.stages[1].state, 'pending');
  }
});
