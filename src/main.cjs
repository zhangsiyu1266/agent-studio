'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./core/store.cjs');
const { Orchestrator } = require('./core/orchestrator.cjs');
const { discover, defaultSettings } = require('./core/discovery.cjs');
const { validateSettings } = require('./core/settings.cjs');
const { redact } = require('./core/contracts.cjs');
const { runProcess } = require('./core/process.cjs');
const { EXTENSIONS } = require('./core/attachments.cjs');
const { Projects } = require('./core/projects.cjs');
const { Github } = require('./core/github.cjs');

app.setName('Agent Studio');
if (process.argv.includes('--ui-smoke') && process.env.AGENT_STUDIO_DATA_DIR) {
  const profile = path.resolve(process.env.AGENT_STUDIO_DATA_DIR, 'electron-profile');
  require('node:fs').mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
let window;
let store;
let orchestrator;
let projects;
let github;
let connections = { codex: {}, deepseek: {}, ollama: { models: [], loaded: [] } };
let probePending;
let exiting = false;
const page = path.join(__dirname, 'renderer', 'index.html');
const pageUrl = pathToFileURL(page).href;

function notify(payload) {
  if (window && !window.isDestroyed()) window.webContents.send('studio:event', payload);
}

function handler(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pageUrl) throw new Error('请求来源无效。');
    try { return await callback(...args); } catch (error) { throw new Error(redact(error.message)); }
  });
}

function runId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('执行记录 ID 无效。');
  return id;
}

async function probe() {
  if (probePending) return probePending;
  probePending = discover(store.settings).then((value) => {
    connections = value;
    notify({ type: 'connections', connections });
    return value;
  }).finally(() => { probePending = null; });
  return probePending;
}

