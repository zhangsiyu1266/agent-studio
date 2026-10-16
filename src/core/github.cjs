'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runProcess } = require('./process.cjs');

function repositoryName(input) {
  if (typeof input !== 'string' || input.length > 300) throw new Error('请输入 GitHub 仓库地址或 owner/repository。');
  let value = input.trim();
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('仅支持不含凭据的 github.com 仓库地址。');
    value = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  value = value.replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(value) || ['.', '..'].includes(value.split('/')[1])) {
    throw new Error('仓库格式应为 owner/repository，或其 GitHub HTTPS 地址；不要填写文件或分支页面。');
  }
  return value;
}

function resolveGithub() {
  const candidates = [
    path.resolve(__dirname, '../../tools/github/bin/gh.exe'),
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'GitHub CLI', 'gh.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, process.platform === 'win32' ? 'gh.exe' : 'gh')),
  ];
  return candidates.find((target) => { try { return fs.statSync(target).isFile(); } catch { return false; } }) || null;
}

async function githubEnvironment() {
  const env = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: undefined, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (process.platform !== 'win32' || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) return env;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const [enabled, server] = await Promise.all([
      runProcess('reg.exe', ['query', key, '/v', 'ProxyEnable'], { timeoutMs: 3000 }),
      runProcess('reg.exe', ['query', key, '/v', 'ProxyServer'], { timeoutMs: 3000 }),
    ]);
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enabled.stdout)) return env;
    const raw = server.stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
    const target = raw?.includes('=') ? raw.match(/(?:^|;)https=([^;]+)/)?.[1] || raw.match(/(?:^|;)http=([^;]+)/)?.[1] : raw;
    if (target && /^[a-zA-Z0-9.\-\[\]:]+$/.test(target)) {
      const proxy = new URL('http://' + target);
      env.HTTPS_PROXY = proxy.href;
      env.HTTP_PROXY = proxy.href;
    }
  } catch { /* Existing environment and Git settings remain usable if system proxy lookup fails. */ }
  return env;
}

class Github {
  constructor(projects, notify = () => {}, dependencies = {}) {
    this.projects = projects;
    this.notify = notify;
    this.run = dependencies.runProcess || runProcess;
    this.resolve = dependencies.resolveGithub || resolveGithub;
    this.environment = dependencies.environment || githubEnvironment;
    this.operation = null;
    this.controller = null;
    this.pending = null;
  }

  emit(patch) {
    this.operation = { ...this.operation, ...patch };
    this.notify({ type: 'github.operation', operation: { ...this.operation } });
  }

  begin(kind, execute) {
    if (this.controller) throw new Error('请先完成或取消当前 GitHub 操作。');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.operation = { id: randomUUID(), kind, status: 'running', message: kind === 'login' ? '正在准备 GitHub 浏览器授权…' : '正在准备导入…' };
    const started = { ...this.operation };
    this.emit({});
    this.pending = Promise.resolve().then(() => execute(signal)).catch((error) => {
      this.emit({ status: signal.aborted ? 'cancelled' : 'failed', code: '', message: signal.aborted
        ? (kind === 'clone' ? '导入已停止，下载中的目录保留，未设为当前项目。' : '登录已取消。')
        : error.message });
    }).finally(() => { this.controller = null; });
    return started;
  }

  cancel(id) {
    if (typeof id !== 'string' || id !== this.operation?.id || !this.controller) throw new Error('该 GitHub 操作已结束。');
    this.controller.abort();
    return { stopping: true };
  }

