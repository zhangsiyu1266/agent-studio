'use strict';

const { resolveCodexExecutable, parseCodexAuthStatus } = require('./discovery.cjs');
const { runProcess } = require('./process.cjs');
const { githubEnvironment } = require('./github.cjs');

const HELP_URLS = Object.freeze({
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
  deepseek: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/',
  ollama: 'https://ollama.com/download/windows',
  git: 'https://git-scm.com/downloads/win',
  node: 'https://nodejs.org/en/download',
  releases: 'https://github.com/zhangsiyu1266/agent-studio/releases/latest',
  guide: 'https://github.com/zhangsiyu1266/agent-studio/blob/master/docs/GETTING-STARTED.md',
});

function helpUrl(topic) {
  if (typeof topic !== 'string' || !Object.hasOwn(HELP_URLS, topic)) throw new Error('未知的安装帮助入口。');
  return HELP_URLS[topic];
}

function readiness(connections = {}) {
  const gpt = connections.codex || {};
  const ready = gpt.available === true && gpt.authenticated === true && gpt.authMode === 'chatgpt';
  const deepseek = connections.deepseek?.available === true && connections.deepseek?.configured === true;
  return { ready, mode: ready ? (deepseek ? 'multi-model' : 'gpt-only') : 'setup', deepseek,
    qwen: connections.ollama?.available === true, requiresLogin: gpt.available === true && !ready };
}

class Setup {
  constructor(settings, notify = () => {}, dependencies = {}) {
    this.settings = settings;
    this.notify = notify;
    this.run = dependencies.runProcess || runProcess;
    this.resolve = dependencies.resolveCodex || resolveCodexExecutable;
    this.environment = dependencies.environment || githubEnvironment;
    this.operation = null;
    this.controller = null;
    this.pending = null;
  }

  publish(status, message) {
    this.operation = { status, message };
    this.notify({ type: 'setup.updated', operation: this.operation });
    return this.operation;
  }

  startLogin() {
    if (this.controller) throw new Error('登录正在进行，请先完成浏览器授权或取消。');
    const command = this.resolve(this.settings());
    if (!command) throw new Error('未找到 Codex。请下载完整便携包，或按安装说明准备 Codex 后重新检测。');
    const controller = new AbortController();
    this.controller = controller;
    this.publish('running', '请在浏览器中完成 ChatGPT 登录。无需在工作台输入密码或 API key。');
    this.pending = (async () => {
      try {
        const env = { ...await this.environment(), OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined };
        const result = await this.run(command, ['login', '-c', 'forced_login_method="chatgpt"'], {
          env, signal: controller.signal, timeoutMs: 300000,
        });
        if (result.code !== 0) throw new Error('Login failed');
        const status = await this.run(command, ['login', 'status'], { env, signal: controller.signal, timeoutMs: 10000 });
        const auth = parseCodexAuthStatus(`${status.stdout}\n${status.stderr}`);
        if (status.code !== 0 || !auth.authenticated || auth.authMode !== 'chatgpt') throw new Error('ChatGPT login not verified');
        this.publish('completed', 'ChatGPT 登录已确认。正在重新检测连接；实际推理以运行结果为准。');
      } catch {
        // OAuth URLs, tokens and subprocess errors must never cross IPC or be persisted.
        this.publish(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted
          ? '已取消登录。' : '未完成 ChatGPT 登录。请检查浏览器授权、网络和账号权限，然后重试。');
      } finally {
        this.controller = null;
      }
      return this.operation;
    })();
    return this.operation;
  }

  cancelLogin() {
    if (!this.controller) throw new Error('当前没有进行中的登录。');
    this.controller.abort();
    return this.operation;
  }
}

module.exports = { Setup, helpUrl, readiness };