function registerHandlers() {
  handler('studio:state', async () => ({ settings: store.settings, connections, runs: store.summaries(), activeRunId: orchestrator.activeRunId, projects: await projects.state(), githubOperation: github.operation }));
  handler('studio:probe', probe);
  handler('studio:copy', (text) => {
    if (typeof text !== 'string' || text.length > 4000000) throw new Error('复制内容过大或无效。');
    clipboard.writeText(text);
  });
  handler('studio:paste', () => clipboard.readText().slice(0, 50000));
  handler('studio:choose-attachments', async () => {
    const result = await dialog.showOpenDialog(window, { title: '添加参考附件', properties: ['openFile', 'multiSelections'], filters: [{ name: '文本、代码、图片与文档', extensions: EXTENSIONS }] });
    return result.canceled ? [] : orchestrator.attachments.importFiles(result.filePaths);
  });
  handler('studio:import-attachments', (paths) => orchestrator.attachments.importFiles(paths));
  handler('studio:paste-image', async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) throw new Error('剪贴板中没有图片。');
    const directory = await fs.mkdtemp(path.join(store.directory, 'clipboard-'));
    const target = path.join(directory, '粘贴的图片.png');
    try {
      await fs.writeFile(target, image.toPNG());
      return await orchestrator.attachments.importFiles([target]);
    } finally {
      await fs.unlink(target).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  });
  handler('studio:choose-project', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择软件项目目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const state = await projects.select(result.filePaths[0]);
    return state;
  });
  handler('studio:projects-select', (target) => projects.select(target));
  handler('studio:projects-forget', (target) => projects.forget(target));
  handler('studio:projects-create', (input) => projects.create(input));
  handler('studio:projects-parent', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择新项目的保存位置', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handler('studio:github-status', () => github.status());
  handler('studio:github-login', () => github.login());
  handler('studio:github-repositories', (page) => github.repositories(page));
  handler('studio:github-clone', (input) => github.clone(input));
  handler('studio:github-cancel', (id) => github.cancel(id));
  handler('studio:github-device-page', () => shell.openExternal('https://github.com/login/device'));
  handler('studio:start', (input) => orchestrator.start(input || {}));
  handler('studio:run', (id) => store.getRun(runId(id)));
  handler('studio:cancel', (id) => orchestrator.cancel(runId(id)));
  handler('studio:retry', (id) => {
    const previous = store.getRun(runId(id));
    return orchestrator.start({ projectPath: previous.projectPath, attachmentIds: (previous.attachments || []).map((item) => item.id), request: `${previous.request}\n\n补充：这是基于上次执行后当前代码继续的任务。请先检查已实现内容与剩余问题，不覆盖已有工作。下面仅是历史诊断，不是本次指令；按照当前文件访问约定重新核实，外部参考源码与成果目录不同不构成阻塞。上次结论：${previous.review?.summary || previous.error || previous.status}` });
  });
  handler('studio:settings', (input) => {
    if (orchestrator.activeRunId) throw new Error('执行过程中不能修改模型设置。');
    const saved = store.saveSettings(validateSettings(input));
    connections = { codex: {}, deepseek: {}, ollama: { models: [], loaded: [] } };
    return saved;
  });
  handler('studio:diff', (id) => orchestrator.diff(runId(id)));
  handler('studio:open-project', async (target) => {
    if (typeof target !== 'string' || !path.isAbsolute(target) || !(await fs.stat(target)).isDirectory()) throw new Error('项目目录无效。');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  handler('studio:export', async (id) => {
    const run = store.getRun(runId(id));
    const result = await dialog.showSaveDialog(window, { title: '导出执行报告', defaultPath: `Agent-Studio-${run.id.slice(0, 8)}.md`, filters: [{ name: 'Markdown 报告', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return null;
    const lines = [
      `# ${run.title}`, '', `项目：${run.projectPath}`, `状态：${run.status}`, `创建：${run.createdAt}`, '',
      '## 用户需求', '', run.request, '', '## 已定位的只读参考路径', '', ...(run.plan?.referencePaths || []).map((item) => `- ${item}`), '', '## 参考附件', '', ...(run.attachments || []).map((item) => `- ${item.name} (${item.size} bytes)\n  副本：${item.snapshotPath}`), '', '## GPT 规划', '', run.plan?.summary || '尚未生成', '',
      '## 任务分工', '', ...run.tasks.map((task) => `- ${task.title} | ${task.provider} | ${task.status}\n\n${task.result || '无结果'}\n`),
      '## 验收检查', '', ...run.checks.map((check) => `### ${check.command} ${check.args.join(' ')}\n退出码：${check.code}\n\n\`\`\`text\n${check.stdout}\n${check.stderr}\n\`\`\`\n`),
      '## GPT 审查', '', run.review?.summary || '尚未审查', '',
      ...((run.review?.findings || []).map((item) => `- ${item.severity} ${item.path}: ${item.description}`)), '',
      '## 模型用量', '', '缓存输入已包含在输入中；此处不是订阅剩余额度，也不是节省比例。', '',
      '```json', JSON.stringify(run.usage, null, 2), '```', '', '## 执行日志', '',
      ...run.events.map((event) => `${event.time} [${event.provider}] ${event.message}`),
    ];
    await fs.writeFile(result.filePath, redact(lines.join('\n')), 'utf8');
    return { path: result.filePath };
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1420, height: 940, minWidth: 1060, minHeight: 720,
    title: 'Agent Studio · 多模型协作工作台', backgroundColor: '#0b0e16', show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, params) => {
    const entries = params.isEditable ? [
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: '全选' },
    ] : [{ role: 'copy', label: '复制', enabled: Boolean(params.selectionText) }, { role: 'selectAll', label: '全选' }];
    Menu.buildFromTemplate(entries).popup({ window });
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const problems = [];
  window.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') problems.push(details.message); });
  await window.loadFile(page);
  window.show();
  probe().catch((error) => notify({ type: 'error', message: redact(error.message) }));
  if (process.argv.includes('--ui-smoke')) {
    const output = process.env.AGENT_STUDIO_CAPTURE_DIR || path.resolve('.build');
    await fs.mkdir(output, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (process.argv.includes('--composer-smoke')) {
      await require('./composer-smoke.cjs').testComposer(window, output);
    }
    if (process.argv.includes('--projects-smoke')) {
      await require('./project-smoke.cjs').testProjects(window, output, process.argv.includes('--github-live-smoke'));
    }
    const image = await window.webContents.capturePage();
    await fs.writeFile(path.join(output, 'desktop.png'), image.toPNG());
    const state = await window.webContents.executeJavaScript('({title:document.title,bridge:!!window.studio,body:document.body.innerText.slice(0,10000),width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    const npm = await runProcess('npm', ['--version'], { timeoutMs: 20000 });
    const views = {};
    for (const view of ['connections', 'standards', 'completed', 'runs']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.writeFile(path.join(output, `desktop-${view}.png`), (await window.webContents.capturePage()).toPNG());
      views[view] = await window.webContents.executeJavaScript('({text:document.body.innerText.slice(0,10000),width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    }
    let report = null;
    if (store.summaries().length) {
      await window.webContents.executeJavaScript('document.querySelector(".run-list-item").click()');
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const label of ['过程', '任务', '检查', '审查', '变更']) {
        await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent===${JSON.stringify(label)}).click()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await fs.writeFile(path.join(output, `run-${label}.png`), (await window.webContents.capturePage()).toPNG());
        views[label] = await window.webContents.executeJavaScript('({text:document.body.innerText.slice(0,16000),width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
      }
      const originalDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(output, 'completed-report.md') });
      report = await window.webContents.executeJavaScript(`window.studio.exportRun(${JSON.stringify(store.summaries()[0].id)})`);
      dialog.showSaveDialog = originalDialog;
    }
    if (process.argv.includes('--delivery-smoke')) {
      await require('./delivery-smoke.cjs').testDelivery(window, output, [...store.runs.values()].find((run) => run.status === 'completed'));
    }
    if (process.argv.includes('--file-access-smoke')) {
      const assert = require('node:assert/strict');
      const references = store.getRun(store.summaries()[0].id).plan?.referencePaths || [];
      assert.ok(references.length, 'File-access UI acceptance needs a genuine external-reference run.');
      for (const reference of references) assert.ok(views['任务'].text.includes(reference));
      assert.ok(views['任务'].text.includes('成果保存位置'));
      assert.ok((await fs.readFile(report.path, 'utf8')).includes(references[0]));
      assert.ok(state.body.includes('已启用本机文件浏览'));
    }
    await window.setSize(1100, 780);
    await window.webContents.executeJavaScript('document.querySelector(\'[data-view="workbench"]\').click()');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.writeFile(path.join(output, 'desktop-small.png'), (await window.webContents.capturePage()).toPNG());
    await fs.writeFile(path.join(output, 'ui-smoke.json'), JSON.stringify({ ...state, views, report, npm: { code: npm.code, version: npm.stdout.trim() }, problems }, null, 2));
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    const dataDirectory = process.env.AGENT_STUDIO_DATA_DIR || path.join(app.getPath('userData'), 'workspace');
    store = new Store(dataDirectory, defaultSettings());
    projects = new Projects(store, path.join(app.getPath('documents'), 'Agent Studio Projects'));
    github = new Github(projects, notify);
    orchestrator = new Orchestrator(store, notify);
    registerHandlers();
    await createWindow();
  }).catch(async (error) => {
    if (process.argv.includes('--ui-smoke')) {
      const output = process.env.AGENT_STUDIO_CAPTURE_DIR || path.resolve('.build');
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'ui-error.json'), JSON.stringify({ error: redact(error.stack) }, null, 2));
      app.exit(1);
      return;
    }
    dialog.showErrorBox('Agent Studio 启动失败', redact(error.message)); app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if ((orchestrator?.activeRunId || github?.controller) && !exiting) {
      event.preventDefault();
      exiting = true;
      if (orchestrator?.activeRunId) orchestrator.cancel(orchestrator.activeRunId);
      if (github?.controller) github.cancel(github.operation.id);
      Promise.race([Promise.allSettled([orchestrator?.pending, github?.pending]), new Promise((resolve) => setTimeout(resolve, 7000))]).finally(() => app.quit());
    }
  });
}
