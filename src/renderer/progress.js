'use strict';

(function (root) {
  function describe(run) {
    const tasks = run.tasks || [];
    const checks = run.checks || [];
    const completed = run.status === 'completed';
    const active = ['planning', 'executing', 'checking', 'reviewing', 'repairing'].includes(run.status);
    const doneTasks = tasks.filter((task) => ['completed', 'superseded'].includes(task.status)).length;
    const expectedChecks = run.plan?.checks?.length || 0;
    const passedChecks = checks.filter((check) => check.code === 0).length;
    const checkDone = checks.length === expectedChecks && passedChecks === expectedChecks;
    const planBlocked = run.planningBlocked || run.plan?.status === 'blocked';
    const stages = [
      { label: 'GPT 规划', note: planBlocked ? '前置条件未满足' : run.plan ? '方案与分工已生成' : '分析需求和项目', done: Boolean(run.plan) && !planBlocked, current: run.status === 'planning' },
      { label: '模型执行', note: tasks.length ? `${doneTasks} / ${tasks.length} 个任务完成` : '等待任务分配', done: tasks.length > 0 && doneTasks === tasks.length, current: ['executing', 'repairing'].includes(run.status) },
      { label: '验收检查', note: expectedChecks ? `${passedChecks} / ${expectedChecks} 项检查通过` : run.plan ? '未配置自动检查' : '等待验收方案', done: completed || (expectedChecks > 0 && checkDone && run.status !== 'checking'), current: run.status === 'checking' },
      { label: 'GPT 审查', note: run.round ? `第 ${run.round} 轮${completed ? ' · 已通过' : ''}` : '等待检查结果', done: completed, current: run.status === 'reviewing' },
      { label: '交付成果', note: completed ? '成果已保存到项目目录' : '通过审查与验收后交付', done: completed, current: false },
    ];
    for (const stage of stages) stage.state = stage.current ? 'current' : stage.done ? 'done' : 'pending';
    if (!active && !completed) {
      const index = stages.findIndex((stage) => !stage.done);
      if (index >= 0) stages[index].state = 'attention';
    }
    return { stages, tasks, doneTasks, passedChecks, expectedChecks, completed, active };
  }

  function finished(runs, query = '') {
    const needle = query.trim().toLocaleLowerCase();
    return runs.filter((run) => run.status === 'completed' && (!needle || `${run.title} ${run.projectPath}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt));
  }

  const api = { describe, finished };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.runProgress = api;
})(typeof window !== 'undefined' ? window : globalThis);
