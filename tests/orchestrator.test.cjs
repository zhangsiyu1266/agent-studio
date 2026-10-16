'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Orchestrator } = require('../src/core/orchestrator.cjs');

const plan = {
  title: 'Test application', summary: 'Build one module', acceptance: ['Exact behavior passes'],
  tasks: [{ id: 'implement', title: 'Implement', provider: 'deepseek', instructions: 'Implement', allowedPaths: ['result.txt'], dependencies: [], acceptance: ['Result exists'] }],
  checks: [{ command: 'node', args: ['--version'] }],
};
const approved = { approved: true, summary: 'Reviewed original code and behavior', findings: [], repairTasks: [] };
const completedWorker = (project) => ({ status: 'completed', projectPath: project, summary: 'Implemented result.txt', changedFiles: ['result.txt'], checks: ['Inspected result.txt'], blockers: [] });

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pipeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const store = new Store(path.join(root, 'data'), { maxReviewRounds: 2, qwenModel: 'qwen3:8b' });
  const calls = [];
  const connections = { codex: { available: true, authenticated: true, authMode: options.authMode || 'chatgpt' }, deepseek: { available: true, configured: true }, ollama: { available: false, models: [] } };
  const codex = { run: async (input) => {
    if (options.onPrompt) options.onPrompt(input.prompt);
    calls.push(input.writable ? 'review' : 'plan');
    return { structured: input.writable ? structuredClone(options.review || approved) : { ...plan, status: 'ready', projectPath: project, blockedReason: '', evidence: [], ...options.plan }, text: 'GPT evidence', usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 5 } };
  } };
  const deepseek = { run: async ({ signal, prompt }) => {
    if (options.onPrompt) options.onPrompt(prompt);
    calls.push('worker');
    if (options.worker) return options.worker({ project, signal });
    await fs.writeFile(path.join(project, 'result.txt'), 'implemented');
    return { text: 'Implemented result.txt', structured: completedWorker(project), usage: { inputTokens: 7, outputTokens: 2 } };
  } };
  const engine = new Orchestrator(store, () => {}, {
    discover: async () => connections,
    createProviders: () => ({ codex, deepseek, qwen: deepseek }),
    runProcess: async (command) => command === 'git' ? { code: 1, stdout: '', stderr: '' }
      : { code: options.checkCode || 0, stdout: 'check result', stderr: '' },
  });
  return { engine, store, project, calls };
}

test('GPT plans before workers and reviews before delivery; all usage accounted', async (t) => {
  const { engine, project, calls, store } = await fixture(t);
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.deepEqual(calls, ['plan', 'worker', 'review']);
  assert.equal(store.getRun(run.id).status, 'completed');
  assert.equal(run.usage.gpt.inputTokens, 20);
  assert.equal(run.usage.gpt.cachedTokens, 10);
  assert.equal(engine.activeRunId, null);
  assert.ok(run.completedAt);
  assert.equal(run.phaseHistory[0].status, 'planning');
  assert.equal(run.phaseHistory.at(-1).status, 'completed');
  assert.equal(run.reviewHistory[0].round, 1);
  assert.equal(run.reviewHistory[0].review.approved, true);
  assert.equal(run.tasks[0].status, 'completed');
  assert.ok(run.tasks[0].startedAt <= run.tasks[0].finishedAt);
  assert.equal(run.modelCalls.length, 3);
  assert.ok(run.modelCalls.every((call) => call.status === 'completed' && call.durationMs >= 0 && call.finishedAt));
  const restored = new Store(store.directory).getRun(run.id);
  assert.equal(restored.completedAt, run.completedAt);
  assert.deepEqual(restored.phaseHistory, run.phaseHistory);
});

test('attachment contents reach planning, worker and final review and survive retry', async (t) => {
  const prompts = [];
  const { engine, project, store } = await fixture(t, { onPrompt: (prompt) => prompts.push(prompt) });
  const source = path.join(project, 'reference.md');
  await fs.writeFile(source, 'ATTACHMENT_REQUIREMENT_测试');
  const [attachment] = await engine.attachments.importFiles([source]);
  await fs.unlink(source);
  const run = await engine.start({ projectPath: project, request: 'Implement from attachment', attachmentIds: [attachment.id] });
  await engine.pending;
  assert.equal(run.status, 'completed');
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) assert.match(prompt, /ATTACHMENT_REQUIREMENT_测试/);
  const stored = new Store(store.directory).getRun(run.id);
  assert.equal(stored.attachments[0].id, attachment.id);
  const retry = await engine.start({ projectPath: project, request: stored.request, attachmentIds: stored.attachments.map((item) => item.id) });
  await engine.pending;
  assert.equal(retry.status, 'completed');
  await assert.rejects(engine.start({ projectPath: project, request: stored.request, attachmentIds: ['invalid'] }), /附件/);
  assert.equal(engine.activeRunId, null);
});

