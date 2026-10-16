'use strict';

const path = require('node:path');

const taskSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, title: { type: 'string' },
    provider: { type: 'string', enum: ['deepseek', 'qwen', 'gpt'] },
    instructions: { type: 'string' },
    qwenThinking: { type: 'boolean' },
    allowedPaths: { type: 'array', items: { type: 'string' } },
    dependencies: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'title', 'provider', 'instructions', 'qwenThinking', 'allowedPaths', 'dependencies', 'acceptance'],
};

const planSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, summary: { type: 'string' },
    status: { type: 'string', enum: ['ready', 'blocked'] },
    projectPath: { type: 'string' }, blockedReason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    referencePaths: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: taskSchema },
    checks: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['command', 'args'],
      },
    },
    acceptance: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'status', 'projectPath', 'blockedReason', 'evidence', 'referencePaths', 'tasks', 'checks', 'acceptance'],
};

const workerSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    projectPath: { type: 'string' }, summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'projectPath', 'summary', 'changedFiles', 'checks', 'blockers'],
};

function validateWorker(result) {
  if (!result || !['completed', 'blocked', 'failed'].includes(result.status)
    || typeof result.projectPath !== 'string' || !path.isAbsolute(result.projectPath)
    || typeof result.summary !== 'string' || !result.summary.trim()
    || !['changedFiles', 'checks', 'blockers'].every((key) => Array.isArray(result[key])
      && result[key].every((item) => typeof item === 'string' && item.trim()))
    || (result.status === 'completed' && result.blockers.length)
    || (result.status === 'blocked' && !result.blockers.length)) {
    throw new Error('工作者未返回有效的完成/受阻/失败交接，不能视为已完成。');
  }
  return result;
}

const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    approved: { type: 'boolean' }, summary: { type: 'string' },
    findings: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          path: { type: 'string' }, description: { type: 'string' },
        }, required: ['severity', 'path', 'description'],
      },
    },
    repairTasks: { type: 'array', items: taskSchema },
  }, required: ['approved', 'summary', 'findings', 'repairTasks'],
};

function parseStructured(result) {
  if (result.structured && typeof result.structured === 'object') return result.structured;
  const text = String(result.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { throw new Error('模型未返回有效的结构化结果，请查看执行日志。'); }
}

function validScope(value) {
  if (typeof value !== 'string' || !value || value.length > 400 || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/');
  return !path.win32.isAbsolute(value) && !path.posix.isAbsolute(normalized)
    && !normalized.split('/').some((part) => part === '..' || /^(\.git|\.codex|\.claude|\.ollama|\.aws|\.ssh|\.azure|\.config)$/i.test(part))
    && !/^[a-z]:/i.test(normalized);
}

function validateTasks(tasks, priorIds = []) {
  if (!Array.isArray(tasks) || tasks.length > 40) throw new Error('任务清单格式或数量不符合约定。');
  const prior = new Set(priorIds);
  const ids = new Set();
  for (const task of tasks) {
    if (!task || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id) || ids.has(task.id) || prior.has(task.id)) {
      throw new Error('任务 ID 必须唯一，并仅包含字母、数字、下划线或短横线。');
    }
    ids.add(task.id);
    if (!['deepseek', 'qwen', 'gpt'].includes(task.provider) || typeof task.title !== 'string'
      || !task.title.trim() || typeof task.instructions !== 'string' || !task.instructions.trim()
      || (task.qwenThinking !== undefined && typeof task.qwenThinking !== 'boolean')
      || !Array.isArray(task.allowedPaths) || !task.allowedPaths.every(validScope)
      || !Array.isArray(task.dependencies) || !task.dependencies.every((id) => typeof id === 'string')
      || !Array.isArray(task.acceptance) || !task.acceptance.length
      || !task.acceptance.every((item) => typeof item === 'string' && item.trim())) {
      throw new Error(`任务 ${task.id} 缺少明确的分工、文件范围或验收条件。`);
    }
  }
  const pending = [...tasks];
  const completed = new Set(prior);
  const ordered = [];
  while (pending.length) {
    const index = pending.findIndex((task) => task.dependencies.every((id) => completed.has(id)));
    if (index < 0) throw new Error('任务依赖包含环、缺失任务或自引用。');
    const [task] = pending.splice(index, 1);
    completed.add(task.id);
    ordered.push(task);
  }
  return ordered;
}

function validatePlan(plan) {
  if (!plan || typeof plan.title !== 'string' || !plan.title.trim() || typeof plan.summary !== 'string'
    || !Array.isArray(plan.acceptance) || !plan.acceptance.length
    || !plan.acceptance.every((item) => typeof item === 'string' && item.trim())
    || !Array.isArray(plan.checks) || plan.checks.length > 20
    || !['ready', 'blocked'].includes(plan.status)
    || typeof plan.projectPath !== 'string' || !path.isAbsolute(plan.projectPath)
    || typeof plan.blockedReason !== 'string'
    || (plan.status === 'blocked' && !plan.blockedReason.trim())
    || (plan.status === 'ready' && (plan.blockedReason.trim() || !plan.tasks?.length))
    || !Array.isArray(plan.evidence) || !plan.evidence.every((item) => typeof item === 'string')) {
    throw new Error('GPT 规划必须包含目标、任务和明确的最终验收标准。');
  }
  if (plan.referencePaths !== undefined && (!Array.isArray(plan.referencePaths) || plan.referencePaths.length > 40
    || !plan.referencePaths.every((item) => typeof item === 'string' && item.length <= 2000
      && !item.includes('\0') && path.isAbsolute(item)))) {
    throw new Error('参考路径必须是最多 40 个本机绝对文件或目录路径。');
  }
  for (const check of plan.checks) {
    if (!check || typeof check.command !== 'string' || !check.command.trim() || check.command.includes('\0')
      || !Array.isArray(check.args) || check.args.length > 100
      || !check.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
      throw new Error('检查命令必须由独立的程序名和参数数组组成。');
    }
  }
  return { ...plan, referencePaths: plan.referencePaths || [], tasks: validateTasks(plan.tasks) };
}

function validateReview(review, priorIds = []) {
  if (!review || typeof review.approved !== 'boolean' || typeof review.summary !== 'string'
    || !Array.isArray(review.findings) || !Array.isArray(review.repairTasks)) throw new Error('GPT 审查结果不符合约定。');
  for (const finding of review.findings) {
    if (!['critical', 'major', 'minor'].includes(finding.severity) || typeof finding.path !== 'string'
      || typeof finding.description !== 'string') throw new Error('审查问题缺少有效级别或描述。');
  }
  return { ...review, repairTasks: validateTasks(review.repairTasks, priorIds) };
}

function isAccepted(review, checks) {
  return review?.approved === true && review.repairTasks.length === 0
    && !review.findings.some((item) => ['critical', 'major'].includes(item.severity))
    && checks.every((check) => check.code === 0);
}

function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{30,}(?:\.[A-Za-z0-9_-]+){1,2})\b/g, '[已隐藏密钥]')
    .replace(/(["']?(?:[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET)|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|authorization|api[_-]?key|password|access[_-]?token|client[_-]?secret)["']?\s*[=:]\s*["']?)([^\s"',;}]+)/gi, '$1[已隐藏密钥]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏密钥]');
}

function sanitizeData(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitizeData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)$/i.test(key) ? '[已隐藏密钥]' : sanitizeData(item)]));
  }
  return value;
}

module.exports = { planSchema, reviewSchema, workerSchema, parseStructured, validScope, validateTasks, validatePlan, validateWorker, validateReview, isAccepted, redact, sanitizeData };