  async status() {
    const command = this.resolve();
    if (!command) return { available: false, authenticated: false, login: '', message: '缺少 GitHub 登录组件，请重新准备发布包或安装官方 GitHub CLI。' };
    try {
      const result = await this.run(command, ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'], { timeoutMs: 20000, env: await this.environment() });
      const accounts = JSON.parse(result.stdout).hosts?.['github.com'] || [];
      const account = accounts.find((item) => item.active === true && item.state === 'success');
      return { available: true, authenticated: Boolean(account), login: account?.login || '', message: account ? '已连接 GitHub' : accounts.length ? '登录状态无法验证，请检查网络或重新登录。' : '尚未登录，可直接导入公开仓库。' };
    } catch {
      return { available: true, authenticated: false, login: '', message: '暂时无法验证 GitHub 登录，请检查网络后刷新。' };
    }
  }

  login() {
    const command = this.resolve();
    if (!command) throw new Error('缺少 GitHub CLI 登录组件。');
    return this.begin('login', async (signal) => {
      let output = '';
      const result = await this.run(command, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], {
        signal, timeoutMs: 15 * 60 * 1000, input: '\n', env: { ...await this.environment(), GH_PROMPT_DISABLED: undefined },
        onStderr: (chunk) => {
          output = (output + chunk).slice(-4000);
          const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
          if (code && code !== this.operation.code) this.emit({ code, message: '在浏览器中输入授权码并确认登录。浏览器未打开时，点击“打开授权页面”。' });
        },
      });
      if (signal.aborted) throw new Error('Cancelled');
      if (result.code !== 0) throw new Error('GitHub 登录未完成或已过期，请检查网络后重试。');
      const status = await this.status();
      if (!status.authenticated) throw new Error(status.message);
      this.emit({ status: 'completed', code: '', message: `已连接 GitHub：${status.login}`, account: status.login });
    });
  }

  async repositories(page = 1) {
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('仓库列表页码无效。');
    const command = this.resolve();
    if (!command) throw new Error('缺少 GitHub CLI 登录组件。');
    let result;
    try {
      result = await this.run(command, ['api', '--hostname', 'github.com', `user/repos?per_page=50&sort=pushed&page=${page}`], { timeoutMs: 30000, env: await this.environment() });
    } catch { throw new Error('无法读取仓库列表，请检查网络后重试。'); }
    if (result.code !== 0) throw new Error('无法读取仓库列表，请检查 GitHub 登录、仓库权限或请求限额。');
    let list;
    try { list = JSON.parse(result.stdout); } catch { throw new Error('GitHub 仓库列表响应无效。'); }
    if (!Array.isArray(list)) throw new Error('GitHub 仓库列表响应无效。');
    return { page, hasMore: list.length === 50, repositories: list.map((item) => ({
      name: repositoryName(item.full_name), private: item.private === true,
      description: typeof item.description === 'string' ? item.description.slice(0, 300) : '',
    })) };
  }

  clone(input) {
    const repo = repositoryName(input?.repository);
    return this.begin('clone', async (signal) => {
      const destination = await this.projects.reserve({ name: input.name || repo.split('/')[1], parent: input.parent });
      this.emit({ projectPath: destination, repository: repo, message: '正在从 GitHub 下载仓库…' });
      if (signal.aborted) throw new Error('Cancelled');
      const env = await this.environment();
      const command = this.resolve();
      // A per-process credential helper can use gh's credential store, without
      // copying tokens or rewriting the user's global Git configuration.
      const args = ['-c', 'core.hooksPath=', '-c', 'credential.interactive=false'];
      if (command) {
        const helperPath = command.replaceAll('\\', '/').replaceAll("'", "'\\''");
        args.push('-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!'${helperPath}' auth git-credential`);
      }
      args.push('clone', '--progress', '--no-recurse-submodules', '--', `https://github.com/${repo}.git`, destination);
      let lastPercent = '';
      let result;
      try {
        result = await this.run('git', args, { signal, env, timeoutMs: 30 * 60 * 1000,
          onStderr: (chunk) => {
            const percentages = [...chunk.matchAll(/(Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/g)];
            const match = percentages.at(-1);
            if (match && match[0] !== lastPercent) {
              lastPercent = match[0];
              const label = { 'Receiving objects': '下载对象', 'Resolving deltas': '整理对象', 'Updating files': '写入文件' }[match[1]];
              this.emit({ message: `${label} ${match[2]}%` });
            }
          },
        });
      } catch {
        throw new Error('下载未完成，请检查网络、Git 安装和目录权限。未完成目录已保留，请换一个新目录名称重试。');
      }
      if (signal.aborted) throw new Error('Cancelled');
      if (result.code !== 0) throw new Error('仓库下载失败，请确认地址、GitHub 登录及仓库访问权限。未完成目录已保留，请换一个新目录名称重试。');
      const projects = await this.projects.select(destination, { repository: repo });
      this.emit({ status: 'completed', message: '仓库已导入并设为当前项目。', projects });
    });
  }
}

module.exports = { Github, repositoryName, resolveGithub, githubEnvironment };
