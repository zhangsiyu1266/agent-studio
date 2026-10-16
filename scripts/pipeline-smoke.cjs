'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Orchestrator } = require('../src/core/orchestrator.cjs');
const { defaultSettings } = require('../src/core/discovery.cjs');

async function main() {
  const project = path.resolve('.build', `acceptance-project-${Date.now()}`);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# 临时验收项目\n用于 Agent Studio 的真实端到端验证，允许在此目录创建与修改文件。\n');
  const store = new Store(path.resolve('.build', 'acceptance-data'), { ...defaultSettings(), maxReviewRounds: 3 });
  const engine = new Orchestrator(store, (event) => {
    if (event.type === 'run.updated') {
      const run = event.run;
      const last = run.events.at(-1);
      if (last && last.id !== main.lastEvent) {
        main.lastEvent = last.id;
        console.log(`[${run.status}] ${last.provider}: ${last.message.slice(0, 250)}`);
      }
    }
  });
  const run = await engine.start({
    projectPath: project,
    request: '这是一个真实端到端验收任务。请实现一个纯 Node.js CommonJS 小模块 sum.cjs，导出 sum(a,b)，只接受有限数字，非法参数抛 TypeError。创建 sum.test.cjs，使用 node:test 验证整数、小数、负数、NaN、Infinity 和字符串等情况。不要安装依赖。必须由 GPT 规划并审查，将实现和测试委派给 DeepSeek，将验收边界分析委派给 Qwen（只读建议，可以先执行供开发者参考）。测试命令 node --test sum.test.cjs。最终由 GPT 读取实际源文件审查修改并批准。',
  });
  await engine.pending;
  await fs.writeFile(path.resolve('.build', 'pipeline-smoke.json'), JSON.stringify({ id: run.id, status: run.status, review: run.review, tasks: run.tasks, checks: run.checks, usage: run.usage, error: run.error }, null, 2));
  console.log(`Pipeline: ${run.status}`);
  if (run.status !== 'completed') process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
