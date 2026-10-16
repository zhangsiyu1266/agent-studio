'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { redact } = require('./contracts.cjs');

const EXCLUDED = new Set(['.git', '.codex', '.claude', '.ollama', '.aws', '.ssh', '.azure', '.config', '.build', '.backups', '.vs', '_internal', 'node_modules', 'dist', 'build', '.agent-studio', '.venv', 'venv', '__pycache__', '.next', 'coverage']);
const SENSITIVE = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*|[^/]*\.(?:pem|key|p12|pfx))$/i;
const SOURCE = /\.(?:md|txt|json|[cm]?js|jsx|ts|tsx|css|html|py|toml|yaml|yml|rs|go|java|cs|cpp|c|h|vue|svelte|sql)$/i;

async function scanInventory(directory, { limit = 10000, maxDepth = 32 } = {}) {
  const files = [];
  const reasons = new Set();
  async function walk(current, depth) {
    if (depth > maxDepth) { reasons.add('目录层级超过扫描上限'); return; }
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) {
      reasons.add(`无法读取目录：${path.relative(directory, current) || '.'} (${error.code})`);
      return;
    }
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if ((entry.isDirectory() && EXCLUDED.has(entry.name.toLowerCase())) || entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      const relative = path.relative(directory, target).replaceAll('\\', '/');
      if (SENSITIVE.test(relative)) continue;
      if (files.length >= limit) { reasons.add(`文件数量超过扫描上限 ${limit}`); break; }
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await walk(directory, 0);
  return { files, complete: reasons.size === 0, reasons: [...reasons] };
}

async function inventory(directory, limit = 10000) {
  return (await scanInventory(directory, { limit })).files;
}

async function validateProjectDirectory(directory) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => !/^(desktop\.ini|thumbs\.db)$/i.test(entry.name));
  // A shortcut folder can be an intentional output directory. GPT resolves
  // referenced sources during read-only planning before assigning any writes.
  return { shortcutOnly: Boolean(entries.length && entries.every((entry) => entry.isFile() && /\.(lnk|url)$/i.test(entry.name))) };
}

function assertComplete(snapshot) {
  if (snapshot.coverage && !snapshot.coverage.complete) {
    const error = new Error(`文件扫描不完整，不能可靠检查修改范围：${snapshot.coverage.reasons.join('；')}。请选择更具体的项目目录或处理上述文件后重试。`);
    error.code = 'SCAN_INCOMPLETE';
    throw error;
  }
}

function matchesScope(filename, scope) {
  const normalized = scope.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '.' || normalized === '**' || normalized === '**/*') return true;
  let pattern = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  pattern = pattern.replaceAll('**/', '\u0001').replaceAll('**', '\u0002').replaceAll('*', '[^/]*');
  pattern = pattern.replaceAll('\u0001', '(?:.*/)?').replaceAll('\u0002', '.*');
  return new RegExp(`^${pattern}(?:/.*)?$`).test(filename);
}

async function makeContext(directory, scopes = [], budget = 22000) {
  const scan = await scanInventory(directory);
  const files = scan.files;
  const preferred = files.filter((filename) => /^(?:README(?:\.[^/]+)?|AGENTS\.md|CLAUDE\.md|package\.json|pyproject\.toml|Cargo\.toml)$/i.test(filename));
  const scoped = scopes.length ? files.filter((filename) => scopes.some((scope) => matchesScope(filename, scope))) : [];
  const chosen = [...new Set([...scoped, ...preferred])];
  const listed = [...new Set([...scoped, ...preferred, ...files])].join('\n');
  const listBudget = Math.min(6000, Math.floor(budget / 4));
  const chunks = [`文件清单（不含依赖、备份、构建产物、密钥文件；${scan.complete ? '扫描完整' : '扫描不完整'}${listed.length > listBudget ? '，清单节选' : ''}）：\n${listed.slice(0, listBudget)}`];
  let remaining = Math.max(0, budget - chunks[0].length);
  for (const filename of chosen.slice(0, 24)) {
    if (!SOURCE.test(filename) || remaining <= 0) continue;
    const target = path.join(directory, filename);
    const info = await fs.stat(target);
    if (info.size > 512000) continue;
    const content = redact(await fs.readFile(target, 'utf8'));
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const excerpt = content.slice(0, Math.min(Math.max(0, remaining - filename.length - 120), 7000));
    if (!excerpt) continue;
    const chunk = `\n文件 ${filename} [内容指纹 ${hash}]${excerpt.length < content.length ? '（节选，需时读取原文件）' : ''}:\n${excerpt}`;
    chunks.push(chunk);
    remaining -= chunk.length + 1;
  }
  return chunks.join('\n');
}

async function fingerprint(directory, options = {}) {
  const result = {};
  const scan = await scanInventory(directory, options);
  const reasons = [...scan.reasons];
  let remaining = options.maxBytes ?? 512 * 1024 * 1024;
  for (const filename of scan.files) {
    const target = path.join(directory, filename);
    try {
      const stat = await fs.stat(target);
      if (stat.size > remaining) { reasons.push(`文件哈希总量超过上限：${filename}`); break; }
      remaining -= stat.size;
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      const after = await fs.stat(target);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
        reasons.push(`扫描期间文件变化：${filename}`);
      } else result[filename] = hash.digest('hex');
    } catch (error) { reasons.push(`无法读取文件：${filename} (${error.code})`); }
  }
  return { version: 2, files: result, coverage: { complete: reasons.length === 0, reasons } };
}

async function sourceSnapshot(directory, maxBytes = 12000000) {
  const result = {};
  let remaining = maxBytes;
  for (const filename of await inventory(directory)) {
    if (!SOURCE.test(filename) || remaining <= 0) continue;
    const target = path.join(directory, filename);
    const stat = await fs.stat(target);
    if (stat.size > 512000 || stat.size > remaining) continue;
    result[filename] = redact(await fs.readFile(target, 'utf8'));
    remaining -= stat.size;
  }
  return result;
}

function changedFiles(before, after) {
  const left = before.version === 2 ? before.files : before;
  const right = after.version === 2 ? after.files : after;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((name) => left[name] !== right[name]
      && (Object.hasOwn(left, name) || before.coverage?.complete !== false)
      && (Object.hasOwn(right, name) || after.coverage?.complete !== false))
    .map((name) => ({ path: name, status: !left[name] ? 'added' : !right[name] ? 'deleted' : 'modified' }));
}

module.exports = { inventory, scanInventory, validateProjectDirectory, assertComplete, makeContext, fingerprint, changedFiles, matchesScope, sourceSnapshot };
