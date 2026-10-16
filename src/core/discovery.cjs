'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { runProcess, killProcessTree } = require('./process.cjs');
const { bundledCodex } = require('./runtime.cjs');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

function defaultSettings() {
  return {
    codexCommand: '',
    gptModel: '',
    gptEffort: 'high',
    claudeCommand: '',
    deepseekModel: 'deepseek-v4-pro',
    claudeSettingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
    ollamaUrl: DEFAULT_OLLAMA_URL,
    qwenModel: 'qwen3:8b',
    maxReviewRounds: 3,
    timeoutMinutes: 60
  };
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function localAppDataRoot() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function findExecutableOnPath(exeName) {
  const searchPath = process.env.PATH || '';
  const hasExtension = path.extname(exeName) !== '';
  const extensions = hasExtension
    ? ['']
    : (process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']);
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, exeName + ext);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function codexVendorCandidates() {
  const root = path.join(appDataRoot(), 'npm', 'node_modules', '@openai', 'codex');
  const variants = [
    { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
    { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
  ];
  const candidates = [];
  for (const variant of variants) {
    candidates.push(path.join(root, 'node_modules', variant.pkg, 'vendor', variant.triple, 'bin', 'codex.exe'));
    candidates.push(path.join(root, 'vendor', variant.triple, 'bin', 'codex.exe'));
  }
  return candidates;
}

/**
 * Resolve the Codex executable from settings, npm vendor directories, or PATH.
 * Returns null when no usable native binary is found.
 *
 * @param {object} [settings]
 * @returns {string | null}
 */
function resolveCodexExecutable(settings = {}) {
  if (settings.codexCommand && settings.codexCommand.trim()) {
    return settings.codexCommand.trim();
  }

  for (const candidate of [bundledCodex(), path.join(localAppDataRoot(), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), path.join(os.homedir(), '.local', 'bin', 'codex.exe')]) {
    if (isFile(candidate)) return candidate;
  }

  for (const candidate of codexVendorCandidates()) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return findExecutableOnPath(process.platform === 'win32' ? 'codex.exe' : 'codex');
}

function compareVersions(a, b) {
  const aParts = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function findClaudeUnderBase(baseDir) {
  if (!fs.existsSync(baseDir)) {
    return null;
  }

  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const versionEntry of entries) {
    if (!versionEntry.isDirectory()) {
      continue;
    }
    const versionDir = path.join(baseDir, versionEntry.name);
    const directExe = path.join(versionDir, 'claude.exe');
    if (isFile(directExe)) {
      candidates.push({ command: directExe, version: versionEntry.name });
      continue;
    }

    let hashEntries;
    try {
      hashEntries = fs.readdirSync(versionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const hashEntry of hashEntries) {
      if (!hashEntry.isDirectory()) {
        continue;
      }
      const exe = path.join(versionDir, hashEntry.name, 'claude.exe');
      if (isFile(exe)) {
        candidates.push({ command: exe, version: versionEntry.name });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version);
    return byVersion !== 0 ? byVersion : a.command.localeCompare(b.command);
  });
  return candidates[0];
}

/**
 * Resolve the Claude Code executable from settings, the per-user installation
 * tree, or PATH.
 *
 * @param {object} [settings]
 * @returns {string | null}
 */
function resolveClaudeExecutable(settings = {}) {
  if (settings.claudeCommand && settings.claudeCommand.trim()) {
    return settings.claudeCommand.trim();
  }

  const baseDir = path.join(localAppDataRoot(), 'Claude-3p', 'claude-code');
  const local = findClaudeUnderBase(baseDir);
  if (local) {
    return local.command;
  }

  return findExecutableOnPath(process.platform === 'win32' ? 'claude.exe' : 'claude');
}

function parseCodexVersion(output) {
  const text = String(output || '').trim();
  const match = text.match(/(?:codex-cli|codex)\s+(\d+\.\d+\.\d+)/i) || text.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : text || null;
}

function parseCodexAuthStatus(output) {
  const text = String(output || '').toLowerCase();
  if (/not logged in/.test(text)) {
    return { authenticated: false, authMode: null };
  }
  if (/chatgpt/.test(text)) {
    return { authenticated: true, authMode: 'chatgpt' };
  }
  if (/api[ -]?key|apikey/.test(text)) {
    return { authenticated: true, authMode: 'api_key' };
  }
  if (/logged in/.test(text)) {
    return { authenticated: true, authMode: 'unknown' };
  }
  return { authenticated: false, authMode: null };
}

/**
 * Read only the DeepSeek routing/model metadata from a Claude settings file.
 * Secret values are checked for presence but never returned.
 *
 * @param {object} settings
 * @returns {{ configured: boolean, baseUrl: string | null, model: string, settingsPath: string, error?: string }}
 */
function readClaudeSettingsMetadata(settings) {
  const settingsPath = settings.claudeSettingsPath || defaultSettings().claudeSettingsPath;
  const fallbackModel = settings.deepseekModel || defaultSettings().deepseekModel;
  const base = { configured: false, baseUrl: null, model: fallbackModel, settingsPath };

  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return base;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, error: 'Claude settings file is not valid JSON' };
  }

  const env = parsed && typeof parsed === 'object' ? parsed.env : null;
  if (!env || typeof env !== 'object') {
    return base;
  }

  const configuredUrl = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL
    ? env.ANTHROPIC_BASE_URL
    : (typeof env.ANTHROPIC_API_BASE_URL === 'string' ? env.ANTHROPIC_API_BASE_URL : null);
  let baseUrl = null;
  try {
    const url = new URL(configuredUrl);
    if (['http:', 'https:'].includes(url.protocol)) {
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      baseUrl = url.toString().replace(/\/$/, '');
    }
  } catch {}

  const hasAuth = (
    (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0) ||
    (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0)
  );

  const model = settings.deepseekModel || (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL) || fallbackModel;

  return {
    configured: Boolean(baseUrl && hasAuth && model),
    baseUrl,
    model,
    settingsPath
  };
}

function sanitizeHttpError(error) {
  if (!error) {
    return 'Unknown HTTP error';
  }
  if (error && error.name === 'AbortError') {
    return 'Request aborted';
  }
  const message = String(error.message || error).replace(/\s+/g, ' ').trim();
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs === undefined ? 8000 : options.timeoutMs;
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, {
      method,
      headers: options.headers || {}
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        cleanup();
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (!body) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON response from ${parsed.href}`));
          }
          return;
        }
        const detail = body.replace(/\s+/g, ' ').trim();
        reject(new Error(`HTTP ${response.statusCode} ${method} ${parsed.href}${detail ? `: ${detail.slice(0, 400)}` : ''}`));
      });
    });

    let timer = null;
    const onAbort = () => {
      request.destroy(new Error('Aborted'));
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    request.on('error', (error) => {
      cleanup();
      reject(error);
    });

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(new Error('Aborted'));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      request.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (options.body !== undefined && options.body !== null) {
      request.write(options.body);
    }
    request.end();
  });
}

/**
 * Minimal newline-delimited JSON-RPC client for `codex app-server --stdio`.
 * Writes requests sequentially, waiting for each matching id before continuing.
 * This mirrors the app-server's stdio transport and never touches auth.json.
 *
 * @param {string} command
 * @param {Array<object>} requests
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<Array<object>>}
 */
function codexAppServerRpc(command, requests, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 8000 : options.timeoutMs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let settled = false;
    let currentIndex = 0;
    let timer = null;
    const responses = [];

    const onAbort = () => {
      fail(new Error('Codex app-server request aborted'));
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(error);
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(responses);
    };

    timer = setTimeout(() => {
      timer = null;
      fail(new Error(`Codex app-server request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        fail(new Error('Codex app-server request aborted'));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (settled || currentIndex >= requests.length) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // The app-server can emit non-JSON diagnostics on stdout; those lines
        // are not part of the RPC stream and are safe to ignore.
        return;
      }

      const expected = requests[currentIndex];
      if (!message || message.id !== expected.id) {
        // Notifications and unrelated responses are ignored.
        return;
      }

      if (message.error) {
        fail(new Error(`Codex app-server error for ${expected.method}: ${sanitizeHttpError(message.error.message || message.error)}`));
        return;
      }

      responses[currentIndex] = message;
      currentIndex += 1;

      if (currentIndex >= requests.length) {
        child.stdin.end();
        killProcessTree(child);
        succeed();
        return;
      }

      child.stdin.write(JSON.stringify(requests[currentIndex]) + '\n');
    });

    child.on('error', (error) => {
      fail(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      if (currentIndex >= requests.length && responses.length === requests.length) {
        succeed();
        return;
      }
      fail(new Error(`Codex app-server closed before responding (code ${code})${stderr ? `: ${sanitizeHttpError(stderr)}` : ''}`));
    });

    child.stdin.on('error', () => {
      // The app-server may exit early. The close handler owns the final result.
    });
    child.stdin.write(JSON.stringify(requests[0]) + '\n');
  });
}