test('GPT approval cannot override failed validation', async (t) => {
  const { engine, project } = await fixture(t, { checkCode: 1 });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.status, 'needs_attention');
  assert.equal(run.round, 2);
  assert.equal(run.completedAt, null);
  assert.equal(run.reviewHistory.length, 2);
  assert.ok(run.reviewHistory.every((round) => round.checks.some((check) => check.code !== 0)));
});

test('API-key authentication is refused before any model execution', async (t) => {
  const { engine, project, calls } = await fixture(t, { authMode: 'apikey' });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.status, 'failed');
  assert.deepEqual(calls, []);
  assert.match(run.error, /ChatGPT/);
});

test('cancellation preserves edits and never reaches review or completion', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { engine, project, calls } = await fixture(t, { worker: async ({ project: directory, signal }) => {
    await fs.writeFile(path.join(directory, 'result.txt'), 'partial');
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  } });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await ready;
  assert.throws(() => engine.cancel('bad-id'));
  engine.cancel(run.id);
  await engine.pending;
  assert.equal(run.status, 'cancelled');
  assert.equal(await fs.readFile(path.join(project, 'result.txt'), 'utf8'), 'partial');
  assert.equal(calls.includes('review'), false);
  assert.equal(run.tasks[0].status, 'cancelled');
  assert.ok(run.tasks[0].finishedAt);
});

test('out-of-scope edits are flagged for GPT review', async (t) => {
  const rejected = { ...approved, approved: false, findings: [{ severity: 'major', path: 'outside.txt', description: 'Unexpected edit' }] };
  const { engine, project } = await fixture(t, { review: rejected, worker: async ({ project: directory }) => {
    await fs.writeFile(path.join(directory, 'outside.txt'), 'unexpected');
    return { text: 'Done', structured: completedWorker(directory), usage: {} };
  } });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.tasks[0].status, 'failed');
  assert.match(run.tasks[0].result, /范围检查未通过/);
  assert.equal(run.status, 'needs_attention');
});

test('shortcut-only output directory reaches read-only planning without redirecting writes', async (t) => {
  const { engine, project, calls } = await fixture(t);
  await fs.writeFile(path.join(project, 'Project.lnk'), 'shortcut fixture');
  await fs.writeFile(path.join(project, 'desktop.ini'), 'metadata');
  const run = await engine.start({ projectPath: project, request: 'Document this application' });
  await engine.pending;
  assert.deepEqual(calls, ['plan', 'worker', 'review']);
  assert.equal(run.status, 'completed');
  assert.equal(await fs.readFile(path.join(project, 'Project.lnk'), 'utf8'), 'shortcut fixture');
  assert.ok(run.events.some((event) => event.message.includes('只读解析目标')));
  assert.equal(engine.activeRunId, null);
});

test('external reference is shared with workers and review while output and baseline stay local', async (t) => {
  const prompts = [];
  const planOverride = { referencePaths: [] };
  const { engine, project, store } = await fixture(t, { plan: planOverride, onPrompt: (prompt) => prompts.push(prompt),
    worker: async ({ project: output }) => {
      const content = await fs.readFile(planOverride.referencePaths[0], 'utf8');
      await fs.writeFile(path.join(output, 'result.txt'), content);
      return { structured: completedWorker(output), text: 'Read external source and saved local result' };
    } });
  const source = path.join(path.dirname(project), 'external-source.md');
  await fs.writeFile(source, 'FACT_FROM_EXTERNAL_SOURCE');
  planOverride.referencePaths.push(source);
  const run = await engine.start({ projectPath: project, request: 'Write documentation here using external source' });
  await engine.pending;
  assert.equal(run.status, 'completed');
  assert.equal(await fs.readFile(path.join(project, 'result.txt'), 'utf8'), 'FACT_FROM_EXTERNAL_SOURCE');
  assert.equal(await fs.readFile(source, 'utf8'), 'FACT_FROM_EXTERNAL_SOURCE');
  assert.deepEqual(run.changes.map((item) => item.path), ['result.txt']);
  assert.ok(prompts.every((prompt) => prompt.includes('自主浏览本机所有可访问磁盘')));
  assert.ok(prompts.slice(1).every((prompt) => prompt.includes(JSON.stringify(source))));
  assert.equal(new Store(store.directory).getRun(run.id).plan.referencePaths[0], await fs.realpath(source));
});

