'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const VIEW_META = {
    workbench: { title: '工作台', subtitle: '选择项目并描述需求，启动多模型协作' },
    runs: { title: '执行记录', subtitle: '查看每次运行的任务、日志、检查、审查与变更' },
    completed: { title: '完成任务', subtitle: '查看已通过 GPT 验收的成果、项目位置与完整过程' },
    connections: { title: '模型连接', subtitle: '配置模型命令并检测连接状态' },
    standards: { title: '工程规范', subtitle: '共享工程标准与协作约定' }
  };

  const ACTIVE_STATUSES = new Set([
    'planning', 'executing', 'checking', 'reviewing', 'repairing'
  ]);

  const STATUS_META = {
    planning: { label: '计划中', cls: 'status-planning' },
    executing: { label: '执行中', cls: 'status-executing' },
    checking: { label: '检查中', cls: 'status-checking' },
    reviewing: { label: '审查中', cls: 'status-reviewing' },
    repairing: { label: '修复中', cls: 'status-repairing' },
    completed: { label: '已完成', cls: 'status-completed' },
    needs_attention: { label: '需关注', cls: 'status-needs_attention' },
    failed: { label: '失败', cls: 'status-failed' },
    cancelled: { label: '已取消', cls: 'status-cancelled' },
    interrupted: { label: '已中断', cls: 'status-interrupted' }
  };

  const PROVIDER_META = {
    gpt: { label: 'GPT', cls: 'badge-gpt' },
    deepseek: { label: 'DeepSeek', cls: 'badge-deepseek' },
    qwen: { label: 'Qwen', cls: 'badge-qwen' }
  };

  const TASK_STATUS_META = {
    pending: { label: '待执行', cls: 'badge' },
    running: { label: '执行中', cls: 'badge-ok' },
    completed: { label: '已完成', cls: 'badge-ok' },
    failed: { label: '失败', cls: 'badge-err' },
    skipped: { label: '已跳过', cls: 'badge' },
    blocked: { label: '被阻塞', cls: 'badge-warn' },
    cancelled: { label: '已取消', cls: 'badge' },
    superseded: { label: 'GPT 已解决', cls: 'badge-ok' }
  };

  const DEFAULT_SETTINGS = {
    codexCommand: 'codex',
    gptModel: '',
    gptEffort: 'high',
    claudeCommand: 'claude',
    deepseekModel: 'deepseek-v4-pro',
    claudeSettingsPath: '',
    ollamaUrl: 'http://127.0.0.1:11434',
    qwenModel: 'qwen3:8b',
    maxReviewRounds: 3,
    timeoutMinutes: 60
  };

  const REQUIREMENT_EXAMPLES = [
    '为当前项目生成一份 README，包含安装、使用和开发规范说明。',
    '审查 src 目录下的核心模块，修复明显逻辑错误并补充单元测试。',
    '新增一个数据导出功能：将用户记录导出为 CSV，并附带基础校验。',
    '梳理项目依赖并输出升级建议，不直接修改文件。'
  ];

  const app = {
    view: 'workbench',
    settings: null,
    connections: null,
    runs: [],
    activeRunId: null,
    selectedRunId: null,
    runDetails: new Map(),
    projectPath: '',
    projects: null,
    requirement: '',
    attachments: [],
    importing: false,
    runTab: 'progress',
    completedRunId: null,
    completedLoading: null,
    completedError: '',
    diff: new Map(),
    diffRequests: new Map(),
    probing: false,
    saving: false,
    starting: false,
    settingsFormPopulated: false,
    cancelArmedId: null,
    cancelArmedTimer: null
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    node.replaceChildren();
    return node;
  }

  function button(label, className) {
    const btn = el('button', className || 'btn', label);
    btn.type = 'button';
    return btn;
  }

  function badge(label, className) {
    return el('span', 'badge ' + (className || ''), label);
  }

  function phaseLabel(phase) {
    return (STATUS_META[phase] && STATUS_META[phase].label) || phase || '—';
  }

  function statusBadge(status) {
    const meta = STATUS_META[status] || { label: status || '未知', cls: 'badge' };
    return badge(meta.label, meta.cls);
  }

  function providerBadge(provider) {
    const meta = PROVIDER_META[provider] || { label: provider || '未知', cls: 'badge' };
    return badge(meta.label, meta.cls);
  }

  function taskStatusBadge(status) {
    const meta = TASK_STATUS_META[status] || { label: status || '未知', cls: 'badge' };
    return badge(meta.label, meta.cls);
  }

  function emptyState(icon, text) {
    const box = el('div', 'empty-state');
    if (icon) box.appendChild(el('div', 'empty-icon', icon));
    if (text) box.appendChild(el('div', '', text));
    return box;
  }

  function noteBanner(text) {
    return el('div', 'note-banner', text);
  }

  function errorBanner(text) {
    return el('div', 'error-banner', text);
  }

  function modelName(model) {
    if (typeof model === 'string') return model;
    if (!model) return '未命名模型';
    return model.displayName || model.model || model.id || model.name || '未命名模型';
  }

  function displayValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return String(value);
    }
  }

  function formatNumber(value) {
    if (value === undefined || value === null) return '—';
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    return num.toLocaleString('zh-CN');
  }

  function formatTime(value, withSeconds) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const options = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    };
    if (withSeconds) options.second = '2-digit';
    try {
      return new Intl.DateTimeFormat('zh-CN', options).format(date);
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function formatShortTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date);
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function errorMessage(err, fallback) {
    if (!err) return fallback || '操作失败';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.code) return err.code;
    return fallback || '操作失败';
  }

  function showToast(message, type) {
    const region = $('toast-region');
    if (!region) return;
    const toast = el('div', 'toast ' + (type || 'info'), message);
    toast.setAttribute('role', 'status');
    region.appendChild(toast);
    setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, 4600);
  }

  function showError(err, fallback) {
    showToast(errorMessage(err, fallback), 'error');
  }

  function safe(promise, fallback) {
    return Promise.resolve(promise).then(
      (value) => value,
      (err) => {
        showError(err, fallback || '操作失败');
        return undefined;
      }
    );
  }

  function isActiveRun(run) {
    return Boolean(run && ACTIVE_STATUSES.has(run.status));
  }

  function isRetryableRun(run) {
    if (!run) return false;
    return ['failed', 'cancelled', 'interrupted', 'needs_attention'].indexOf(run.status) >= 0;
  }

  function activeRun() {
    if (app.activeRunId) {
      const byId = app.runs.find((run) => run.id === app.activeRunId && isActiveRun(run));
      if (byId) return byId;
    }
    return app.runs.find((run) => isActiveRun(run)) || null;
  }

  function currentRun() {
    if (app.selectedRunId && app.runDetails.has(app.selectedRunId)) {
      return app.runDetails.get(app.selectedRunId);
    }
    return app.runs.find((run) => run.id === app.selectedRunId) || null;
  }

  function upsertRun(run) {
    if (!run || !run.id) return;
    const previous = app.runDetails.get(run.id);
    if (previous && previous.changeVersion !== run.changeVersion) {
      app.diff.delete(run.id);
      app.diffRequests.set(run.id, (app.diffRequests.get(run.id) || 0) + 1);
    }
    const index = app.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) {
      app.runs[index] = run;
    } else {
      app.runs.unshift(run);
    }
    app.runDetails.set(run.id, run);
  }

  function setView(view) {
    if (!VIEW_META[view]) return;
    app.view = view;
    document.querySelectorAll('.nav-item').forEach((item) => {
      const active = item.dataset.view === view;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((section) => {
      section.classList.toggle('hidden', section.id !== 'view-' + view);
    });
    $('topbar-title').textContent = VIEW_META[view].title;
    $('topbar-subtitle').textContent = VIEW_META[view].subtitle;
    if (view === 'runs') renderRunsList();
    if (view === 'completed') renderCompleted();
    if (view === 'connections') ensureConnectionsView();
    if (view === 'standards') ensureStandardsView();
    if (view === 'workbench') refreshWorkbenchDynamic();
    updateRunningUi();
  }

  async function loadState() {
    try {
      const state = await safe(window.studio.getState(), '读取应用状态失败');
      if (!state) return;
      app.settings = state.settings || DEFAULT_SETTINGS;
      app.connections = state.connections || null;
      window.setupGuide.setOperation(state.setupOperation || null);
      app.runs = Array.isArray(state.runs) ? state.runs.slice() : [];
      app.activeRunId = state.activeRunId || null;
      if (state.projects) applyProjects(state.projects);
      if (state.githubOperation) window.projectPicker.operation(state.githubOperation);
      if (app.activeRunId && !app.selectedRunId) app.selectedRunId = app.activeRunId;
      if (app.selectedRunId && !app.runs.some((run) => run.id === app.selectedRunId)) {
        app.selectedRunId = app.runs.length ? app.runs[0].id : null;
      }
      updateConnectionSidebar();
      refreshWorkbenchDynamic();
      renderRunsList();
      renderCompleted();
      if (app.view === 'runs') {
        const selected = app.runs.find((run) => run.id === app.selectedRunId) || null;
      if (selected) {
        const full = await safe(window.studio.getRun(selected.id), '读取执行详情失败');
        if (full) { upsertRun(full); renderRunDetail(full); }
      } else renderRunDetailLoading(selected);
      }
      if (app.view === 'connections') {
        populateSettingsForm(app.settings);
        refreshConnectionStatus();
      }
      updateRunningUi();
    } catch (err) {
      showError(err, '刷新状态失败');
    }
  }

  function subscribeEvents() {
    if (!window.studio || typeof window.studio.onEvent !== 'function') return;
    try {
      window.studio.onEvent((event) => {
        try {
          if (!event) return;
          if (event.type === 'setup.updated') {
            window.setupGuide.setOperation(event.operation);
            renderSetup();
            return;
          }
          if (event.type === 'github.operation') {
            window.projectPicker.operation(event.operation);
            return;
          }
          if (event.type === 'run.updated' && event.run) {
            const previousStatus = app.runs.find((run) => run.id === event.run.id)?.status;
            upsertRun(event.run);
            renderRunsList();
            if (app.selectedRunId === event.run.id) {
              renderRunDetail(event.run);
            }
            refreshWorkbenchDynamic();
            if (event.run.status === 'completed' && previousStatus !== 'completed') {
              app.completedRunId = event.run.id;
              showToast('任务已完成，成果已归档到“完成任务”。', 'success');
            }
            renderCompleted();
          } else if (event.type === 'connections' && event.connections) {
            app.connections = event.connections;
            updateConnectionSidebar();
            refreshWorkbenchDynamic();
            if (app.view === 'connections') refreshConnectionStatus();
          }
        } catch (err) {
          showError(err, '处理实时事件失败');
        }
      });
    } catch (err) {
      showError(err, '订阅运行事件失败');
    }
  }

  function updateConnectionSidebar() {
    const dot = $('sidebar-status-dot');
    const text = $('sidebar-status-text');
    if (!dot || !text) return;
    const c = app.connections;
    if (!c) {
      dot.className = 'status-dot';
      text.textContent = '正在检测连接…';
      return;
    }
    const availableCount = [
      c.codex && c.codex.available,
      c.deepseek && c.deepseek.available,
      c.ollama && c.ollama.available
    ].filter(Boolean).length;
    const configuredCount = [
      c.codex && c.codex.authenticated,
      c.deepseek && c.deepseek.configured,
      c.ollama && c.ollama.available
    ].filter(Boolean).length;
    if (availableCount > 0) {
      dot.className = 'status-dot ok';
      text.textContent = '检测到 ' + availableCount + ' 个连接服务';
    } else {
      dot.className = 'status-dot warn';
      text.textContent = configuredCount > 0 ? '部分连接已配置，待检测' : '未检测到连接服务';
    }
  }

  function renderTopbarActions() {
    const actions = $('topbar-actions');
    clear(actions);
    const refresh = button('刷新状态', 'btn ghost small');
    refresh.setAttribute('aria-label', '刷新应用状态');
    refresh.addEventListener('click', () => {
      void loadState();
    });
    actions.appendChild(refresh);
  }

  function renderSetup() {
    window.setupGuide.render(app.connections, Boolean(activeRun()), probeAction);
  }

  function updateRunningUi() {
    renderSetup();
    const active = activeRun();
    const startBtn = $('start-run');
    if (startBtn) {
      startBtn.disabled = app.starting || Boolean(active);
      startBtn.textContent = active ? '运行进行中…' : '开始运行 (Ctrl+Enter)';
    }
    const fieldset = $('settings-fieldset');
    if (fieldset) fieldset.disabled = Boolean(active);
    const saveBtn = $('settings-save');
    if (saveBtn) {
      saveBtn.disabled = Boolean(active) || app.saving;
      saveBtn.textContent = app.saving ? '保存中…' : '保存设置';
    }
    const probeBtn = $('probe-btn');
    if (probeBtn) {
      probeBtn.disabled = app.probing;
      probeBtn.textContent = app.probing ? '检测中…' : '检测连接';
    }
  }

  function init() {
    if (!window.studio) {
      showToast('未检测到预加载 API（window.studio），请通过 Electron 启动应用。', 'error');
      return;
    }
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => setView(item.dataset.view));
    });
    buildWorkbenchView();
    buildRunsView();
    buildCompletedView();
    ensureStandardsView();
    renderTopbarActions();
    setView('workbench');
    subscribeEvents();
    void loadState();
  }

  document.addEventListener('DOMContentLoaded', init);

  function buildWorkbenchView() {
    const view = $('view-workbench');
    clear(view);
    const grid = el('div', 'workbench-grid');
    const left = el('div', 'section-stack');
    const right = el('div', 'section-stack');
    grid.appendChild(left);
    grid.appendChild(right);

    const setupCard = el('section', 'card setup-card');
    setupCard.id = 'workbench-setup';
    left.appendChild(setupCard);

    const projectCard = el('section', 'card');
    const projectHeader = el('div', 'card-header');
    projectHeader.appendChild(el('h2', 'card-title', '项目'));
    projectCard.appendChild(projectHeader);
    const projectBody = el('div', 'card-body');
    projectBody.appendChild(el('div', 'field-label', '当前工作与成果目录'));
    const pathDisplay = el('div', 'path-display', '尚未选择项目');
    pathDisplay.id = 'project-path';
    const pathRow = el('div', 'start-row');
    const chooseBtn = button('打开本地项目', 'btn small');
    chooseBtn.id = 'choose-project';
    chooseBtn.setAttribute('aria-label', '选择项目目录');
    chooseBtn.addEventListener('click', () => {
      void chooseProjectAction();
    });
    const openBtn = button('打开目录', 'btn ghost small');
    openBtn.id = 'open-project';
    openBtn.disabled = true;
    openBtn.setAttribute('aria-label', '在资源管理器中打开项目目录');
    openBtn.addEventListener('click', () => {
      void openProjectPath(app.projectPath);
    });
    pathRow.appendChild(chooseBtn);
    pathRow.appendChild(openBtn);
    projectBody.appendChild(pathDisplay);
    projectBody.appendChild(el('div', 'field-hint', '成果保存在这里。已启用本机文件浏览：模型可按需查找、读取其他磁盘和目录的相关资料，无需逐个添加；修改仍限定在当前任务范围。平台会记住你的选择。'));
    projectBody.appendChild(pathRow);
    window.projectPicker.mount(projectBody, pathRow, applyProjects, showError);
    projectCard.appendChild(projectBody);
    left.appendChild(projectCard);

    const requestCard = el('section', 'card');
    const requestHeader = el('div', 'card-header');
    requestHeader.appendChild(el('h2', 'card-title', '需求描述'));
    requestCard.appendChild(requestHeader);
    const requestBody = el('div', 'card-body');
    const textarea = el('textarea', 'textarea');
    textarea.id = 'requirement-input';
    textarea.setAttribute('placeholder', '描述你希望多模型协作完成的目标，例如：为当前项目补充错误处理并添加单元测试。');
    textarea.setAttribute('aria-label', '需求描述');
    textarea.value = app.requirement;
    textarea.addEventListener('input', () => { app.requirement = textarea.value; });
    textarea.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) {
        event.preventDefault();
        void addAttachments(() => files.every((file) => file.type.startsWith('image/'))
          ? window.studio.pasteImage() : window.studio.importAttachments(files));
      }
    });
    requestBody.appendChild(textarea);
    const toolbar = el('div', 'composer-toolbar');
    const addFiles = button('＋ 添加文件', 'btn small');
    addFiles.id = 'add-attachments';
    addFiles.addEventListener('click', () => { void addAttachments(() => window.studio.chooseAttachments()); });
    const pasteImage = button('粘贴图片', 'btn ghost small');
    pasteImage.addEventListener('click', () => { void addAttachments(() => window.studio.pasteImage()); });
    const copy = button('复制需求', 'btn ghost small');
    copy.id = 'copy-requirement';
    copy.addEventListener('click', async () => {
      try { await copyText(textarea.value); showToast('需求已复制。', 'success'); }
      catch (error) { showError(error, '复制失败'); }
    });
    const paste = button('粘贴文字', 'btn ghost small');
    paste.id = 'paste-requirement';
    paste.addEventListener('click', async () => {
      try {
        const text = await window.studio.pasteText();
        textarea.focus();
        // Native insertion retains the textarea undo history.
        document.execCommand('insertText', false, text);
        app.requirement = textarea.value;
      } catch (error) { showError(error, '粘贴失败'); }
    });
    toolbar.append(addFiles, pasteImage, copy, paste);
    requestBody.appendChild(toolbar);
    requestBody.appendChild(el('div', 'field-hint', '可拖入文件，或粘贴截图。最多 8 个文件，单个 10 MB、合计 40 MB。文本直接提供给模型；图片、PDF、Office 文档供 GPT 读取。'));
    const attachmentList = el('div', 'attachment-list');
    attachmentList.id = 'attachment-list';
    attachmentList.setAttribute('aria-live', 'polite');
    requestBody.appendChild(attachmentList);
    requestCard.addEventListener('dragover', (event) => {
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        requestCard.classList.add('drop-target');
      }
    });
    requestCard.addEventListener('dragleave', (event) => {
      if (!requestCard.contains(event.relatedTarget)) requestCard.classList.remove('drop-target');
    });
    requestCard.addEventListener('drop', (event) => {
      event.preventDefault();
      requestCard.classList.remove('drop-target');
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void addAttachments(() => window.studio.importAttachments(files));
    });
    const chips = el('div', 'example-chips');
    chips.setAttribute('aria-label', '示例需求，点击填入');
    REQUIREMENT_EXAMPLES.forEach((example) => {
      const chip = el('button', 'chip', example);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        textarea.value = example;
        app.requirement = example;
        textarea.focus();
      });
      chips.appendChild(chip);
    });
    requestBody.appendChild(chips);
    const startRow = el('div', 'start-row');
    const startBtn = button('开始运行 (Ctrl+Enter)', 'btn primary');
    startBtn.id = 'start-run';
    startBtn.addEventListener('click', () => {
      void startAction();
    });
    startRow.appendChild(startBtn);
    startRow.appendChild(el('span', 'field-hint', '启动后可在执行记录中查看任务、日志、检查、审查与变更。'));
    requestBody.appendChild(startRow);
    requestCard.appendChild(requestBody);
    left.appendChild(requestCard);

    const activeCard = el('section', 'card active-run-card');
    const activeHeader = el('div', 'card-header');
    activeHeader.appendChild(el('h2', 'card-title', '当前运行'));
    activeCard.appendChild(activeHeader);
    const activeBody = el('div', 'card-body');
    activeBody.id = 'active-run-body';
    activeCard.appendChild(activeBody);
    right.appendChild(activeCard);

    const connCard = el('section', 'card');
    const connHeader = el('div', 'card-header');
    connHeader.appendChild(el('h2', 'card-title', '模型连接'));
    connCard.appendChild(connHeader);
    const connBody = el('div', 'card-body connection-summary');
    connBody.id = 'workbench-connections';
    connCard.appendChild(connBody);
    right.appendChild(connCard);

    const explainCard = el('section', 'card');
    const explainHeader = el('div', 'card-header');
    explainHeader.appendChild(el('h2', 'card-title', 'GPT 计划与审查'));
    explainCard.appendChild(explainHeader);
    const explainBody = el('div', 'card-body');
    const list = el('ul', 'explain-list');
    [
      'GPT 始终负责制定计划并执行最终审查。',
      'DeepSeek 与 Ollama Qwen 作为执行 worker，按计划顺序工作。',
      '只有 GPT 审查通过且检查通过，运行才会标记为已完成。',
      '连接可用不代表推理已验证；以实际运行结果为准。'
    ].forEach((text) => {
      list.appendChild(el('li', '', text));
    });
    explainBody.appendChild(list);
    explainCard.appendChild(explainBody);
    right.appendChild(explainCard);

    view.appendChild(grid);
    renderAttachments();
  }

  async function addAttachments(importer) {
    if (app.importing || app.starting) return;
    app.importing = true;
    renderAttachments();
    try {
      const items = await importer();
      if (app.attachments.length + items.length > 8 || [...app.attachments, ...items].reduce((sum, item) => sum + item.size, 0) > 40 * 1024 * 1024) {
        throw new Error('附件最多 8 个，合计不能超过 40 MB。请先移除部分附件。');
      }
      app.attachments.push(...items);
      if (items.length) showToast('已添加 ' + items.length + ' 个附件。', 'success');
    } catch (error) { showError(error, '添加附件失败'); }
    finally { app.importing = false; renderAttachments(); }
  }

  function renderAttachments() {
    const list = $('attachment-list');
    if (!list) return;
    clear(list);
    for (const item of app.attachments) {
      const row = el('div', 'attachment-item');
      row.appendChild(el('span', 'attachment-name', item.name + ' · ' + Math.max(1, Math.ceil(item.size / 1024)) + ' KB'));
      const remove = button('移除', 'btn ghost small');
      remove.setAttribute('aria-label', '移除附件 ' + item.name);
      remove.disabled = app.importing || app.starting;
      remove.addEventListener('click', () => { app.attachments = app.attachments.filter((file) => file.id !== item.id); renderAttachments(); });
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (app.importing) list.appendChild(el('div', 'field-hint', '正在读取附件…'));
    const add = $('add-attachments');
    if (add) add.disabled = app.importing || app.starting;
  }

  function refreshWorkbenchDynamic() {
    const view = $('view-workbench');
    if (!view || !view.hasChildNodes()) return;
    const pathDisplay = $('project-path');
    if (pathDisplay) {
      pathDisplay.textContent = app.projectPath || '尚未选择项目';
      pathDisplay.title = app.projectPath || '';
    }
    const openBtn = $('open-project');
    if (openBtn) openBtn.disabled = !app.projectPath;
    renderWorkbenchConnections();
    renderActiveRunCard();
    updateRunningUi();
  }

  function renderWorkbenchConnections() {
    const container = $('workbench-connections');
    if (!container) return;
    clear(container);
    const c = app.connections;
    if (!c) {
      container.appendChild(el('div', 'muted small', '尚未检测连接，请到模型连接页点击“检测连接”。'));
      return;
    }
    container.appendChild(connectionSummaryRow('GPT / Codex', codexSummaryBadges(c.codex)));
    container.appendChild(connectionSummaryRow('DeepSeek', deepseekSummaryBadges(c.deepseek)));
    container.appendChild(connectionSummaryRow('Ollama Qwen', ollamaSummaryBadges(c.ollama)));
  }

  function connectionSummaryRow(name, badges) {
    const row = el('div', 'conn-row');
    row.appendChild(el('span', 'conn-name', name));
    const meta = el('div', 'conn-meta');
    badges.forEach((item) => meta.appendChild(item));
    row.appendChild(meta);
    return row;
  }

  function codexSummaryBadges(codex) {
    const result = [];
    if (codex) {
      result.push(badge(codex.available ? '已检测' : '未检测', codex.available ? 'badge-ok' : 'badge-err'));
      result.push(badge(codex.authenticated ? '已认证' : '未认证', codex.authenticated ? 'badge-ok' : 'badge-warn'));
    } else {
      result.push(badge('未检测', 'badge-err'));
    }
    return result;
  }

  function deepseekSummaryBadges(deepseek) {
    const result = [];
    if (deepseek) {
      result.push(badge(deepseek.available ? '可执行' : '未检测', deepseek.available ? 'badge-ok' : 'badge-err'));
      result.push(badge(deepseek.configured ? '已配置' : '未配置', deepseek.configured ? 'badge-ok' : 'badge-warn'));
    } else {
      result.push(badge('未检测', 'badge-err'));
    }
    return result;
  }

  function ollamaSummaryBadges(ollama) {
    const result = [];
    if (ollama) {
      result.push(badge(ollama.available ? '服务可达' : '不可达', ollama.available ? 'badge-ok' : 'badge-err'));
      const modelCount = Array.isArray(ollama.models) ? ollama.models.length : 0;
      result.push(badge(modelCount + ' 个模型', modelCount > 0 ? 'badge' : 'badge-warn'));
    } else {
      result.push(badge('未检测', 'badge-err'));
    }
    return result;
  }

  function renderActiveRunCard() {
    const container = $('active-run-body');
    if (!container) return;
    clear(container);
    const run = activeRun();
    if (!run) {
      container.appendChild(el('div', 'muted small', '当前没有正在运行的协作任务。'));
      const latest = window.runProgress.finished(app.runs)[0];
      if (latest) {
        container.appendChild(el('div', 'delivery-preview', '最近完成：' + latest.title));
        const result = button('查看完成成果 →', 'btn accent small');
        result.addEventListener('click', () => { app.completedRunId = latest.id; setView('completed'); });
        container.appendChild(result);
      }
      return;
    }
    const head = el('div', 'active-run-head');
    head.appendChild(el('div', 'run-list-title', run.title || run.id));
    head.appendChild(statusBadge(run.status));
    container.appendChild(head);
    const meta = el('div', 'muted small');
    meta.appendChild(el('span', '', '阶段：' + phaseLabel(run.phase)));
    meta.appendChild(el('span', 'faint', ' · 更新于 ' + formatShortTime(run.updatedAt || run.createdAt)));
    container.appendChild(meta);
    const full = app.runDetails.get(run.id);
    if (full) container.appendChild(renderFlow(full, true));
    const actions = el('div', 'start-row');
    actions.appendChild(createCancelButton(run));
    const viewBtn = button('查看详情', 'btn small');
    viewBtn.addEventListener('click', () => {
      app.selectedRunId = run.id;
      app.runTab = 'progress';
      setView('runs');
      renderRunsList();
      void selectRun(run.id);
    });
    actions.appendChild(viewBtn);
    container.appendChild(actions);
  }

  async function chooseProjectAction() {
    try {
      const projects = await window.studio.chooseProject();
      if (projects) {
        applyProjects(projects);
        showToast('已选择项目：' + projects.selectedPath, 'success');
      }
    } catch (err) {
      showError(err, '选择项目失败');
    }
  }

  function applyProjects(projects) {
    if (!projects || (app.projects && projects.revision < app.projects.revision)) return;
    app.projects = projects;
    app.projectPath = projects.selectedPath || '';
    window.projectPicker.state(projects);
    refreshWorkbenchDynamic();
  }

  async function openProjectPath(path) {
    if (!path) return;
    try {
      await window.studio.openProject(path);
    } catch (err) {
      showError(err, '打开项目失败');
    }
  }

  async function startAction() {
    if (app.starting) return;
    if (app.importing) { showToast('请等待附件读取完成。', 'info'); return; }
    const run = activeRun();
    if (run) {
      showToast('已有正在运行的协作任务，请先取消或等待完成。', 'info');
      return;
    }
    const textarea = $('requirement-input');
    const request = textarea ? textarea.value.trim() : '';
    if (!app.projectPath) {
      showToast('请先选择项目目录。', 'error');
      return;
    }
    if (!request) {
      showToast('请填写需求描述。', 'error');
      return;
    }
    app.starting = true;
    app.requirement = request;
    updateRunningUi();
    try {
      const started = await window.studio.startRun({ projectPath: app.projectPath, request: request, attachmentIds: app.attachments.map((item) => item.id) });
      if (started) {
        upsertRun(started);
        app.activeRunId = started.id;
        app.selectedRunId = started.id;
        app.runTab = 'progress';
        renderRunsList();
        refreshWorkbenchDynamic();
        showToast('运行已启动：' + (started.title || started.id), 'success');
      }
    } catch (err) {
      showError(err, '启动运行失败');
    } finally {
      app.starting = false;
      updateRunningUi();
      refreshWorkbenchDynamic();
    }
  }

  function buildRunsView() {
    const view = $('view-runs');
    clear(view);
    const layout = el('div', 'runs-layout');
    const listCard = el('section', 'card runs-list-panel');
    const listHeader = el('div', 'card-header');
    listHeader.appendChild(el('h2', 'card-title', '运行列表'));
    listCard.appendChild(listHeader);
    const list = el('div', 'runs-list');
    list.id = 'runs-list';
    listCard.appendChild(list);
    layout.appendChild(listCard);

    const detailCard = el('section', 'card run-detail-panel');
    detailCard.id = 'run-detail-panel';
    const detail = el('div', 'run-detail');
    detail.id = 'run-detail';
    detail.appendChild(emptyState('选择一条运行记录', '从左侧列表选择运行以查看详情。'));
    detailCard.appendChild(detail);
    layout.appendChild(detailCard);

    view.appendChild(layout);
  }

  function buildCompletedView() {
    const view = $('view-completed');
    const hero = el('div', 'delivery-hero');
    hero.appendChild(el('div', 'delivery-symbol', '✓'));
    const heading = el('div', '');
    heading.appendChild(el('h3', '', '你的完成成果'));
    const count = el('p', 'muted');
    count.id = 'delivery-summary';
    heading.appendChild(count);
    hero.appendChild(heading);
    view.appendChild(hero);
    const search = el('input', 'input completed-search');
    search.id = 'completed-search';
    search.type = 'search';
    search.placeholder = '搜索任务名称或项目目录';
    search.setAttribute('aria-label', '搜索完成任务');
    search.addEventListener('input', renderCompleted);
    view.appendChild(search);
    const layout = el('div', 'delivery-layout');
    const list = el('div', 'delivery-list');
    list.id = 'completed-list';
    const detail = el('section', 'card delivery-detail');
    detail.id = 'completed-detail';
    layout.append(list, detail);
    view.appendChild(layout);
  }

  function renderCompleted() {
    const all = window.runProgress.finished(app.runs);
    $('completed-count').textContent = all.length;
    $('delivery-summary').textContent = all.length + ' 项任务已通过 GPT 最终验收 · 文件保存在各自项目目录';
    if (app.view !== 'completed') return;
    const runs = window.runProgress.finished(app.runs, $('completed-search').value);
    const list = clear($('completed-list'));
    const detail = clear($('completed-detail'));
    if (!runs.length) {
      detail.appendChild(emptyState(all.length ? '没有匹配的任务' : '还没有完成成果', all.length ? '尝试其他关键词。' : '任务通过 GPT 审查和验收后，会自动显示在此页。执行中的进展可在“执行记录 → 过程”查看。'));
      return;
    }
    if (!runs.some((run) => run.id === app.completedRunId)) app.completedRunId = runs[0].id;
    for (const run of runs) {
      const item = button('', 'delivery-item' + (run.id === app.completedRunId ? ' selected' : ''));
      item.appendChild(el('div', 'delivery-item-title', '✓ ' + run.title));
      item.appendChild(el('div', 'muted small', formatShortTime(run.completedAt || run.updatedAt)));
      item.appendChild(el('div', 'delivery-item-path', run.projectPath));
      item.addEventListener('click', () => { app.completedRunId = run.id; app.completedError = ''; renderCompleted(); });
      list.appendChild(item);
    }
    const run = app.runDetails.get(app.completedRunId);
    if (!run) {
      if (app.completedError) { detail.appendChild(errorBanner(app.completedError)); return; }
      detail.appendChild(el('div', 'card-body muted', '正在读取成果…'));
      if (app.completedLoading !== app.completedRunId) {
        const id = app.completedRunId;
        app.completedLoading = id;
        window.studio.getRun(id).then(upsertRun).catch((error) => {
          if (app.completedRunId === id) app.completedError = errorMessage(error, '读取成果失败');
        }).finally(() => {
          if (app.completedLoading === id) app.completedLoading = null;
          if (app.completedRunId === id) renderCompleted();
        });
      }
      return;
    }
    const body = el('div', 'card-body');
    body.appendChild(el('div', 'delivery-kicker', 'GPT 已审查通过 · 成果可查看'));
    body.appendChild(el('h3', 'delivery-title', run.title));
    body.appendChild(el('div', 'muted small', '完成于 ' + formatTime(run.completedAt || run.updatedAt) + (run.completedAt ? '' : '（旧记录按最后更新时间显示）')));
    body.appendChild(el('div', 'delivery-location', '成果目录：' + run.projectPath));
    const actions = el('div', 'start-row');
    const open = createOpenRunProjectButton(run.projectPath);
    open.textContent = '打开成果目录';
    open.className = 'btn primary small';
    const process = button('查看完整过程', 'btn accent small');
    process.addEventListener('click', () => { setView('runs'); void selectRun(run.id); });
    actions.append(open, process, createExportButton(run));
    body.appendChild(actions);
    body.appendChild(el('h4', 'tab-section-title', '交付结论'));
    body.appendChild(el('div', 'task-text delivery-conclusion', run.review?.summary || '已完成，未保存审查摘要。'));
    body.appendChild(renderFlow(run));
    body.appendChild(renderMetrics(run));
    const files = el('div', 'panel-block');
    files.appendChild(el('h4', 'tab-section-title', '成果文件 · ' + (run.changes || []).length + ' 项变更'));
    const fileNames = el('div', 'delivery-files');
    const statusText = { added: '新增', modified: '修改', deleted: '删除' };
    for (const file of run.changes || []) fileNames.appendChild(el('div', 'delivery-file', (statusText[file.status] || file.status) + ' · ' + file.path));
    if (!fileNames.hasChildNodes()) fileNames.appendChild(el('div', 'muted small', '本次未记录文件变更，成果可能为分析或审查结论。'));
    files.appendChild(fileNames);
    const changes = button('查看代码变更', 'btn ghost small');
    changes.addEventListener('click', async () => { setView('runs'); await selectRun(run.id); if (app.selectedRunId === run.id) setRunTab(run.id, 'diff'); });
    files.appendChild(changes);
    body.appendChild(files);
    detail.appendChild(body);
  }

  function renderFlow(run, compact = false) {
    const flow = el('ol', 'process-flow' + (compact ? ' compact' : ''));
    flow.setAttribute('aria-label', '协作阶段进展');
    for (const [index, stage] of window.runProgress.describe(run).stages.entries()) {
      const node = el('li', 'process-node process-' + stage.state);
      const marker = stage.state === 'done' ? '✓' : stage.state === 'attention' ? '!' : String(index + 1);
      node.appendChild(el('span', 'process-marker', marker));
      node.appendChild(el('strong', '', stage.label));
      const status = { done: '已完成', current: '进行中', pending: '待进行', attention: '未完成' };
      node.appendChild(el('span', 'process-state', status[stage.state]));
      if (!compact) node.appendChild(el('span', 'process-note', stage.note));
      if (stage.state === 'current') node.setAttribute('aria-current', 'step');
      flow.appendChild(node);
    }
    return flow;
  }

  function renderMetrics(run) {
    const data = window.runProgress.describe(run);
    const metrics = el('div', 'process-metrics');
    const entries = [
      [data.doneTasks + ' / ' + data.tasks.length, '分工任务完成'],
      [data.expectedChecks ? data.passedChecks + ' / ' + data.expectedChecks : '手工审查', data.expectedChecks ? '自动检查通过' : '未配置自动检查'],
      [String(run.round || 0), 'GPT 审查轮次'],
      [String((run.changes || []).length), '变更文件'],
    ];
    for (const [value, label] of entries) {
      const metric = el('div', 'process-metric');
      metric.append(el('strong', '', value), el('span', 'muted small', label));
      metrics.appendChild(metric);
    }
    return metrics;
  }

  function renderProgress(run) {
    const wrap = el('div', 'process-panel');
    wrap.appendChild(el('h3', 'tab-section-title', run.phase || '协作过程'));
    if (run.error) wrap.appendChild(errorBanner(run.error));
    wrap.appendChild(renderFlow(run));
    wrap.appendChild(renderMetrics(run));
    if (run.modelCalls?.length) {
      const timings = el('div', 'panel-block model-timings');
      timings.appendChild(el('h3', 'tab-section-title', '模型调用耗时'));
      for (const call of run.modelCalls) {
        const seconds = call.durationMs == null ? '进行中' : (call.durationMs / 1000).toFixed(1) + ' 秒';
        const state = { completed: '已返回', failed: '失败', cancelled: '已停止', running: '进行中' };
        const row = el('div', 'model-timing-row');
        row.appendChild(el('div', '', (call.provider === 'gpt' ? 'GPT' : call.provider === 'qwen' ? 'Qwen' : 'DeepSeek') + ' · ' + call.phase + ' · ' + seconds + ' · ' + (state[call.status] || call.status)));
        if (call.performance) {
          const perf = call.performance;
          row.appendChild(el('div', 'muted small', '上下文 ' + (perf.contextTokens / 1024) + 'K · 思考' + (perf.thinking ? '开启' : '关闭') + ' · 加载 ' + (perf.loadMs / 1000).toFixed(1) + ' 秒 · 输入处理 ' + (perf.promptMs / 1000).toFixed(1) + ' 秒 · 生成 ' + (perf.generationMs / 1000).toFixed(1) + ' 秒'));
        }
        timings.appendChild(row);
      }
      wrap.appendChild(timings);
    }
    if (run.status === 'completed') {
      const result = button('查看完成成果 →', 'btn primary small');
      result.addEventListener('click', () => { app.completedRunId = run.id; setView('completed'); });
      wrap.appendChild(result);
    }
    const workers = el('div', 'panel-block');
    workers.appendChild(el('h3', 'tab-section-title', '模型分工与交接'));
    for (const task of run.tasks || []) {
      const item = el('details', 'process-task');
      item.dataset.processKey = 'task-' + task.id;
      const head = el('summary', '');
      head.append(providerBadge(task.provider), el('strong', '', task.title), taskStatusBadge(task.status));
      item.appendChild(head);
      const body = el('div', 'process-task-body');
      if (task.startedAt) body.appendChild(el('div', 'muted small', '开始 ' + formatTime(task.startedAt) + (task.finishedAt ? ' · 结束 ' + formatTime(task.finishedAt) : '')));
      body.appendChild(el('div', 'muted small', '依赖：' + ((task.dependencies || []).join('、') || '无') + ' · 范围：' + (task.allowedPaths || []).join('、')));
      body.appendChild(el('div', 'task-text', task.result || task.instructions));
      item.appendChild(body);
      workers.appendChild(item);
    }
    if (!(run.tasks || []).length) workers.appendChild(el('div', 'muted small', 'GPT 规划后，模型任务会显示在这里。'));
    wrap.appendChild(workers);
    const timeline = el('div', 'panel-block');
    timeline.appendChild(el('h3', 'tab-section-title', '执行时间线'));
    const phases = run.phaseHistory || [];
    if (!phases.length) timeline.appendChild(el('div', 'muted small', '此旧记录没有保存阶段时间线，可查看分工结果、最终检查和日志。'));
    for (const phase of phases) {
      const line = el('div', 'process-event');
      line.appendChild(el('time', 'muted small', formatTime(phase.time, true)));
      line.appendChild(el('span', '', phase.phase));
      timeline.appendChild(line);
    }
    wrap.appendChild(timeline);
    if (run.reviewHistory?.length) {
      const reviews = el('div', 'panel-block');
      reviews.appendChild(el('h3', 'tab-section-title', '审查与修复记录'));
      for (const round of run.reviewHistory) {
        const item = el('details', 'process-task');
        item.dataset.processKey = 'review-' + round.round;
        const head = el('summary', '');
        const passed = round.review.approved && !round.review.repairTasks?.length && !(round.review.findings || []).some((finding) => ['critical', 'major'].includes(finding.severity)) && round.checks.every((check) => check.code === 0);
        head.append(el('strong', '', 'GPT 第 ' + round.round + ' 轮'), badge(passed ? '通过' : '继续处理', passed ? 'badge-ok' : 'badge-warn'), el('span', 'muted small', formatShortTime(round.time)));
        const body = el('div', 'process-task-body task-text', round.review.summary);
        for (const finding of round.review.findings || []) body.appendChild(renderFindingCard(finding));
        for (const check of round.checks) body.appendChild(el('div', 'muted small', check.command + ' ' + check.args.join(' ') + ' → ' + (check.code === 0 ? '通过' : '失败')));
        item.append(head, body);
        reviews.appendChild(item);
      }
      wrap.appendChild(reviews);
    }
    return wrap;
  }

  function renderRunsList() {
    const list = $('runs-list');
    if (!list) return;
    clear(list);
    if (!app.runs.length) {
      list.appendChild(emptyState('暂无执行记录', '启动任务后，运行记录会显示在这里。'));
      return;
    }
    app.runs.forEach((run) => {
      list.appendChild(createRunListItem(run));
    });
  }

  function createRunListItem(run) {
    const item = el('button', 'run-list-item');
    item.type = 'button';
    if (app.selectedRunId === run.id) item.classList.add('selected');
    item.setAttribute('aria-label', '查看运行：' + (run.title || run.id));
    item.appendChild(el('div', 'run-list-title', run.title || run.id));
    const meta = el('div', 'run-list-meta');
    meta.appendChild(statusBadge(run.status));
    meta.appendChild(el('span', 'faint small', formatShortTime(run.updatedAt || run.createdAt)));
    item.appendChild(meta);
    item.addEventListener('click', () => {
      void selectRun(run.id);
    });
    return item;
  }

  async function selectRun(id) {
    app.selectedRunId = id;
    app.runTab = 'progress';
    renderRunsList();
    const summary = app.runs.find((run) => run.id === id);
    renderRunDetailLoading(summary);
    try {
      const full = await window.studio.getRun(id);
      if (full) {
        upsertRun(full);
        if (app.selectedRunId === id) renderRunDetail(full);
      }
    } catch (err) {
      const message = errorMessage(err, '读取执行详情失败');
      showError(err, '读取执行详情失败');
      if (app.selectedRunId === id) {
        renderRunDetailError(summary, message);
      }
    }
  }

  function renderRunDetailError(summary, message) {
    const detail = $('run-detail');
    if (!detail) return;
    clear(detail);
    if (summary) detail.appendChild(createRunDetailHeader(summary));
    const body = el('div', 'tab-body');
    body.appendChild(errorBanner(message));
    detail.appendChild(body);
  }

  function renderRunDetailLoading(summary) {
    const detail = $('run-detail');
    if (!detail) return;
    clear(detail);
    if (!summary) {
      detail.appendChild(emptyState('选择一条运行记录', '从左侧列表选择运行以查看详情。'));
      return;
    }
    detail.appendChild(createRunDetailHeader(summary));
    detail.appendChild(el('div', 'tab-body', '正在加载详情…'));
  }

  function renderRunDetail(run) {
    const detail = $('run-detail');
    if (!detail) return;
    const sameRun = detail.dataset.runId === run?.id;
    const opened = sameRun ? Array.from(detail.querySelectorAll('details[open][data-process-key]'), (item) => item.dataset.processKey) : [];
    const previousBody = detail.querySelector('.tab-body');
    const scroll = sameRun && previousBody ? previousBody.scrollTop : 0;
    clear(detail);
    if (!run) {
      detail.appendChild(emptyState('选择一条运行记录', '从左侧列表选择运行以查看详情。'));
      return;
    }
    detail.appendChild(createRunDetailHeader(run));
    detail.appendChild(createRunTabbar(run));
    const body = el('div', 'tab-body');
    body.appendChild(renderRunTab(run, app.runTab));
    detail.appendChild(body);
    detail.dataset.runId = run.id;
    for (const item of body.querySelectorAll('details[data-process-key]')) item.open = opened.includes(item.dataset.processKey);
    body.scrollTop = scroll;
  }

  function createRunDetailHeader(run) {
    const header = el('div', 'run-detail-header');
    const info = el('div', '');
    const titleRow = el('div', 'run-detail-heading');
    titleRow.appendChild(el('h3', 'run-detail-title', run.title || run.id));
    titleRow.appendChild(statusBadge(run.status));
    info.appendChild(titleRow);
    const sub = el('p', 'run-detail-sub');
    const parts = [];
    if (run.projectPath) parts.push(run.projectPath);
    if (run.phase) parts.push('阶段：' + phaseLabel(run.phase));
    parts.push('创建：' + formatTime(run.createdAt));
    parts.push('更新：' + formatTime(run.updatedAt));
    sub.textContent = parts.join('  ·  ');
    sub.title = run.projectPath || '';
    info.appendChild(sub);
    header.appendChild(info);
    const actions = el('div', 'run-detail-actions');
    if (isActiveRun(run)) actions.appendChild(createCancelButton(run));
    if (isRetryableRun(run)) actions.appendChild(createRetryButton(run));
    actions.appendChild(createCopyLogButton(run));
    const copyPanel = button('复制当前内容', 'btn small');
    copyPanel.addEventListener('click', async () => {
      try { await copyText($('run-detail').querySelector('.tab-body').innerText); showToast('当前内容已复制。', 'success'); }
      catch (error) { showError(error, '复制失败'); }
    });
    actions.appendChild(copyPanel);
    actions.appendChild(createExportButton(run));
    if (run.projectPath) actions.appendChild(createOpenRunProjectButton(run.projectPath));
    header.appendChild(actions);
    return header;
  }

  function createRunTabbar(run) {
    const bar = el('div', 'tabbar');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '运行详情分类');
    const tabs = [
      { id: 'progress', label: '过程' },
      { id: 'tasks', label: '任务' },
      { id: 'logs', label: '日志' },
      { id: 'checks', label: '检查' },
      { id: 'review', label: '审查' },
      { id: 'diff', label: '变更' }
    ];
    tabs.forEach((tab) => {
      const item = el('button', 'tab', tab.label);
      item.type = 'button';
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', app.runTab === tab.id ? 'true' : 'false');
      if (app.runTab === tab.id) item.classList.add('active');
      item.addEventListener('click', () => {
        setRunTab(run.id, tab.id);
      });
      bar.appendChild(item);
    });
    return bar;
  }

  function setRunTab(id, tab) {
    app.runTab = tab;
    const run = currentRun();
    if (run) renderRunDetail(run);
  }

  function createCancelButton(run) {
    const btn = button('停止执行', 'btn danger small');
    btn.setAttribute('aria-label', '停止当前执行并保留已有修改');
    btn.addEventListener('click', () => { btn.disabled = true; void cancelRunAction(run.id); });
    return btn;
  }

  function createRetryButton(run) {
    const btn = button('重新运行', 'btn accent small');
    btn.setAttribute('aria-label', '重新运行此任务');
    btn.addEventListener('click', () => {
      void retryRunAction(run.id);
    });
    return btn;
  }

  function createCopyLogButton(run) {
    const btn = button('复制日志', 'btn small');
    btn.setAttribute('aria-label', '复制当前运行的日志');
    btn.addEventListener('click', () => {
      void copyLogAction(run);
    });
    return btn;
  }

  function createExportButton(run) {
    const btn = button('导出报告', 'btn small');
    btn.setAttribute('aria-label', '导出当前运行的报告');
    btn.addEventListener('click', () => {
      void exportRunAction(run.id);
    });
    return btn;
  }

  function createOpenRunProjectButton(path) {
    const btn = button('打开目录', 'btn ghost small');
    btn.setAttribute('aria-label', '打开运行对应的项目目录');
    btn.addEventListener('click', () => {
      void openProjectPath(path);
    });
    return btn;
  }

  async function cancelRunAction(id) {
    try {
      await window.studio.cancelRun(id);
      showToast('已请求取消运行。', 'success');
      void loadState();
    } catch (err) {
      showError(err, '取消运行失败');
    }
  }

  async function retryRunAction(id) {
    try {
      const run = await window.studio.retryRun(id);
      if (run) {
        upsertRun(run);
        app.activeRunId = run.id;
        app.selectedRunId = run.id;
        app.runTab = 'tasks';
        renderRunsList();
        renderRunDetail(run);
        refreshWorkbenchDynamic();
        showToast('已重新启动运行。', 'success');
      }
    } catch (err) {
      showError(err, '重新运行失败');
    }
  }

  async function exportRunAction(id) {
    try {
      const result = await window.studio.exportRun(id);
      if (result && result.path) {
        showToast('报告已导出：' + result.path, 'success');
      } else {
        showToast('报告未导出。', 'info');
      }
    } catch (err) {
      showError(err, '导出报告失败');
    }
  }

  async function copyLogAction(run) {
    const events = Array.isArray(run.events) ? run.events : [];
    if (!events.length) {
      showToast('当前运行暂无日志。', 'info');
      return;
    }
    const text = events.map((event) => {
      return formatTime(event.time, true) + ' [' + (event.provider || '-') + '] ' + (event.type || '') + ' ' + (event.message || '');
    }).join('\n');
    try {
      await copyText(text);
      showToast('日志已复制到剪贴板。', 'success');
    } catch (err) {
      showError(err, '复制日志失败');
    }
  }

  async function copyText(text) {
    if (window.studio.copyText) return window.studio.copyText(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (err) {
        // 继续使用降级复制方案。
      }
    }
    const helper = el('textarea', 'copy-helper');
    helper.value = text;
    helper.setAttribute('readonly', '');
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    if (!ok) throw new Error('剪贴板不可用');
  }

  function renderRunTab(run, tab) {
    if (tab === 'progress') return renderProgress(run);
    if (tab === 'tasks') return renderTasksTab(run);
    if (tab === 'logs') return renderLogsTab(run);
    if (tab === 'checks') return renderChecksTab(run);
    if (tab === 'review') return renderReviewTab(run);
    if (tab === 'diff') return renderDiffTab(run);
    return emptyState('未知分类', '无法识别该详情分类。');
  }

  function renderTasksTab(run) {
    const wrap = el('div', '');
    if (run.attachments?.length) {
      const attached = el('div', 'panel-block');
      attached.appendChild(el('h3', 'tab-section-title', '参考附件'));
      for (const item of run.attachments) attached.appendChild(el('div', 'task-text', item.name + ' · ' + Math.max(1, Math.ceil(item.size / 1024)) + ' KB'));
      wrap.appendChild(attached);
    }
    if (run.request) {
      const requestBlock = el('div', 'panel-block');
      requestBlock.appendChild(el('h3', 'tab-section-title', '用户需求'));
      const requestBox = el('div', 'plan-summary');
      requestBox.appendChild(el('div', 'task-text', run.request));
      requestBlock.appendChild(requestBox);
      wrap.appendChild(requestBlock);
    }
    const plan = run.plan;
    if (plan) wrap.appendChild(renderPlanBlock(plan));
    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    if (tasks.length) {
      const block = el('div', 'panel-block');
      block.appendChild(el('h3', 'tab-section-title', '任务分解'));
      tasks.forEach((task) => block.appendChild(renderTaskCard(task)));
      wrap.appendChild(block);
    } else if (!plan) {
      wrap.appendChild(emptyState('暂无任务', '计划生成后将在这里显示任务分解。'));
    }
    return wrap;
  }

  function renderPlanBlock(plan) {
    const block = el('div', 'panel-block');
    block.appendChild(el('h3', 'tab-section-title', '执行计划 · ' + (plan.title || '未命名')));
    const summary = el('div', 'plan-summary');
    if (plan.summary) summary.appendChild(el('div', 'task-text', displayValue(plan.summary)));
    summary.appendChild(el('div', 'task-section-label', '成果保存位置'));
    summary.appendChild(el('div', 'task-text', plan.projectPath || '见运行目录'));
    if (Array.isArray(plan.referencePaths) && plan.referencePaths.length) {
      summary.appendChild(el('div', 'task-section-label', '已定位的参考文件 / 目录（只读）'));
      plan.referencePaths.forEach((item) => summary.appendChild(el('div', 'task-text', displayValue(item))));
    }
    const acceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
    if (acceptance.length) {
      summary.appendChild(el('div', 'task-section-label', '总体验收标准'));
      acceptance.forEach((item) => summary.appendChild(el('div', 'task-text', '• ' + displayValue(item))));
    }
    block.appendChild(summary);
    return block;
  }

  function renderTaskCard(task) {
    const card = el('div', 'task-card');
    const head = el('div', 'task-head');
    head.appendChild(el('span', 'task-title', task.title || task.id || '未命名任务'));
    head.appendChild(providerBadge(task.provider));
    head.appendChild(taskStatusBadge(task.status));
    card.appendChild(head);
    if (Array.isArray(task.allowedPaths) && task.allowedPaths.length) {
      card.appendChild(el('div', 'task-section-label', '允许修改的路径（读取不受此列表限制）'));
      card.appendChild(el('div', 'task-text', task.allowedPaths.map(displayValue).join('、')));
    }
    if (Array.isArray(task.dependencies) && task.dependencies.length) {
      card.appendChild(el('div', 'task-section-label', '依赖任务'));
      card.appendChild(el('div', 'task-text', task.dependencies.map(displayValue).join('、')));
    }
    if (Array.isArray(task.acceptance) && task.acceptance.length) {
      card.appendChild(el('div', 'task-section-label', '验收标准'));
      task.acceptance.forEach((item) => card.appendChild(el('div', 'task-text', '• ' + displayValue(item))));
    }
    if (task.result) {
      card.appendChild(el('div', 'task-section-label', '执行结果'));
      card.appendChild(el('div', 'task-text', displayValue(task.result)));
    }
    return card;
  }

  function renderLogsTab(run) {
    const wrap = el('div', '');
    const usageBlock = renderUsageBlock(run.usage);
    if (usageBlock) wrap.appendChild(usageBlock);
    const block = el('div', 'panel-block');
    block.appendChild(el('h3', 'tab-section-title', '事件日志'));
    const events = Array.isArray(run.events) ? run.events : [];
    if (events.length) {
      const list = el('div', 'event-list');
      events.forEach((event) => list.appendChild(renderEventRow(event)));
      block.appendChild(list);
    } else {
      block.appendChild(emptyState('暂无日志', '运行开始后事件会显示在这里。'));
    }
    wrap.appendChild(block);
    return wrap;
  }

  function renderEventRow(event) {
    const row = el('div', 'event-row');
    row.appendChild(el('span', 'event-time', formatTime(event.time, true)));
    row.appendChild(el('span', 'event-provider', event.provider || '-'));
    row.appendChild(el('span', 'event-message', (event.type ? '[' + event.type + '] ' : '') + displayValue(event.message)));
    return row;
  }

  function renderUsageBlock(usage) {
    const models = [
      { key: 'gpt', name: 'GPT' },
      { key: 'deepseek', name: 'DeepSeek' },
      { key: 'qwen', name: 'Qwen (Ollama)' }
    ];
    const cards = [];
    models.forEach((model) => {
      const data = usage && usage[model.key];
      if (!data) return;
      const hasValue = (Number(data.inputTokens) || 0) + (Number(data.outputTokens) || 0) + (Number(data.cachedTokens) || 0) > 0;
      if (!hasValue) return;
      cards.push(renderUsageCard(model.name, data));
    });
    if (!cards.length) return null;
    const block = el('div', 'panel-block');
    block.appendChild(el('h3', 'tab-section-title', 'Token 用量（缓存计入输入，不重复累加）'));
    const grid = el('div', 'usage-grid');
    cards.forEach((card) => grid.appendChild(card));
    block.appendChild(grid);
    return block;
  }

  function renderUsageCard(name, data) {
    const card = el('div', 'usage-card');
    card.appendChild(el('div', 'usage-title', name));
    card.appendChild(usageLine('输入 tokens', data.inputTokens, data.cachedTokens));
    card.appendChild(usageLine('输出 tokens', data.outputTokens, 0));
    return card;
  }

  function usageLine(label, value, cached) {
    const line = el('div', 'usage-line');
    line.appendChild(el('span', '', label));
    const right = el('span', 'usage-values');
    right.appendChild(el('strong', '', formatNumber(value)));
    if (cached && Number(cached) > 0) {
      right.appendChild(el('span', 'muted small', '含缓存 ' + formatNumber(cached)));
    }
    line.appendChild(right);
    return line;
  }

  function renderChecksTab(run) {
    const wrap = el('div', '');
    const checks = Array.isArray(run.checks) ? run.checks : [];
    if (!checks.length) {
      wrap.appendChild(emptyState('暂无检查', '检查命令将在任务完成后运行。'));
      return wrap;
    }
    checks.forEach((check) => wrap.appendChild(renderCheckCard(check)));
    return wrap;
  }

  function renderCheckCard(check) {
    const card = el('div', 'check-card');
    const head = el('div', 'task-head');
    const label = check.code === 0 ? '通过' : (check.code === null || check.code === undefined ? '未运行' : '失败');
    const cls = check.code === 0 ? 'badge-ok' : (check.code === null || check.code === undefined ? 'badge' : 'badge-err');
    head.appendChild(badge(label, cls));
    head.appendChild(el('span', 'check-command', formatCommand(check)));
    if (check.durationMs !== undefined && check.durationMs !== null) {
      head.appendChild(el('span', 'muted small', formatNumber(check.durationMs) + ' ms'));
    }
    card.appendChild(head);
    if (check.stdout) card.appendChild(preBlock(check.stdout));
    if (check.stderr) card.appendChild(preBlock(check.stderr));
    return card;
  }

  function formatCommand(check) {
    const cmd = check.command || '';
    const args = Array.isArray(check.args) ? check.args : [];
    return (cmd + ' ' + args.join(' ')).trim();
  }

  function preBlock(text) {
    const pre = el('pre', 'pre-block');
    pre.textContent = displayValue(text);
    return pre;
  }

  function renderReviewTab(run) {
    const wrap = el('div', '');
    const review = run.review;
    if (!review) {
      wrap.appendChild(emptyState('暂无审查', 'GPT 审查结果会显示在这里。'));
      return wrap;
    }
    const headCard = el('div', 'finding-card');
    const head = el('div', 'finding-head');
    head.appendChild(badge(review.approved ? '审查通过' : '审查未通过', review.approved ? 'badge-ok' : 'badge-err'));
    if (review.summary) head.appendChild(el('span', 'muted small', displayValue(review.summary)));
    headCard.appendChild(head);
    wrap.appendChild(headCard);

    const hasChecks = Array.isArray(run.checks) && run.checks.length > 0;
    const checksFailed = hasChecks && run.checks.some((check) => check.code !== 0 && check.code !== null && check.code !== undefined);
    if (review.approved && checksFailed) {
      wrap.appendChild(noteBanner('存在未通过的检查；失败检查会覆盖“审查通过”的结论。'));
    }
    if (review.approved && !hasChecks) {
      wrap.appendChild(noteBanner('本运行没有自动检查，通过仅代表模型审查；交付时需披露未执行自动检查。'));
    }

    const findings = Array.isArray(review.findings) ? review.findings : [];
    if (findings.length) {
      const block = el('div', 'panel-block');
      block.appendChild(el('h3', 'tab-section-title', '审查发现'));
      findings.forEach((finding) => block.appendChild(renderFindingCard(finding)));
      wrap.appendChild(block);
    }

    const repairs = Array.isArray(review.repairTasks) ? review.repairTasks : [];
    if (repairs.length) {
      const block = el('div', 'panel-block');
      block.appendChild(el('h3', 'tab-section-title', '修复任务'));
      repairs.forEach((task) => block.appendChild(renderTaskCard(task)));
      wrap.appendChild(block);
    }
    return wrap;
  }

  function renderFindingCard(finding) {
    const card = el('div', 'finding-card');
    const head = el('div', 'finding-head');
    head.appendChild(severityBadge(finding.severity));
    if (finding.path) head.appendChild(el('span', 'muted small', finding.path));
    card.appendChild(head);
    if (finding.description) card.appendChild(el('div', 'task-text', displayValue(finding.description)));
    return card;
  }

  function severityBadge(severity) {
    const map = {
      critical: { label: '严重', cls: 'severity-critical' },
      major: { label: '主要', cls: 'severity-major' },
      minor: { label: '次要', cls: 'severity-minor' }
    };
    const meta = map[severity] || { label: severity || '未知', cls: 'badge' };
    return badge(meta.label, meta.cls);
  }

  function renderDiffTab(run) {
    const wrap = el('div', '');
    const refresh = button('刷新变更', 'btn small');
    refresh.addEventListener('click', () => {
      app.diff.delete(run.id);
      app.diffRequests.set(run.id, (app.diffRequests.get(run.id) || 0) + 1);
      renderRunDetail(run);
    });
    wrap.appendChild(refresh);
    const cached = app.diff.get(run.id);
    if (cached === 'loading' || !cached) {
      wrap.appendChild(emptyState('正在读取变更', '正在从磁盘读取差异，请稍候…'));
      if (!cached) {
        app.diff.set(run.id, 'loading');
        void loadDiff(run.id);
      }
      return wrap;
    }
    if (cached.error) {
      wrap.appendChild(errorBanner(cached.error));
      return wrap;
    }
    if (cached.baselineDirty) {
      wrap.appendChild(noteBanner('基线目录有未提交变更，本次差异仅供参考。'));
    }
    const files = Array.isArray(cached.files) ? cached.files : [];
    if (files.length) {
      const block = el('div', 'panel-block');
      block.appendChild(el('h3', 'tab-section-title', '变更文件'));
      const listBox = el('div', 'finding-card');
      files.forEach((file) => listBox.appendChild(renderDiffFileRow(file)));
      block.appendChild(listBox);
      wrap.appendChild(block);
    }
    if (cached.text) {
      const block = el('div', 'panel-block');
      block.appendChild(el('h3', 'tab-section-title', '差异内容'));
      block.appendChild(preBlock(cached.text));
      wrap.appendChild(block);
    }
    if (!files.length && !cached.text) {
      wrap.appendChild(emptyState('暂无变更', '本运行未产生文件差异。'));
    }
    return wrap;
  }

  function renderDiffFileRow(file) {
    const row = el('div', 'diff-file');
    const filePath = typeof file === 'string' ? file : (file && file.path) || '未知文件';
    const fileStatus = file && file.status ? file.status : 'changed';
    row.appendChild(el('span', 'diff-file-path', filePath));
    const status = fileStatus;
    const map = {
      added: { label: '新增', cls: 'badge-ok' },
      modified: { label: '修改', cls: 'badge-qwen' },
      deleted: { label: '删除', cls: 'badge-err' },
      changed: { label: '变更', cls: 'badge' }
    };
    const meta = map[status] || { label: status, cls: 'badge' };
    row.appendChild(badge(meta.label, meta.cls));
    return row;
  }

  async function loadDiff(id) {
    const ticket = (app.diffRequests.get(id) || 0) + 1;
    app.diffRequests.set(id, ticket);
    try {
      const diff = await window.studio.getDiff(id);
      if (app.diffRequests.get(id) !== ticket) return;
      app.diff.set(id, diff || { text: '', files: [], baselineDirty: false });
      if (app.selectedRunId === id && app.runTab === 'diff') {
        const run = currentRun();
        if (run) renderRunDetail(run);
      }
    } catch (err) {
      if (app.diffRequests.get(id) !== ticket) return;
      app.diff.set(id, { error: errorMessage(err, '读取变更失败') });
      if (app.selectedRunId === id && app.runTab === 'diff') {
        const run = currentRun();
        if (run) renderRunDetail(run);
      }
    }
  }

  function ensureConnectionsView() {
    const view = $('view-connections');
    if (!view.hasChildNodes()) buildConnectionsView();
    populateSettingsForm(app.settings || DEFAULT_SETTINGS);
    refreshConnectionStatus();
    updateRunningUi();
  }

  function buildConnectionsView() {
    const view = $('view-connections');
    clear(view);
    const setupCard = el('section', 'card setup-card');
    setupCard.id = 'connections-setup';
    view.appendChild(setupCard);
    const grid = el('div', 'connections-grid');

    const settingsCard = el('section', 'card');
    const settingsHeader = el('div', 'card-header');
    settingsHeader.appendChild(el('h2', 'card-title', '模型设置'));
    settingsCard.appendChild(settingsHeader);
    const settingsBody = el('div', 'card-body');
    const fieldset = el('fieldset', 'settings-fieldset');
    fieldset.id = 'settings-fieldset';
    fieldset.appendChild(formField('Codex / GPT 命令', textInput('codexCommand', ''), '可执行文件名或绝对路径，例如 codex。'));
    fieldset.appendChild(formField('GPT 模型', textInput('gptModel', ''), '留空表示使用 Codex 配置的默认模型。'));
    fieldset.appendChild(formField('GPT 推理强度', selectInput('gptEffort', [
      { value: 'ultra', label: 'ultra（最高，需模型支持）' },
      { value: 'max', label: 'max（很高，需模型支持）' },
      { value: 'xhigh', label: 'xhigh（较高，需模型支持）' },
      { value: 'high', label: 'high（高）' },
      { value: 'medium', label: 'medium（中）' },
      { value: 'low', label: 'low（低）' }
    ]), '默认 high，质量优先。'));
    fieldset.appendChild(formField('Claude Code 命令', textInput('claudeCommand', ''), 'DeepSeek 通过 Claude Code 执行。'));
    fieldset.appendChild(formField('DeepSeek 模型', textInput('deepseekModel', ''), '例如 deepseek-v4-pro。'));
    fieldset.appendChild(formField('Claude 设置文件路径', textInput('claudeSettingsPath', ''), '可选，例如用户目录下的 .claude/settings.json。'));
    fieldset.appendChild(formField('Ollama 地址', textInput('ollamaUrl', ''), '默认 http://127.0.0.1:11434。'));
    fieldset.appendChild(formField('Qwen 模型', textInput('qwenModel', ''), '例如 qwen3:8b。'));
    fieldset.appendChild(formField('最大审查轮数', numberInput('maxReviewRounds', 1, 20, 1), '审查轮次用尽后结束为“需关注”。'));
    fieldset.appendChild(formField('调用超时（分钟）', numberInput('timeoutMinutes', 5, 240, 1), '每次模型调用的超时，不限制整个项目的总时长。'));
    settingsBody.appendChild(fieldset);
    const saveRow = el('div', 'start-row');
    const saveBtn = button('保存设置', 'btn primary small');
    saveBtn.id = 'settings-save';
    saveBtn.addEventListener('click', () => {
      void saveSettingsAction();
    });
    saveRow.appendChild(saveBtn);
    saveRow.appendChild(el('span', 'field-hint', '运行期间设置将被锁定。'));
    settingsBody.appendChild(saveRow);
    settingsCard.appendChild(settingsBody);
    grid.appendChild(settingsCard);

    const statusCard = el('section', 'card');
    const statusHeader = el('div', 'card-header');
    statusHeader.appendChild(el('h2', 'card-title', '连接状态'));
    const probeBtn = button('检测连接', 'btn accent small');
    probeBtn.id = 'probe-btn';
    probeBtn.addEventListener('click', () => {
      void probeAction();
    });
    statusHeader.appendChild(probeBtn);
    statusCard.appendChild(statusHeader);
    const statusBody = el('div', 'card-body');
    statusBody.id = 'connections-status';
    statusCard.appendChild(statusBody);
    grid.appendChild(statusCard);

    view.appendChild(grid);
    view.appendChild(noteBanner('可用/已配置表示检测到可执行文件或服务，不代表已通过真实推理验证；是否可成功调用以实际运行结果为准。'));
  }

  function textInput(id, value) {
    const input = el('input', 'input');
    input.id = id;
    input.type = 'text';
    input.value = value || '';
    return input;
  }

  function numberInput(id, min, max, step) {
    const input = el('input', 'input');
    input.id = id;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    return input;
  }

  function selectInput(id, options) {
    const select = el('select', 'select');
    select.id = id;
    options.forEach((option) => {
      const node = el('option', '', option.label);
      node.value = option.value;
      select.appendChild(node);
    });
    return select;
  }

  function formField(label, control, hint) {
    const field = el('div', 'field');
    const labelNode = el('label', 'field-label', label);
    labelNode.htmlFor = control.id;
    field.appendChild(labelNode);
    field.appendChild(control);
    if (hint) field.appendChild(el('span', 'field-hint', hint));
    return field;
  }

  function populateSettingsForm(settings) {
    setInputValue('codexCommand', settings.codexCommand);
    setInputValue('gptModel', settings.gptModel);
    setInputValue('gptEffort', settings.gptEffort);
    setInputValue('claudeCommand', settings.claudeCommand);
    setInputValue('deepseekModel', settings.deepseekModel);
    setInputValue('claudeSettingsPath', settings.claudeSettingsPath);
    setInputValue('ollamaUrl', settings.ollamaUrl);
    setInputValue('qwenModel', settings.qwenModel);
    setInputValue('maxReviewRounds', settings.maxReviewRounds);
    setInputValue('timeoutMinutes', settings.timeoutMinutes);
  }

  function setInputValue(id, value) {
    const input = $(id);
    if (!input) return;
    if (value === undefined || value === null) value = '';
    input.value = String(value);
  }

  function readSettingsForm() {
    return {
      codexCommand: $('codexCommand').value.trim(),
      gptModel: $('gptModel').value.trim(),
      gptEffort: $('gptEffort').value,
      claudeCommand: $('claudeCommand').value.trim(),
      deepseekModel: $('deepseekModel').value.trim(),
      claudeSettingsPath: $('claudeSettingsPath').value.trim(),
      ollamaUrl: $('ollamaUrl').value.trim(),
      qwenModel: $('qwenModel').value.trim(),
      maxReviewRounds: Number($('maxReviewRounds').value),
      timeoutMinutes: Number($('timeoutMinutes').value)
    };
  }

  async function saveSettingsAction() {
    if (app.saving) return;
    const settings = readSettingsForm();
    if (!Number.isInteger(settings.maxReviewRounds) || settings.maxReviewRounds < 1 || settings.maxReviewRounds > 20) {
      showToast('最大审查轮数需为 1-20 的整数。', 'error');
      return;
    }
    if (!Number.isInteger(settings.timeoutMinutes) || settings.timeoutMinutes < 5 || settings.timeoutMinutes > 240) {
      showToast('调用超时需为 5-240 的整数。', 'error');
      return;
    }
    app.saving = true;
    updateRunningUi();
    try {
      const saved = await window.studio.saveSettings(settings);
      app.settings = saved || settings;
      app.connections = null;
      updateConnectionSidebar();
      refreshConnectionStatus();
      showToast('设置已保存。', 'success');
      await probeAction();
    } catch (err) {
      showError(err, '保存设置失败');
    } finally {
      app.saving = false;
      updateRunningUi();
    }
  }

  async function probeAction() {
    if (app.probing) return;
    app.probing = true;
    updateRunningUi();
    try {
      const connections = await window.studio.probe();
      if (connections) {
        app.connections = connections;
        updateConnectionSidebar();
        refreshWorkbenchDynamic();
        refreshConnectionStatus();
        showToast('连接检测完成。', 'success');
      }
    } catch (err) {
      showError(err, '检测连接失败');
    } finally {
      app.probing = false;
      updateRunningUi();
    }
  }

  function refreshConnectionStatus() {
    const container = $('connections-status');
    if (!container) return;
    clear(container);
    const c = app.connections;
    if (!c) {
      container.appendChild(emptyState('尚未检测', '点击右上角“检测连接”获取连接状态。'));
      return;
    }
    container.appendChild(renderCodexStatus(c.codex));
    container.appendChild(renderDeepseekStatus(c.deepseek));
    container.appendChild(renderOllamaStatus(c.ollama));
  }

  function renderCodexStatus(codex) {
    const card = el('div', 'conn-card');
    const head = el('div', 'conn-card-head');
    head.appendChild(el('span', 'conn-card-name', 'GPT / Codex'));
    if (codex) {
      head.appendChild(badge(codex.available ? '已检测' : '未检测', codex.available ? 'badge-ok' : 'badge-err'));
    } else {
      head.appendChild(badge('未检测', 'badge-err'));
    }
    card.appendChild(head);
    const facts = el('div', 'conn-fact-list');
    if (!codex) {
      facts.appendChild(factLine('状态', '未返回 Codex 信息'));
    } else {
      facts.appendChild(factLine('认证', codex.authenticated ? '已认证' : '未认证'));
      facts.appendChild(factLine('认证方式', codex.authMode || '—'));
      facts.appendChild(factLine('命令', codex.command || '—'));
      facts.appendChild(factLine('版本', codex.version || '—'));
      if (codex.error) facts.appendChild(factLine('错误', codex.error, true));
      const models = Array.isArray(codex.models) ? codex.models : [];
      facts.appendChild(factLine('模型目录', models.length ? '' : '未读取到模型目录'));
      if (models.length) {
        const list = el('div', 'model-list');
        models.slice(0, 12).forEach((model) => {
          list.appendChild(el('span', 'model-chip', modelName(model)));
        });
        facts.appendChild(list);
      }
    }
    card.appendChild(facts);
    return card;
  }

  function renderDeepseekStatus(deepseek) {
    const card = el('div', 'conn-card');
    const head = el('div', 'conn-card-head');
    head.appendChild(el('span', 'conn-card-name', 'DeepSeek'));
    if (deepseek) {
      head.appendChild(badge(deepseek.available ? '可执行' : '未检测', deepseek.available ? 'badge-ok' : 'badge-err'));
      head.appendChild(badge(deepseek.configured ? '已配置' : '未配置', deepseek.configured ? 'badge-ok' : 'badge-warn'));
    } else {
      head.appendChild(badge('未检测', 'badge-err'));
    }
    card.appendChild(head);
    const facts = el('div', 'conn-fact-list');
    if (!deepseek) {
      facts.appendChild(factLine('状态', '未返回 DeepSeek 信息'));
    } else {
      facts.appendChild(factLine('命令', deepseek.command || '—'));
      facts.appendChild(factLine('模型', deepseek.model || '—'));
      facts.appendChild(factLine('Base URL', deepseek.baseUrl || '—'));
      if (deepseek.error) facts.appendChild(factLine('错误', deepseek.error, true));
    }
    card.appendChild(facts);
    return card;
  }

  function renderOllamaStatus(ollama) {
    const card = el('div', 'conn-card');
    const head = el('div', 'conn-card-head');
    head.appendChild(el('span', 'conn-card-name', 'Ollama Qwen'));
    if (ollama) {
      head.appendChild(badge(ollama.available ? '服务可达' : '不可达', ollama.available ? 'badge-ok' : 'badge-err'));
    } else {
      head.appendChild(badge('未检测', 'badge-err'));
    }
    card.appendChild(head);
    const facts = el('div', 'conn-fact-list');
    if (!ollama) {
      facts.appendChild(factLine('状态', '未返回 Ollama 信息'));
    } else {
      facts.appendChild(factLine('Base URL', ollama.baseUrl || '—'));
      if (ollama.error) facts.appendChild(factLine('错误', ollama.error, true));
      const models = Array.isArray(ollama.models) ? ollama.models : [];
      const loaded = Array.isArray(ollama.loaded) ? ollama.loaded : [];
      facts.appendChild(factLine('模型数量', models.length + ' 个'));
      if (models.length) {
        const list = el('div', 'model-list');
        models.slice(0, 16).forEach((model) => {
          list.appendChild(el('span', 'model-chip', modelName(model)));
        });
        facts.appendChild(list);
      }
      facts.appendChild(factLine('已加载', loaded.length ? loaded.map((item) => (item && (item.name || item.id || item.model)) || String(item)).join('、') : '—'));
    }
    card.appendChild(facts);
    return card;
  }

  function factLine(label, value, isError) {
    const line = el('div', '');
    const strong = el('strong', '', label + '：');
    const span = el('span', isError ? 'error-text' : '', displayValue(value));
    line.appendChild(strong);
    line.appendChild(span);
    return line;
  }

  function ensureStandardsView() {
    const view = $('view-standards');
    if (view.hasChildNodes()) return;
    buildStandardsView();
  }

  function buildStandardsView() {
    const view = $('view-standards');
    clear(view);
    const grid = el('div', 'standards-grid');
    grid.appendChild(standardsCard('协作分工', [
      'GPT 始终负责制定计划并执行最终审查。',
      'DeepSeek 与 Ollama Qwen 作为执行 worker，按计划顺序工作。',
      '困难工作可交给 GPT；Qwen v1 只承担只读支持任务。'
    ]));
    grid.appendChild(standardsCard('执行规则', [
      'v1 顺序执行，避免两个 writer 同时修改同一项目。',
      '每次运行记录基线、补丁、检查、交接和审查。',
      'GPT 与 DeepSeek 可按需浏览本机文件，成果目录与外部只读参考路径分别记录。',
      '完成需要 GPT 批准且检查通过。',
      '不自动 reset/clean/revert 用户代码；取消会停止子进程并保留现有编辑。'
    ]));
    grid.appendChild(standardsCard('质量与安全', [
      '质量优先于时间和 token 节省；不削弱验收标准。',
      '连接、模型目录、成功推理是不同事实。',
      '不要把模型目录条目当作已验证推理。',
      '真实提供方错误必须可见，绝不模拟成功。'
    ]));
    grid.appendChild(standardsCard('渲染与数据', [
      '纯浏览器 JS，无 Node 访问；IPC 校验所有载荷。',
      '模型输出通过 textContent 渲染，禁止动态 innerHTML。',
      'CSP 阻止远程资源；凭据不进入渲染进程、日志或持久化设置。',
      '本页是内置规范摘要，完整规范见 docs/ENGINEERING.md。'
    ]));
    view.appendChild(grid);
    view.appendChild(noteBanner('审查轮次用尽会结束为“需关注”，不会标记完成；没有自动检查时，交付必须披露这一限制。'));
  }

  function standardsCard(title, items) {
    const card = el('section', 'card standards-card');
    card.appendChild(el('h3', '', title));
    const list = el('ul', '');
    items.forEach((item) => list.appendChild(el('li', '', item)));
    card.appendChild(list);
    return card;
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (app.view === 'workbench' && !app.starting && !activeRun()) {
        void startAction();
      }
      return;
    }
    // Esc 不绑定取消操作，避免误触取消正在运行的协作任务。
  });

  window.addEventListener('unhandledrejection', (event) => {
    showError(event.reason, '未处理的异步错误');
    event.preventDefault();
  });
})();
