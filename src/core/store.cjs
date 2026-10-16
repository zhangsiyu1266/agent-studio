'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redact, sanitizeData } = require('./contracts.cjs');

const ACTIVE_STATUSES = new Set(['planning', 'executing', 'checking', 'reviewing', 'repairing']);

class Store {
  constructor(directory, defaults = {}) {
    this.directory = directory;
    fs.mkdirSync(path.join(directory, 'runs'), { recursive: true });
    this.settings = { ...defaults, ...this.read('settings.json', {}) };
    this.runs = new Map();
    for (const filename of fs.readdirSync(path.join(directory, 'runs'))) {
      if (!/^[a-f0-9-]+\.json$/.test(filename)) continue;
      const run = this.read(path.join('runs', filename), null);
      if (!run?.id) continue;
      if (ACTIVE_STATUSES.has(run.status)) {
        run.status = 'interrupted';
        run.error = '上次执行被中断，已保留修改和证据。可基于当前代码重新执行。';
        this.write(path.join('runs', filename), run);
      }
      this.runs.set(run.id, run);
    }
  }

  read(filename, fallback) {
    const target = path.join(this.directory, filename);
    if (!fs.existsSync(target)) return fallback;
    try { return sanitizeData(JSON.parse(fs.readFileSync(target, 'utf8'))); } catch (error) {
      throw new Error(`本地记录损坏：${filename}。请保留该文件后修复。${error.message}`);
    }
  }

  write(filename, data) {
    const target = path.join(this.directory, filename);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  saveSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.write('settings.json', this.settings);
    return this.settings;
  }

  createRun(projectPath, request) {
    request = redact(request);
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), title: request.slice(0, 36), request, projectPath,
      status: 'planning', phase: 'GPT 正在规划和分配任务', createdAt: now, updatedAt: now,
      plan: null, tasks: [], events: [], checks: [], review: null, round: 0, error: null,
      phaseHistory: [{ status: 'planning', phase: 'GPT 正在规划和分配任务', time: now, round: 0 }],
      reviewHistory: [], completedAt: null,
      usage: Object.fromEntries(['gpt', 'deepseek', 'qwen'].map((name) => [name, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }])),
    };
    this.saveRun(run);
    return run;
  }

  saveRun(run) {
    run.updatedAt = new Date().toISOString();
    this.runs.set(run.id, run);
    this.write(path.join('runs', `${run.id}.json`), run);
    return run;
  }

  getRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('找不到这条执行记录。');
    return run;
  }

  addEvent(run, event) {
    run.events.push({ id: randomUUID(), time: new Date().toISOString(), ...event, message: redact(event.message).slice(0, 14000) });
    if (run.events.length > 600) run.events.splice(0, run.events.length - 600);
    return this.saveRun(run);
  }

  summaries() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => ({
      id: run.id, title: run.title, projectPath: run.projectPath, status: run.status,
      phase: run.phase, createdAt: run.createdAt, updatedAt: run.updatedAt, usage: run.usage,
      completedAt: run.completedAt || null,
    }));
  }

  artifacts(id) {
    this.getRun(id);
    const directory = path.join(this.directory, 'artifacts', id);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }
}

module.exports = { Store, ACTIVE_STATUSES };