function normalizeCodexModel(model) {
  const id = model.id || model.model || model.slug || null;
  return {
    id,
    model: model.model || id,
    displayName: model.displayName || model.display_name || id,
    isDefault: Boolean(model.isDefault || model.is_default),
    defaultReasoningEffort: model.defaultReasoningEffort || model.default_reasoning_effort || null,
    reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort || entry.reasoning_effort).filter(Boolean)
      : (Array.isArray(model.supported_reasoning_efforts)
        ? model.supported_reasoning_efforts.map((entry) => entry.reasoningEffort || entry.reasoning_effort).filter(Boolean)
        : [])
  };
}

async function codexAppServerModelList(command, options = {}) {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-studio', version: '0.1.0' },
        capabilities: {}
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'model/list',
      params: {}
    }
  ];

  const responses = await codexAppServerRpc(command, requests, options);
  const modelResponse = responses[1];
  const data = modelResponse && modelResponse.result && modelResponse.result.data;
  if (!Array.isArray(data)) {
    throw new Error('Codex model/list returned no model array');
  }
  return data.map(normalizeCodexModel).filter((model) => model.id);
}

async function fetchOllama(baseUrl, endpoint, options = {}) {
  return requestJson(new URL(endpoint, baseUrl), {
    method: 'GET',
    timeoutMs: options.timeoutMs === undefined ? 1500 : options.timeoutMs,
    signal: options.signal
  });
}

