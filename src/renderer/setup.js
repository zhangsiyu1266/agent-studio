'use strict';

(() => {
  let operation = null;
  let feedback = '';
  let latest = {};

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className || '';
    if (text) element.textContent = text;
    return element;
  }

  function render(connections, busy = false, probe = () => {}) {
    latest = { connections, busy, probe };
    const gpt = connections?.codex || {};
    const ready = gpt.available === true && gpt.authenticated === true && gpt.authMode === 'chatgpt';
    const multiModel = connections?.deepseek?.available && connections?.deepseek?.configured;
    for (const id of ['workbench-setup', 'connections-setup']) {
      const card = document.getElementById(id);
      if (!card) continue;
      card.replaceChildren();
      const header = node('div', 'card-header');
      header.appendChild(node('h2', 'card-title', ready ? '已就绪 · ' + (multiModel ? '多模型协作' : 'GPT 基础模式') : '开始使用 / Get started'));
      card.appendChild(header);
      const body = node('div', 'card-body setup-body');
      body.appendChild(node('p', 'muted small', ready
        ? '选择项目并描述需求即可运行。DeepSeek 与 Qwen 可稍后添加，GPT 始终负责验收。'
        : '完整便携版已附带 Codex 和 Node.js。使用你自己的 ChatGPT 账号登录即可开始；DeepSeek、Qwen 和 Git 均可稍后配置。'));
      const status = gpt.available === undefined ? '正在检测运行环境…' : !gpt.available ? '未找到可用 Codex：请完整解压下载包，或查看源码安装说明。'
        : ready ? 'ChatGPT 登录已确认；尚不代表本次推理已验证。' : gpt.authMode === 'api_key'
          ? '当前是 API-key 登录。此工作台需要 ChatGPT 登录，不会切换到 API 计费。' : '运行组件可用，下一步：在浏览器中登录 ChatGPT。';
      body.appendChild(node('p', 'setup-status', status));
      const actions = node('div', 'setup-actions');
      function action(label, name, callback, disabled = false) {
        const button = node('button', 'btn small ' + (name === 'login' ? 'accent' : 'ghost'), label);
        button.type = 'button';
        button.dataset.setupAction = name;
        button.disabled = disabled;
        button.addEventListener('click', async () => {
          try { feedback = ''; await callback(); } catch (error) { feedback = error.message || '操作失败，请重试。'; }
          render(latest.connections, latest.busy, latest.probe);
        });
        actions.appendChild(button);
      }
      const running = operation?.status === 'running';
      if (!ready) action('登录 ChatGPT / Sign in', 'login', async () => { operation = await window.studio.setupLogin(); }, busy || running || !gpt.available);
      if (running) action('取消登录', 'cancel', async () => { operation = await window.studio.setupCancel(); });
      action('重新检测 / Check again', 'probe', probe, running);
      action('使用指南 / Guide', 'guide', () => window.studio.setupHelp('guide'));
      body.appendChild(actions);
      if (operation?.message || feedback) body.appendChild(node('p', 'setup-feedback small', feedback || operation.message));
      const optional = node('details', 'setup-optional');
      optional.appendChild(node('summary', '', '可选增强 / Optional tools'));
      const options = node('div', 'setup-actions');
      for (const [topic, label] of [['deepseek', '配置 DeepSeek'], ['ollama', '安装 Ollama / Qwen'], ['git', '安装 Git'], ['codex', 'Codex 安装帮助']]) {
        const button = node('button', 'btn ghost small', label);
        button.type = 'button';
        button.addEventListener('click', () => window.studio.setupHelp(topic).catch((error) => { feedback = error.message; render(connections, busy, probe); }));
        options.appendChild(button);
      }
      optional.appendChild(options);
      optional.appendChild(node('p', 'muted small', '仅浏览和登录无需安装其他工具。项目可能另需 Python、Git、编译器或其他依赖；云端模型需要账号权限、可用额度和网络连接。'));
      body.appendChild(optional);
      card.appendChild(body);
    }
  }

  window.setupGuide = { render, setOperation: (value) => { operation = value; } };
})();
