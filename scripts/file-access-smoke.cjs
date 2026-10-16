'use strict';

// Opt-in real inference, isolated sibling source/output directories.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store.cjs');
const { Orchestrator } = require('../src/core/orchestrator.cjs');
const { defaultSettings } = require('../src/core/discovery.cjs');

async function main() {
  const root = path.resolve('.build', `file-access-acceptance-${Date.now()}`);
  const project = path.join(root, 'output');
  const source = path.join(root, 'reference-software');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(source);
  const marker = 'external-fact-' + randomUUID();
  const contents = `'use strict';\nmodule.exports = (name) => ${JSON.stringify(marker + ':')} + name;\n`;
  await fs.writeFile(path.join(source, 'greet.cjs'), contents);
  await fs.writeFile(path.join(project, '参考软件.url'), '[InternetShortcut]\nURL=' + pathToFileURL(source).href + '\n');
  const store = new Store(path.join(root, 'data'), { ...defaultSettings(), timeoutMinutes: 10, maxReviewRounds: 2 });
  let last;
  const engine = new Orchestrator(store, (event) => {
    const entry = event.run?.events.at(-1);
    if (entry && entry.id !== last) {
      last = entry.id;
      console.log(`[${event.run.status}] ${entry.provider}: ${entry.message.slice(0, 220)}`);
    }
  });
  console.log('Acceptance directory: ' + root);
  const run = await engine.start({ projectPath: project,
    request: '给本目录中“参考软件.url”指向的软件写一份简短中英双语 README.md，放在本目录。先读取快捷方式内容定位外部源码，读取 greet.cjs 的实际内容，在文档中准确给出完整字符串前缀、函数行为和一个 Node 使用示例。只能新增本目录的 README.md，不修改快捷方式或外部源码。无需安装依赖、运行软件、提交或发布。常规文档实现只分配一个 DeepSeek 任务，GPT 负责亲自规划和最终核查。最终检查用 node -e 验证文档存在且包含从原文件提取的正确前缀。不要在成果目录运行 npm test，不要因为参考源码位于其他目录要求用户切换项目。' });
  await engine.pending;
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ project, source, id: run.id, status: run.status,
    error: run.error, plan: run.plan, tasks: run.tasks, review: run.review, checks: run.checks, modelCalls: run.modelCalls }, null, 2));
  assert.equal(run.status, 'completed', run.error || run.review?.summary);
  assert.equal(run.projectPath, project);
  assert.ok(run.plan.referencePaths.some((target) => target === source || target.startsWith(source + path.sep)));
  assert.ok((await fs.readFile(path.join(project, 'README.md'), 'utf8')).includes(marker));
  assert.equal(await fs.readFile(path.join(source, 'greet.cjs'), 'utf8'), contents);
  assert.deepEqual(run.changes.map((item) => item.path), ['README.md']);
  assert.deepEqual(run.modelCalls.map((call) => call.provider), ['gpt', 'deepseek', 'gpt']);
  console.log('PASS: external discovery, real reads, local output, checks and GPT review. Report: ' + path.join(root, 'report.json'));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
