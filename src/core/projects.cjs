'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateProjectDirectory } = require('./context.cjs');

function folderName(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || value !== value.trim()
    || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || /^(\.git|\.codex|\.claude|\.ollama|\.aws|\.ssh)$/i.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) {
    throw new Error('项目名称须为有效的文件夹名称，不能包含路径、特殊字符或 Windows 保留名称。');
  }
  return value;
}

async function projectDirectory(value, checkSource = true) {
  if (typeof value !== 'string' || value.length > 2000 || value.includes('\0') || !path.isAbsolute(value)) throw new Error('请选择有效的本地项目目录。');
  const real = await fs.realpath(value);
  if (!(await fs.stat(real)).isDirectory() || real === path.parse(real).root
    || /(?:^|[\\/])(?:Windows|Program Files(?: \(x86\))?|\.git|\.codex|\.claude|\.ollama|\.aws|\.ssh)$/i.test(real)) {
    throw new Error('请选择具体的软件源码文件夹。');
  }
  if (checkSource) await validateProjectDirectory(real);
  return real;
}

const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;

class Projects {
  constructor(store, defaultParent) {
    this.store = store;
    this.defaultParent = path.resolve(defaultParent);
    const saved = store.read('projects.json', null);
    this.data = saved || { selectedPath: '', recent: [] };
    if (!saved) {
      const seen = new Set();
      this.data.recent = store.summaries().filter((run) => {
        if (!run.projectPath || seen.has(pathKey(run.projectPath))) return false;
        seen.add(pathKey(run.projectPath));
        return true;
      }).slice(0, 20).map((run) => ({ path: run.projectPath, name: path.basename(run.projectPath), lastOpenedAt: run.updatedAt }));
    }
    if (!Array.isArray(this.data.recent) || typeof this.data.selectedPath !== 'string') throw new Error('最近项目记录格式无效，请检查 projects.json。');
  }

  async state() {
    const data = this.data;
    const recent = await Promise.all(data.recent.map(async (item) => {
      try { await projectDirectory(item.path); return { ...item, available: true }; }
      catch { return { ...item, available: false }; }
    }));
    const selected = recent.find((item) => pathKey(item.path) === pathKey(data.selectedPath));
    return { selectedPath: selected?.available ? selected.path : '', recent, defaultParent: this.defaultParent,
      revision: Number(data.revision) || 0,
      warning: data.selectedPath && !selected?.available ? '上次工作目录已移动、不可访问或不适合作为成果目录，请重新选择。' : '' };
  }

  async select(value, extra = {}) {
    const real = await projectDirectory(value);
    const existing = this.data.recent.find((item) => pathKey(item.path) === pathKey(real));
    const item = { ...existing, path: real, name: path.basename(real), lastOpenedAt: new Date().toISOString(), ...extra };
    this.data = { revision: (Number(this.data.revision) || 0) + 1, selectedPath: real, recent: [item, ...this.data.recent.filter((entry) => pathKey(entry.path) !== pathKey(real))].slice(0, 20) };
    this.store.write('projects.json', this.data);
    return this.state();
  }

  async forget(value) {
    if (typeof value !== 'string' || !this.data.recent.some((item) => item.path === value)) throw new Error('最近项目不存在。');
    this.data = { revision: (Number(this.data.revision) || 0) + 1, recent: this.data.recent.filter((item) => item.path !== value),
      selectedPath: this.data.selectedPath === value ? '' : this.data.selectedPath };
    this.store.write('projects.json', this.data);
    return this.state();
  }

  async reserve(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目参数无效。');
    const name = folderName(input.name);
    const parent = input.parent || this.defaultParent;
    if (parent === this.defaultParent) await fs.mkdir(parent, { recursive: true });
    const realParent = await projectDirectory(parent, false);
    const destination = path.join(realParent, name);
    // Create atomically, never reuse or overwrite an existing directory.
    try { await fs.mkdir(destination); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('同名目录已存在，请改用其他名称，或通过“打开本地项目”选择现有目录。');
      throw error;
    }
    return destination;
  }

  async create(input) {
    return this.select(await this.reserve(input));
  }
}

module.exports = { Projects, folderName, projectDirectory };
