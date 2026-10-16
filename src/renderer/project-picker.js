'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  let projects = null;
  let currentOperation = null;
  let onSelect;
  let onError;
  let dialog;
  let account;
  let repositoryPage = { page: 1, hasMore: false, repositories: [] };
  let repositoryRequest = 0;
  let repositoryBusy = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className || '';
    if (text != null) node.textContent = text;
    return node;
  }

  function action(label, id, callback, className = 'btn small') {
    const button = element('button', className, label);
    button.type = 'button';
    button.id = id;
    button.addEventListener('click', () => { Promise.resolve().then(callback).catch(showError); });
    return button;
  }

  function showError(error) {
    const message = (error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if ($('project-dialog-error')) $('project-dialog-error').textContent = message;
    else onError(error, '项目操作失败');
  }

  function renderRecent() {
    const container = $('recent-projects');
    if (!container) return;
    container.replaceChildren(element('div', 'field-label', '最近项目'));
    if (!projects?.recent.length) container.appendChild(element('div', 'muted small', '打开、新建或导入项目后，会自动保存在这里。'));
    if (projects?.warning) container.appendChild(element('div', 'note-banner', projects.warning));
    for (const item of projects?.recent || []) {
      const row = element('div', 'recent-project-row');
      const choose = action('', '', async () => onSelect(await window.studio.selectProject(item.path)), 'recent-project-choice');
      choose.disabled = !item.available;
      choose.title = item.path;
      choose.append(element('strong', '', item.name + (item.path === projects.selectedPath ? ' · 当前' : '')),
        element('span', 'muted small', item.path + (item.available ? '' : ' · 目录不可用，请重新打开')));
      const forget = action('移除记录', '', async () => onSelect(await window.studio.forgetProject(item.path)), 'btn ghost small');
      forget.setAttribute('aria-label', '移除最近项目记录：' + item.name);
      row.append(choose, forget);
      container.appendChild(row);
    }
  }

  function renderOperation() {
    for (const id of ['project-operation', 'github-operation']) {
      const container = $(id);
      if (!container) continue;
      container.replaceChildren();
      if (!currentOperation) continue;
      container.appendChild(element('div', currentOperation.status === 'failed' ? 'error-banner' : 'note-banner', currentOperation.message));
      if (currentOperation.projectPath) container.appendChild(element('div', 'field-hint project-location', currentOperation.projectPath));
      if (currentOperation.code) {
        container.appendChild(element('div', 'github-device-code', currentOperation.code));
        const buttons = element('div', 'start-row');
        buttons.append(action('复制授权码', id + '-copy-code', () => window.studio.copyText(currentOperation.code)),
          action('打开授权页面', id + '-device-page', () => window.studio.githubDevicePage()));
        container.appendChild(buttons);
      }
      if (currentOperation.status === 'running') container.appendChild(action('取消' + (currentOperation.kind === 'login' ? '登录' : '导入'), id + '-cancel', () => window.studio.githubCancel(currentOperation.id), 'btn ghost small'));
    }
    const busy = currentOperation?.status === 'running';
    if ($('project-submit')) $('project-submit').disabled = Boolean(busy);
    if ($('github-login')) $('github-login').disabled = Boolean(busy) || account?.available === false;
  }

  function renderRepositories() {
    const container = $('github-repositories');
    if (!container) return;
    container.replaceChildren();
    const query = ($('github-filter')?.value || '').trim().toLowerCase();
    for (const item of repositoryPage.repositories.filter((repo) => (repo.name + ' ' + repo.description).toLowerCase().includes(query))) {
      const row = action('', '', () => {
        $('github-repository').value = item.name;
        $('project-name').value = item.name.split('/')[1];
        $('project-name').focus();
      }, 'github-repository-choice');
      row.append(element('strong', '', item.name), element('span', 'badge', item.private ? '私有' : '公开'), element('span', 'muted small', item.description));
      container.appendChild(row);
    }
    if (!container.hasChildNodes()) container.appendChild(element('div', 'muted small', query ? '本页没有匹配仓库。也可以直接填写仓库地址。' : '暂无仓库列表。登录后可加载有权限访问的仓库，也可以直接填写公开仓库地址。'));
    $('github-page').textContent = '第 ' + repositoryPage.page + ' 页';
    $('github-previous').disabled = repositoryBusy || repositoryPage.page <= 1;
    $('github-next').disabled = repositoryBusy || !repositoryPage.hasMore;
    $('github-load-repos').disabled = repositoryBusy || !account?.authenticated;
  }

  async function loadRepositories(page = 1) {
    const request = ++repositoryRequest;
    repositoryBusy = true;
    renderRepositories();
    try {
      const result = await window.studio.githubRepositories(page);
      if (request !== repositoryRequest || !dialog?.open) return;
      repositoryPage = result;
    } finally {
      if (request === repositoryRequest) { repositoryBusy = false; renderRepositories(); }
    }
  }

  async function refreshAccount() {
    const opened = dialog;
    const result = await window.studio.githubStatus();
    if (opened !== dialog || !dialog?.open || !$('github-account')) return;
    account = result;
    $('github-account').textContent = result.authenticated ? '已连接：' + result.login : result.message;
    $('github-login').textContent = result.authenticated ? '重新登录 GitHub' : '连接 GitHub';
    renderOperation();
    renderRepositories();
    if (account.authenticated) await loadRepositories(1);
  }

  function field(label, id, placeholder) {
    const wrap = element('label', 'project-field');
    wrap.appendChild(element('span', 'field-label', label));
    const input = element('input', 'input');
    input.id = id;
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    wrap.appendChild(input);
    return wrap;
  }

  function openDialog(mode) {
    if (dialog?.open) return;
    const github = mode === 'github';
    const modal = element('dialog', 'project-dialog');
    dialog = modal;
    modal.id = 'project-dialog';
    modal.setAttribute('aria-labelledby', 'project-dialog-title');
    const title = element('h2', 'card-title', github ? '从 GitHub 导入' : '新建项目');
    title.id = 'project-dialog-title';
    const header = element('div', 'card-header');
    header.append(title, action('关闭', 'project-dialog-close', () => modal.close(), 'btn ghost small'));
    modal.appendChild(header);
    const body = element('div', 'card-body project-dialog-body');
    modal.appendChild(body);
    let parent = projects?.defaultParent || '';
    if (github) {
      account = null;
      repositoryPage = { page: 1, hasMore: false, repositories: [] };
      const accountText = element('div', 'muted small', '正在检测 GitHub 登录状态…');
      accountText.id = 'github-account';
      body.appendChild(accountText);
      const actions = element('div', 'start-row');
      actions.append(action('连接 GitHub', 'github-login', async () => operation(await window.studio.githubLogin())),
        action('刷新连接', 'github-refresh', refreshAccount, 'btn ghost small'));
      body.appendChild(actions);
      const operationBlock = element('div', '');
      operationBlock.id = 'github-operation';
      body.appendChild(operationBlock);
      body.appendChild(field('仓库地址', 'github-repository', 'https://github.com/owner/repository 或 owner/repository'));
      const browser = element('details', 'github-repo-browser');
      browser.open = true;
      browser.appendChild(element('summary', '', '从我的仓库列表选择'));
      browser.appendChild(field('筛选当前页仓库', 'github-filter', '输入仓库名称'));
      const repoList = element('div', 'github-repositories');
      repoList.id = 'github-repositories';
      browser.appendChild(repoList);
      const pages = element('div', 'start-row');
      const pageLabel = element('span', 'muted small', '第 1 页');
      pageLabel.id = 'github-page';
      pages.append(action('加载仓库', 'github-load-repos', () => loadRepositories(1)),
        action('上一页', 'github-previous', () => loadRepositories(repositoryPage.page - 1)), pageLabel,
        action('下一页', 'github-next', () => loadRepositories(repositoryPage.page + 1)));
      browser.appendChild(pages);
      body.appendChild(browser);
    }
    body.appendChild(field('项目文件夹名称', 'project-name', github ? '选择仓库后自动填写，也可自行修改' : '例如：微信助手'));
    body.appendChild(element('div', 'field-label', '保存位置'));
    const location = element('div', 'path-display', parent);
    location.id = 'project-parent';
    body.appendChild(location);
    body.appendChild(action('更换保存位置', 'project-change-parent', async () => {
      const chosen = await window.studio.chooseProjectParent();
      if (chosen) { parent = chosen; location.textContent = chosen; }
    }, 'btn ghost small'));
    body.appendChild(element('div', 'field-hint', github ? '仓库将下载到此位置下的新文件夹，成功后自动选为当前项目。公开仓库可直接导入；私有仓库需要账号访问权限。' : '将在此位置创建一个新的空文件夹，随后直接描述你要制作的软件。'));
    const error = element('div', 'project-error');
    error.id = 'project-dialog-error';
    error.setAttribute('role', 'alert');
    body.appendChild(error);
    body.appendChild(action(github ? '导入并打开项目' : '创建并打开项目', 'project-submit', async () => {
      error.textContent = '';
      $('project-submit').disabled = true;
      try {
        const input = { name: $('project-name').value.trim(), parent };
        if (github) {
          input.repository = $('github-repository').value.trim();
          operation(await window.studio.githubClone(input));
        } else {
          onSelect(await window.studio.createProject(input));
          modal.close();
        }
      } finally { if ($('project-submit')) $('project-submit').disabled = currentOperation?.status === 'running'; }
    }, 'btn primary'));
    modal.addEventListener('close', () => { ++repositoryRequest; repositoryBusy = false; modal.remove(); if (dialog === modal) dialog = null; });
    document.body.appendChild(modal);
    modal.showModal();
    if (github) {
      $('github-filter').addEventListener('input', renderRepositories);
      $('github-repository').addEventListener('change', () => {
        const match = $('github-repository').value.trim().match(/\/([a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/);
        if (match && !$('project-name').value) $('project-name').value = match[1];
      });
      renderRepositories();
      renderOperation();
      void refreshAccount().catch(showError);
    }
  }

  function operation(value) {
    if (!value || (currentOperation?.id === value.id && currentOperation.status !== 'running' && value.status === 'running')) return;
    const justCompleted = value.status === 'completed' && (currentOperation?.id !== value.id || currentOperation.status !== 'completed');
    currentOperation = value;
    if (value.projects) onSelect(value.projects);
    renderOperation();
    if (justCompleted && value.kind === 'login' && $('github-account')) void refreshAccount().catch(showError);
    if (justCompleted && value.kind === 'clone' && $('github-repository')) dialog.close();
  }

  window.projectPicker = {
    mount(container, actions, select, error) {
      onSelect = select;
      onError = error;
      actions.prepend(action('新建项目', 'new-project', () => openDialog('new')));
      actions.insertBefore(action('从 GitHub 导入', 'github-import', () => openDialog('github')), actions.querySelector('#open-project'));
      const recent = element('div', 'recent-projects');
      recent.id = 'recent-projects';
      const progress = element('div', '');
      progress.id = 'project-operation';
      container.append(recent, progress);
      renderRecent();
    },
    state(value) { projects = value; renderRecent(); },
    operation,
  };
})();