test('unavailable reference stops before dispatch without pretending it was read', async (t) => {
  const override = { referencePaths: [] };
  const { engine, project, calls } = await fixture(t, { plan: override });
  override.referencePaths.push(path.join(project, 'missing-reference.md'));
  const run = await engine.start({ projectPath: project, request: 'Use a missing reference' });
  await engine.pending;
  assert.equal(run.status, 'needs_attention');
  assert.match(run.error, /参考文件或目录无法访问/);
  assert.deepEqual(calls, ['plan']);
});

test('blocked planning and mismatched target directory never dispatch workers', async (t) => {
  for (const override of [
    { status: 'blocked', blockedReason: 'Missing source directory', tasks: [] },
    { projectPath: path.resolve('different-project') },
  ]) {
    const { engine, project, calls } = await fixture(t, { plan: override });
    const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
    await engine.pending;
    assert.equal(run.status, 'needs_attention');
    assert.deepEqual(calls, ['plan']);
    assert.equal(run.completedAt, null);
  }
});

test('blocked worker stops dependents and review while preserving actual edits', async (t) => {
  const second = { ...plan.tasks[0], id: 'dependent', dependencies: ['implement'] };
  const { engine, project, calls } = await fixture(t, {
    plan: { tasks: [...plan.tasks, second] },
    worker: async ({ project: directory }) => {
      await fs.writeFile(path.join(directory, 'result.txt'), 'partial edit');
      return { structured: { ...completedWorker(directory), status: 'blocked', blockers: ['缺少必要源码'] } };
    },
  });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.status, 'needs_attention');
  assert.match(run.error, /缺少必要源码/);
  assert.deepEqual(calls, ['plan', 'worker']);
  assert.deepEqual(run.tasks.map((task) => task.status), ['blocked', 'blocked']);
  assert.deepEqual(run.changes, [{ path: 'result.txt', status: 'added' }]);
});

test('unstructured worker text cannot complete a dependency', async (t) => {
  const { engine, project, calls } = await fixture(t, {
    plan: { tasks: [...plan.tasks, { ...plan.tasks[0], id: 'dependent', dependencies: ['implement'] }] },
    worker: async () => ({ text: 'Done' }),
    review: { ...approved, approved: false },
  });
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.tasks[0].status, 'failed');
  assert.equal(run.tasks[1].status, 'blocked');
  assert.equal(calls.filter((call) => call === 'worker').length, 1);
  assert.equal(run.status, 'needs_attention');
});

test('incomplete file coverage prevents both planning and final delivery', async (t) => {
  const { fingerprint } = require('../src/core/context.cjs');
  for (const failAt of [1, 5]) {
    const { engine, project, calls } = await fixture(t);
    let scans = 0;
    engine.fingerprint = async (directory) => {
      const snapshot = await fingerprint(directory);
      if (++scans === failAt) snapshot.coverage = { complete: false, reasons: ['test file limit'] };
      return snapshot;
    };
    const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
    await engine.pending;
    assert.equal(run.status, 'needs_attention');
    assert.match(run.error, /扫描不完整/);
    assert.equal(run.completedAt, null);
    if (failAt === 1) assert.deepEqual(calls, []);
    else assert.ok(calls.includes('review'));
  }
});

test('successful checks that change reviewed code invalidate GPT approval', async (t) => {
  const { engine, project, calls } = await fixture(t);
  let version = 0;
  engine.runProcess = async (command) => {
    if (command === 'git') return { code: 1, stdout: '', stderr: '' };
    await fs.writeFile(path.join(project, 'result.txt'), `Changed by check ${++version}`);
    return { code: 0, stdout: 'success', stderr: '' };
  };
  const run = await engine.start({ projectPath: project, request: 'Implement a small module' });
  await engine.pending;
  assert.equal(run.status, 'needs_attention');
  assert.equal(calls.filter((item) => item === 'review').length, 2);
  assert.equal(run.review.approved, false);
});