function ollamaNames(payload, key) {
  const list = payload && payload[key];
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry && (entry.name || entry.model || entry.id)))
    .filter(Boolean)
    .sort();
}

/**
 * Discover installed providers.
 *
 * @param {object} [settings]
 * @returns {Promise<{
 *   codex: object,
 *   deepseek: object,
 *   ollama: object
 * }>}
 */
async function discover(settings = {}) {
  const merged = { ...defaultSettings(), ...settings };
  const result = {
    codex: { available: false, authenticated: false, authMode: null, command: null, version: null },
    deepseek: { available: false, configured: false, command: null, model: merged.deepseekModel, baseUrl: null },
    ollama: { available: false, models: [], loaded: [], baseUrl: merged.ollamaUrl }
  };

  // Codex executable discovery, version, and subscription auth.
  try {
    const codexCommand = resolveCodexExecutable(merged);
    if (!codexCommand) {
      result.codex.error = 'Codex executable not found in PATH or npm vendor directories';
    } else {
      result.codex.command = codexCommand;

      const versionResult = await runProcess(codexCommand, ['--version'], { timeoutMs: 5000 });
      if (versionResult.code === 0) {
        result.codex.version = parseCodexVersion(versionResult.stdout);
        result.codex.available = true;
      } else {
        result.codex.error = `Codex --version failed with code ${versionResult.code}`;
      }

      if (result.codex.available) {
        const authResult = await runProcess(codexCommand, ['login', 'status'], { timeoutMs: 8000 });
        // Codex reports normal login status on stderr, so inspect both streams.
        const auth = parseCodexAuthStatus(`${authResult.stdout}\n${authResult.stderr}`);
        result.codex.authenticated = auth.authenticated;
        result.codex.authMode = auth.authMode;

        if (auth.authenticated && auth.authMode === 'chatgpt') {
          try {
            result.codex.models = await codexAppServerModelList(codexCommand, { timeoutMs: 8000 });
          } catch (error) {
            result.codex.models = undefined;
            result.codex.error = `Codex model catalog unavailable: ${sanitizeHttpError(error)}`;
          }
        }
      }
    }
  } catch (error) {
    result.codex.available = false;
    result.codex.authenticated = false;
    result.codex.authMode = null;
    result.codex.error = sanitizeHttpError(error);
  }

  // Claude Code (DeepSeek) executable and settings metadata.
  try {
    const claudeCommand = resolveClaudeExecutable(merged);
    result.deepseek.command = claudeCommand;
    result.deepseek.available = Boolean(claudeCommand && isFile(claudeCommand));
    if (!result.deepseek.available) {
      result.deepseek.error = 'Claude Code executable not found in PATH or %LOCALAPPDATA%/Claude-3p/claude-code';
    }
    const metadata = readClaudeSettingsMetadata(merged);
    result.deepseek.configured = metadata.configured;
    result.deepseek.model = metadata.model;
    result.deepseek.baseUrl = metadata.baseUrl;
    if (metadata.error) {
      result.deepseek.error = metadata.error;
    }
  } catch (error) {
    result.deepseek.available = false;
    result.deepseek.configured = false;
    result.deepseek.error = sanitizeHttpError(error);
  }

  // Ollama catalog and loaded models. A connection failure here is a normal
  // "Ollama is not running" state, not an exception from discover().
  try {
    const tags = await fetchOllama(merged.ollamaUrl, '/api/tags');
    result.ollama.available = true;
    result.ollama.models = ollamaNames(tags, 'models');
    try {
      const ps = await fetchOllama(merged.ollamaUrl, '/api/ps');
      result.ollama.loaded = ollamaNames(ps, 'models');
    } catch {
      result.ollama.loaded = [];
    }
  } catch (error) {
    result.ollama.available = false;
    result.ollama.models = [];
    result.ollama.loaded = [];
    result.ollama.error = sanitizeHttpError(error);
  }

  return result;
}

module.exports = {
  discover,
  defaultSettings,
  resolveCodexExecutable,
  resolveClaudeExecutable,
  readClaudeSettingsMetadata,
  parseCodexAuthStatus,
  parseCodexVersion,
  requestJson,
  codexAppServerRpc,
  codexAppServerModelList,
  normalizeCodexModel
};
