'use strict';

// Opt-in live inference: isolated project, real providers, no synthetic completed runs.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { Orchestrator } = require('../src/core/orchestrator.cjs');
const { createProviders } = require('../src/core/providers.cjs');
const { defaultSettings } = require('../src/core/discovery.cjs');
const { workerSchema, validateWorker } = require('../src/core/contracts.cjs');

async function main() {
  const root = path.resolve('.build', `performance-acceptance-${Date.now()}`);
  const project = path.join(root, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'greet.cjs'), "'use strict';\nmodule.exports = (name) => 'Hello, ' + name;\n");
  const settings = { ...defaultSettings(), timeoutMinutes: 10, maxReviewRounds: 2 };
  const qwen = await createProviders(settings).qwen.run({
    cwd: project, schema: workerSchema, thinking: false,
    prompt: `这是只读提取验收。当前项目目录为 ${project}。提供的 greet.cjs 完整内容为：module.exports = (name) => 'Hello, ' + name;\n只需说明该函数行为，以 JSON 返回 status=completed, projectPath 为上述目录, summary 简洁说明行为, changedFiles=[], checks=['仅检查给定文本，未运行测试'], blockers=[]。不要调用工具。`,
  });
  validateWorker(qwen.structured);
  assert.equal(qwen.performance.contextTokens, 8192);
  assert.equal(qwen.performance.thinking, false);
  console.log(JSON.stringify({ qwen: 'passed', performance: qwen.performance, usage: qwen.usage }));
  const store = new Store(path.join(root, 'data'), settings);
  let last;
  const engine = new Orchestrator(store, (event) => {
    const entry = event.run?.events.at(-1);
    if (entry && entry.id !== last) {
      last = entry.id;
      console.log(`[${event.run.status}] ${entry.provider}: ${entry.message.slice(0, 180)}`);
    }
  });
  const run = await engine.start({
    projectPath: project,
    request: '为当前仅有 greet.cjs 的微型项目创建 README.md，准确说明模块的导出、用途、两个可直接运行的 Node 调用示例和不校验输入的限制。只改 README.md，不新增代码、依赖或测试文件。已有完整源码仅一行，常规文档任务只分配一个 DeepSeek 实现任务，GPT 负责规划与最终实际核查。不需要额外调研、Qwen 或 GPT 工作任务。验收检查用 node -e 读取 greet.cjs 并验证正常字符串输入的实际返回值。',
  });
  await engine.pending;
  const report = { project, id: run.id, status: run.status, error: run.error, tasks: run.tasks, checks: run.checks, review: run.review, modelCalls: run.modelCalls, qwen: { performance: qwen.performance, usage: qwen.usage } };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Live report: ${path.join(root, 'report.json')}`);
  assert.equal(run.status, 'completed', run.error || run.review?.summary);
  assert.equal(run.tasks.length, 1);
  assert.equal(run.tasks[0].provider, 'deepseek');
  assert.equal(run.tasks[0].status, 'completed');
  assert.deepEqual(run.modelCalls.map((call) => call.provider), ['gpt', 'deepseek', 'gpt']);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
