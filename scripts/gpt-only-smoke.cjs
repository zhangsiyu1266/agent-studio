'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { configureRuntimeEnvironment, bundledCodex } = require('../src/core/runtime.cjs');
const { defaultSettings } = require('../src/core/discovery.cjs');
const { Store } = require('../src/core/store.cjs');
const { Orchestrator } = require('../src/core/orchestrator.cjs');

// Opt-in real inference, using existing local ChatGPT authentication. Never copies it.
async function main() {
  configureRuntimeEnvironment();
  const root = await fs.mkdtemp(path.resolve('.build/gpt-only-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const settings = { ...defaultSettings(), codexCommand: bundledCodex(), claudeCommand: path.join(root, 'not-installed.exe'),
    claudeSettingsPath: path.join(root, 'no-settings.json'), ollamaUrl: 'http://127.0.0.1:1', maxReviewRounds: 2, timeoutMinutes: 10 };
  const store = new Store(path.join(root, 'data'), settings);
  let lastPhase;
  const engine = new Orchestrator(store, (event) => {
    if (event.run?.phase !== lastPhase) {
      lastPhase = event.run.phase;
      console.log(JSON.stringify({ status: event.run.status, phase: lastPhase }));
    }
  });
  const run = await engine.start({ projectPath: project,
    request: '真实 GPT 基础模式验收。只在当前新项目内创建 greet.cjs，导出 name => `Hello, ${name}!`，再创建 greet.test.cjs，用 node:test 验证 greet("Ada") 为 "Hello, Ada!"。仅需要一个 GPT 实现任务，辅助模型不可用。验收命令用 node --test greet.test.cjs。不要访问项目外资料，不安装依赖，不写额外文档。GPT 最终核对源码及测试。' });
  await engine.pending;
  const report = { kind: 'real-gpt-only-inference', status: run.status, calls: run.modelCalls, tasks: run.tasks.map(({ id, provider, requestedProvider, status }) => ({ id, provider, requestedProvider, status })), checks: run.checks, summary: run.review?.summary, error: run.error };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(root, 'report.json'), status: run.status }));
  assert.equal(run.status, 'completed');
  assert.ok(run.tasks.every((task) => task.provider === 'gpt'));
  assert.ok(run.modelCalls.every((call) => call.provider === 'gpt' && call.status === 'completed'));
  assert.ok(run.checks.length && run.checks.every((check) => check.code === 0));
  assert.match(await fs.readFile(path.join(project, 'greet.cjs'), 'utf8'), /Hello/);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
