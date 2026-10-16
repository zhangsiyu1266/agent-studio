'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');

// Explicit acceptance mode only. Real IPC/filesystem, optionally a public clone;
// never starts OAuth, inference, pushes or user-project edits.
async function testProjects(window, output, liveClone = false) {
  const evaluate = (script) => window.webContents.executeJavaScript(script, true);
  const waitFor = async (script, attempts = 160) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(script)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Project UI timeout: ' + script);
  };
  const parent = path.join(output, 'project-fixtures');
  await fs.mkdir(parent, { recursive: true });
  const suffix = Date.now();
  const name = `界面验收-${suffix}`;
  const local = path.join(parent, `已有项目-${suffix}`);
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'keep.txt'), 'user source fixture');
  const originalDialog = dialog.showOpenDialog;
  const checks = [];
  let clone = null;
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
    await evaluate('document.querySelector("[data-view=workbench]").click(); document.querySelector("#new-project").click()');
    await evaluate(`document.querySelector('#project-name').value = ${JSON.stringify(name)}; document.querySelector('#project-change-parent').click()`);
    await waitFor(`document.querySelector('#project-parent').textContent === ${JSON.stringify(parent)}`);
    await evaluate('document.querySelector("#project-submit").click()');
    await waitFor(`!document.querySelector('#project-dialog') && document.querySelector('#project-path').textContent.includes(${JSON.stringify(name)})`);
    assert.equal((await fs.stat(path.join(parent, name))).isDirectory(), true);
    checks.push('new project creates directory and selects it through real IPC');

    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] });
    await evaluate('document.querySelector("#choose-project").click()');
    await waitFor(`document.querySelector('#project-path').textContent === ${JSON.stringify(local)}`);
    window.webContents.reload();
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    await waitFor(`document.querySelector('#project-path')?.textContent === ${JSON.stringify(local)}`);
    assert.ok(await evaluate('document.querySelectorAll(".recent-project-choice").length >= 2'));
    await evaluate(`Array.from(document.querySelectorAll('.recent-project-choice')).find(node => node.textContent.includes(${JSON.stringify(name)})).click()`);
    await waitFor(`document.querySelector('#project-path').textContent.includes(${JSON.stringify(name)})`);
    assert.equal(await fs.readFile(path.join(local, 'keep.txt'), 'utf8'), 'user source fixture');
    checks.push('local selection, recent switching and reload restore the project');
    await fs.writeFile(path.join(output, 'projects-workbench.png'), (await window.webContents.capturePage()).toPNG());

    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
    await evaluate('document.querySelector("#github-import").click()');
    await waitFor('document.querySelector("#github-account")?.textContent !== "正在检测 GitHub 登录状态…"');
    await evaluate('document.querySelector("#github-repository").value = "https://evil.example/owner/repo"; document.querySelector("#project-name").value = "invalid"; document.querySelector("#project-submit").click()');
    await waitFor('document.querySelector("#project-dialog-error").textContent.includes("github.com")');
    checks.push('GitHub dialog detects real CLI and rejects non-GitHub addresses');
    await fs.writeFile(path.join(output, 'github-import.png'), (await window.webContents.capturePage()).toPNG());
    if (liveClone) {
      await evaluate(`document.querySelector('#github-repository').value = 'octocat/Hello-World'; document.querySelector('#project-name').value = 'github-live-${suffix}'; document.querySelector('#project-change-parent').click()`);
      await waitFor(`document.querySelector('#project-parent').textContent === ${JSON.stringify(parent)}`);
      await evaluate('document.querySelector("#project-submit").click()');
      await waitFor('window.studio.getState().then(state => state.githubOperation?.kind === "clone" && state.githubOperation.status !== "running")', 900);
      const state = await evaluate('window.studio.getState()');
      clone = state.githubOperation;
      assert.equal(clone.status, 'completed', clone.message);
      assert.equal(state.projects.selectedPath, clone.projectPath);
      assert.equal((await fs.stat(path.join(clone.projectPath, '.git'))).isDirectory(), true);
      assert.equal((await fs.readFile(path.join(clone.projectPath, 'README'), 'utf8')).trim(), 'Hello World!');
      checks.push('actual public GitHub repository downloads and becomes current project');
    } else await evaluate('document.querySelector("#project-dialog-close").click()');
    window.setSize(1100, 780);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await fs.writeFile(path.join(output, 'projects-small.png'), (await window.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output, 'projects-smoke.json'), JSON.stringify({ passed: true, liveClone, clone, checks }, null, 2));
  } finally { dialog.showOpenDialog = originalDialog; }
}

module.exports = { testProjects };
