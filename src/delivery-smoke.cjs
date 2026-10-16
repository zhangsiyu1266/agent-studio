'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// Isolated UI acceptance only: explicitly labeled replay, no model inference or saved synthetic runs.
async function testDelivery(window, output, original) {
  if (!original) throw new Error('Delivery UI acceptance requires a genuine completed fixture.');
  const evaluate = (script) => window.webContents.executeJavaScript(script, true);
  const delay = () => new Promise((resolve) => setTimeout(resolve, 150));
  const emit = async (run) => { window.webContents.send('studio:event', { type: 'run.updated', run }); await delay(); };
  const run = JSON.parse(JSON.stringify(original));
  run.title = '界面验收回放（仅测试）：' + run.title;
  const checks = [];
  try {
    await evaluate('document.querySelector("[data-view=completed]").click()');
    assert.ok(await evaluate('document.querySelectorAll(".delivery-item").length > 0'));
    await evaluate('const search = document.querySelector("#completed-search"); search.value = "no-match-acceptance"; search.dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('document.querySelectorAll(".delivery-item").length'), 0);
    assert.match(await evaluate('document.querySelector("#completed-detail").innerText'), /没有匹配/);
    await evaluate('document.querySelector("#completed-search").value = ""; document.querySelector("#completed-search").dispatchEvent(new Event("input"))');
    checks.push('completed search and empty state');

    run.status = 'executing';
    run.phase = '界面验收回放：DeepSeek 正在执行';
    run.completedAt = null;
    run.tasks[0].status = 'running';
    run.tasks[1].status = 'pending';
    await emit(run);
    assert.equal(await evaluate('document.querySelectorAll(".delivery-item").length'), 0);
    await evaluate('document.querySelector("[data-view=workbench]").click()');
    assert.equal(await evaluate('document.querySelectorAll("#active-run-body .process-current").length'), 1);
    checks.push('live progress and exclusion of active work');

    await evaluate('document.querySelector("[data-view=runs]").click(); document.querySelector(".run-list-item").click()');
    await delay();
    // Restore the replay snapshot after the real getRun response.
    run.status = 'checking';
    run.phase = '界面验收回放：审查后再次验证';
    run.tasks = original.tasks;
    run.checks = original.checks.slice(0, 1);
    await emit(run);
    const deliveryState = await evaluate('Array.from(document.querySelectorAll("#run-detail .process-node")).at(-1).className');
    assert.ok(deliveryState.includes('process-pending'));
    checks.push('partial checks cannot show delivery as completed');

    Object.assign(run, JSON.parse(JSON.stringify(original)));
    run.title = '界面验收回放（仅测试）：' + original.title;
    run.completedAt = new Date().toISOString();
    run.phaseHistory = [
      { status: 'planning', phase: '回放：GPT 规划', time: run.createdAt },
      { status: 'executing', phase: '回放：DeepSeek 执行', time: run.createdAt },
      { status: 'reviewing', phase: '回放：GPT 最终审查', time: run.completedAt },
      { status: 'completed', phase: '回放：验收完成', time: run.completedAt },
    ];
    run.reviewHistory = [{ round: 1, time: run.completedAt, review: run.review, checks: run.checks }];
    run.modelCalls = [{ provider: 'qwen', phase: '界面验收回放：提取证据', status: 'completed', durationMs: 4300,
      performance: { contextTokens: 8192, thinking: false, loadMs: 2300, promptMs: 150, generationMs: 1800 } }];
    await emit(run);
    assert.match(await evaluate('document.querySelector("#run-detail .model-timings").innerText'), /8K.*思考关闭/);
    assert.match(await evaluate('document.querySelector("#run-detail .model-timings").innerText'), /4.3 秒/);
    checks.push('model duration, adaptive context and inference breakdown');
    assert.equal(await evaluate('document.querySelectorAll("#run-detail .process-event").length'), 4);
    await evaluate('document.querySelector("#run-detail .process-task summary").click()');
    assert.equal(await evaluate('document.querySelector("#run-detail .process-task").open'), true);
    await emit(run);
    assert.equal(await evaluate('document.querySelector("#run-detail .process-task").open'), true);
    await fs.writeFile(path.join(output, 'process-replay.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('Array.from(document.querySelectorAll("#run-detail button")).find(e=>e.textContent.includes("查看完成成果")).click()');
    assert.match(await evaluate('document.querySelector("#completed-detail").innerText'), /打开成果目录/);
    assert.equal(await evaluate('document.querySelectorAll(".delivery-item").length'), 1);
    checks.push('completion event, timestamps, expandable handoff and results navigation');
    await evaluate('Array.from(document.querySelectorAll("#completed-detail button")).find(e=>e.textContent==="查看完整过程").click()');
    await delay();
    assert.equal(await evaluate('document.querySelector("[data-view=runs]").getAttribute("aria-current")'), 'page');
    await emit(original);
    await evaluate('document.querySelector("[data-view=completed]").click()');
    window.setSize(1100, 780);
    await delay();
    const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
    assert.equal(overflow, false);
    await fs.writeFile(path.join(output, 'completed-small.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('process link and compact desktop layout');
    run.status = 'needs_attention';
    run.error = '界面验收回放：工作目录不一致，请选择真实源码目录。';
    run.phase = '前置条件未满足，等待处理';
    run.tasks = run.tasks.map((task) => ({ ...task, status: 'blocked' }));
    await emit(run);
    assert.equal(await evaluate('document.querySelectorAll(".delivery-item").length'), 0);
    await evaluate('document.querySelector("[data-view=runs]").click()');
    await emit(run);
    assert.match(await evaluate('document.querySelector("#run-detail").innerText'), /工作目录不一致/);
    assert.equal(await evaluate('document.querySelector("#run-detail").scrollWidth > document.querySelector("#run-detail").clientWidth'), false);
    assert.ok(await evaluate('document.querySelector("#run-detail .run-detail-header > div").getBoundingClientRect().width >= 250'));
    await fs.writeFile(path.join(output, 'blocked-replay.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('blocked work exposes reason and is excluded from completed results');
    await fs.writeFile(path.join(output, 'delivery-smoke.json'), JSON.stringify({ passed: true, replayOnly: true, checks }, null, 2));
  } finally { await emit(original); }
}

module.exports = { testDelivery };
