'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProcess } = require('./process.cjs');
const { redact } = require('./contracts.cjs');
const {
  requestJson,
  resolveCodexExecutable,
  resolveClaudeExecutable,
  readClaudeSettingsMetadata,
  parseCodexAuthStatus
} = require('./discovery.cjs');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

function providerDefaultSettings() {
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

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const parsed = toNumber(value);
    if (parsed !== 0 || value === 0 || value === '0') {
      return parsed;
    }
  }
  return 0;
}

/**
 * Normalize token usage from Codex, Claude, or Ollama into the app contract.
 * The returned object always has numeric inputTokens/outputTokens/cachedTokens.
 *
 * @param {object} usage
 * @returns {{ inputTokens: number, outputTokens: number, cachedTokens: number }}
 */
function normalizeUsage(usage = {}) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const inputTokens = firstNumber(
    source.input_tokens,
    source.inputTokens,
    source.prompt_tokens,
    source.promptTokens,
    source.prompt_eval_count,
    source.promptEvalCount
  );
  const outputTokens = firstNumber(
    source.output_tokens,
    source.outputTokens,
    source.completion_tokens,
    source.completionTokens,
    source.eval_count,
    source.evalCount
  );
  const cachedRead = firstNumber(
    source.cached_input_tokens,
    source.cachedInputTokens,
    source.cached_tokens,
    source.cachedTokens,
    source.cache_read_input_tokens,
    source.cacheReadInputTokens
  );
  const cachedWrite = firstNumber(
    source.cache_creation_input_tokens,
    source.cacheCreationInputTokens,
    source.cache_write_input_tokens,
    source.cacheWriteInputTokens
  );
  return {
    inputTokens: inputTokens + (source.cache_read_input_tokens !== undefined || source.cache_creation_input_tokens !== undefined ? cachedRead + cachedWrite : 0),
    outputTokens,
    cachedTokens: cachedRead
  };
}

function sanitizeText(text) {
  return redact(String(text || ''))
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)(["']?\s*[:=]\s*["']?)[^,\s"'}]+/gi, '$1$2[redacted]');
}

function sanitizeErrorText(text) {
  const singleLine = String(text || '').replace(/\s+/g, ' ').trim();
  const redacted = sanitizeText(singleLine);
  return redacted.length > 600 ? `${redacted.slice(0, 600)}...` : redacted;
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function hasTokenFields(source) {
  if (!source || typeof source !== 'object') {
    return false;
  }
  return [
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'cached_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'prompt_eval_count',
    'eval_count'
  ].some((key) => source[key] !== undefined && source[key] !== null);
}

function pickUsage(source) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  for (const key of ['usage', 'token_usage', 'usage_metadata', 'tokenUsage']) {
    if (source[key] && typeof source[key] === 'object' && hasTokenFields(source[key])) {
      return source[key];
    }
  }
  if (hasTokenFields(source)) {
    return source;
  }
  return null;
}

function extractClaudeText(source) {
  if (typeof source === 'string') {
    return source;
  }
  if (!source || typeof source !== 'object') {
    return null;
  }

  if (typeof source.text === 'string') {
    return source.text;
  }
  if (typeof source.result === 'string') {
    return source.result;
  }
  if (typeof source.content === 'string') {
    return source.content;
  }
  if (typeof source.output === 'string') {
    return source.output;
  }
  if (typeof source.response === 'string') {
    return source.response;
  }

  if (Array.isArray(source.content)) {
    const parts = source.content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (!block || typeof block !== 'object') {
          return null;
        }
        if (typeof block.text === 'string') {
          return block.text;
        }
        if (typeof block.content === 'string') {
          return block.content;
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  if (source.message && typeof source.message === 'object') {
    return extractClaudeText(source.message);
  }
  if (source.result && typeof source.result === 'object') {
    return extractClaudeText(source.result);
  }
  return null;
}

function extractErrorMessage(source) {
  if (!source) {
    return null;
  }
  if (typeof source === 'string') {
    return source;
  }
  if (source.error) {
    if (typeof source.error === 'string') {
      return source.error;
    }
    if (source.error.message) {
      return source.error.message;
    }
  }
  if (source.message) {
    return source.message;
  }
  if (source.result && typeof source.result === 'string') {
    return source.result;
  }
  return null;
}

/**
 * Parse Claude `--output-format json` or `stream-json` output.
 * Returns text, normalized usage, and error state. Never throws on malformed
 * output; callers decide whether missing final text is fatal.
 *
 * @param {string} stdout
 * @returns {{ text: string | null, usage: object, isError: boolean, error: string | null }}
 */
function parseClaudeOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    return { text: null, usage: emptyUsage(), isError: false, error: null };
  }

  try {
    const single = JSON.parse(trimmed);
    const usage = pickUsage(single) || pickUsage(single.result);
    return {
      text: single.type === 'result' ? extractClaudeText(single) : null,
      structured: single.type === 'result' ? single.structured_output : undefined,
      usage: normalizeUsage(usage || {}),
      isError: Boolean(single.is_error || single.isError || single.type === 'error' || single.subtype === 'error' || single.error),
      error: extractErrorMessage(single)
    };
  } catch {
    // Fall through to stream-json/JSONL parsing.
  }

  let text = null;
  let usage = emptyUsage();
  let isError = false;
  let error = null;
  let completed = false;
  let structured;

  for (const line of trimmed.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') {
      continue;
    }

    if (event.type === 'result' || event.subtype === 'result') {
      completed = !event.is_error && !event.isError && !event.error;
      const eventText = extractClaudeText(event);
      structured = event.structured_output;
      if (eventText !== null) {
        text = eventText;
      }
      if (event.is_error || event.isError || event.error) {
        isError = true;
        error = extractErrorMessage(event);
      }
      const eventUsage = pickUsage(event);
      if (eventUsage) {
        usage = normalizeUsage(eventUsage);
      }
    }

    if (event.type === 'assistant' || event.type === 'message') {
      const eventText = extractClaudeText(event);
      if (eventText !== null) {
        text = eventText;
      }
      const eventUsage = pickUsage(event);
      if (eventUsage) {
        usage = normalizeUsage(eventUsage);
      }
    }

    if (event.type === 'error') {
      isError = true;
      error = extractErrorMessage(event);
    }
  }

  return { text: completed ? text : null, structured: completed ? structured : undefined, usage, isError, error };
}

function parseStructuredJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    throw new Error('Provider returned invalid structured JSON');
  }
}

function extractAgentMessageText(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.content === 'string') {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        if (!block || typeof block !== 'object') {
          return null;
        }
        if (typeof block.text === 'string') {
          return block.text;
        }
        if (typeof block.content === 'string') {
          return block.content;
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  if (typeof item.message === 'string') {
    return item.message;
  }
  return null;
}

/**
 * Parse Codex `exec --json` JSONL output.
 * Captures only `item.completed` agent messages as final text, rejects nothing
 * here (turn.failed is reported for the caller), and normalizes usage.
 *
 * @param {string} stdout
 * @returns {{ events: Array<object>, text: string | null, usage: object, model: string | null, failed: string | null }}
 */
function parseCodexJsonl(stdout) {
  const events = [];
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines; a missing final text still fails at the end.
    }
  }

  let text = null;
  let usage = emptyUsage();
  let model = null;
  let failed = null;
  let completed = false;

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }

    if (event.type === 'turn.failed') {
      failed = extractErrorMessage(event) || 'Codex turn failed';
    }

    if (event.type === 'turn.completed') {
      completed = true;
      const eventUsage = pickUsage(event);
      if (eventUsage) {
        usage = normalizeUsage(eventUsage);
      }
      if (text === null && typeof event.last_agent_message === 'string') {
        text = event.last_agent_message;
      }
      if (model === null) {
        model = event.model || event.model_slug || event.modelSlug || null;
      }
    }

    if (event.type === 'item.completed') {
      const item = event.item || event;
      if (item && (item.type === 'agent_message' || item.role === 'agent' || item.role === 'assistant')) {
        const candidate = extractAgentMessageText(item);
        if (candidate !== null && candidate !== '') {
          text = candidate;
        }
      }
    }

    if (model === null) {
      model = event.model || event.model_slug || event.modelSlug || null;
    }
  }

  return { events, text: completed && !failed ? text : null, usage, model, failed };
}

/**
 * Parse a non-stream Ollama /api/chat response. Thinking is measured separately
 * and never included in text.
 *
 * @param {object} payload
 * @param {object} [schema]
 * @returns {{ text: string, structured?: object, usage: object, model: string, thinkingChars: number }}
 */
function parseOllamaChatResponse(payload, schema) {
  if (payload?.done === false || payload?.done_reason === 'length') {
    throw new Error('Ollama 输出尚未完成或达到输出上限，不能作为有效交接。请缩小任务或改由 DeepSeek 执行。');
  }
  if (!payload || payload.error) {
    throw new Error(payload && payload.error ? sanitizeErrorText(payload.error) : 'Ollama returned an empty response');
  }

  const message = payload.message || {};
  const content = message.content;
  const text = typeof content === 'string' ? content : (content ? JSON.stringify(content) : '');
  if (!text) {
    throw new Error('Ollama response contained no assistant message content');
  }

  let structured;
  if (schema) {
    structured = parseStructuredJson(text);
  }

  return {
    text,
    structured,
    usage: normalizeUsage({
      input_tokens: payload.prompt_eval_count,
      output_tokens: payload.eval_count
    }),
    model: payload.model || null,
    thinkingChars: typeof message.thinking === 'string' ? message.thinking.length : 0
  };
}

/**
 * Create provider adapters.
 *
 * @param {object} [settings]
 * @param {(event: object) => void} [emit]
 * @param {object} [deps] Test seams; production callers can omit this argument.
 * @returns {{ codex: { run: Function }, deepseek: { run: Function }, qwen: { run: Function } }}
 */
function createProviders(settings = {}, emit = () => {}, deps = {}) {
  const merged = { ...providerDefaultSettings(), ...settings };
  const run = deps.runProcess || runProcess;
  const httpJson = deps.httpJson || requestJson;
  const resolveCodex = deps.resolveCodexExecutable || resolveCodexExecutable;
  const resolveClaude = deps.resolveClaudeExecutable || resolveClaudeExecutable;
  const readClaudeMeta = deps.readClaudeSettingsMetadata || readClaudeSettingsMetadata;
  const mkdtemp = deps.mkdtemp || fs.promises.mkdtemp;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const rm = deps.rm || fs.promises.rm;

  const safeEmit = (event) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    if (!['log', 'delta', 'usage'].includes(event.type)) {
      return;
    }
    const copy = { ...event };
    if (copy.message !== undefined) {
      copy.message = sanitizeText(String(copy.message));
    }
    if (copy.delta !== undefined) {
      copy.delta = sanitizeText(String(copy.delta));
    }
    if (copy.usage !== undefined) {
      copy.usage = normalizeUsage(copy.usage);
    }
    try {
      emit(copy);
    } catch {
      // Emit is observational; provider execution must not fail because an
      // observer threw.
    }
  };

  const timeoutMsFor = () => {
    const minutes = Number(merged.timeoutMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000;
  };

  const ensureCodexChatGPT = async (codexCommand, cwd, signal) => {
    const result = await run(codexCommand, ['login', 'status'], {
      cwd,
      signal,
      timeoutMs: 8000
    });
    if (result.code !== 0) {
      throw new Error(`Codex login status failed with code ${result.code}`);
    }
    const auth = parseCodexAuthStatus(`${result.stdout}\n${result.stderr}`);
    if (auth.authMode !== 'chatgpt') {
      throw new Error('Codex must be logged in with ChatGPT subscription authentication; API-key billing is not allowed');
    }
    return auth;
  };

  const createTempSchemaFile = async (schema) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-codex-'));
    const schemaPath = path.join(tempDir, 'schema.json');
    await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    return { tempDir, schemaPath };
  };

  const runCodex = async ({ prompt, cwd, signal, schema, writable }) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new TypeError('codex.run requires a non-empty prompt string');
    }
    if (!cwd) {
      throw new TypeError('codex.run requires cwd');
    }

    const codexCommand = resolveCodex(merged);
    if (!codexCommand) {
      throw new Error('Codex executable not found');
    }

    const timeoutMs = timeoutMsFor();
    safeEmit({ type: 'log', provider: 'codex', message: 'Checking Codex ChatGPT login' });
    await ensureCodexChatGPT(codexCommand, cwd, signal);

    const args = [
      'exec',
      '--json',
      '--color', 'never',
      '--skip-git-repo-check',
      '--ephemeral',
      '--cd', cwd
    ];

    if (writable) {
      args.push('--approve-for-me');
    } else {
      args.push('--sandbox', 'read-only', '-c', 'approval_policy="never"');
    }

    if (merged.gptModel) {
      args.push('--model', merged.gptModel);
    }
    if (merged.gptEffort) {
      args.push('-c', `model_reasoning_effort="${merged.gptEffort}"`);
    }
    // Never fall back to API-key billing. These are configuration overrides,
    // not dangerous approval bypass flags.
    args.push('-c', 'forced_login_method="chatgpt"');
    args.push('-c', 'model_provider="openai"');

    let temp;
    if (schema) {
      temp = await createTempSchemaFile(schema);
      args.push('--output-schema', temp.schemaPath);
    }

    safeEmit({ type: 'log', provider: 'codex', message: 'Running Codex exec' });
    try {
      args.push('-');
      const result = await run(codexCommand, args, {
        cwd, signal, timeoutMs, input: prompt,
        env: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
        onLine: (line) => {
          try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') safeEmit({ type: 'delta', provider: 'gpt', message: event.item.text });
            if (event.type === 'item.started' && event.item?.type === 'command_execution' && event.item.command) safeEmit({ type: 'log', provider: 'gpt', message: event.item.command });
          } catch {}
        },
      });
      if (result.code !== 0) {
        throw new Error(`Codex exited with code ${result.code}: ${sanitizeErrorText(result.stderr || result.stdout)}`);
      }

      const parsed = parseCodexJsonl(result.stdout);
      if (parsed.failed) {
        throw new Error(`Codex turn failed: ${sanitizeErrorText(parsed.failed)}`);
      }
      if (parsed.text === null || parsed.text === '') {
        throw new Error('Codex completed without final agent text');
      }

      const structured = schema ? parseStructuredJson(parsed.text) : undefined;
      const usage = normalizeUsage(parsed.usage);
      const model = parsed.model || merged.gptModel || 'codex-default';

      safeEmit({ type: 'usage', provider: 'codex', usage });
      safeEmit({ type: 'log', provider: 'codex', message: 'Codex run completed' });
      return { text: parsed.text, structured, usage, model, provider: 'codex' };
    } finally {
      if (temp) {
        await rm(temp.tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  const runDeepseek = async ({ prompt, cwd, signal, schema, writable }) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new TypeError('deepseek.run requires a non-empty prompt string');
    }
    if (!cwd) {
      throw new TypeError('deepseek.run requires cwd');
    }

    const claudeCommand = resolveClaude(merged);
    if (!claudeCommand) {
      throw new Error('Claude Code executable not found');
    }

    const metadata = readClaudeMeta(merged);
    if (!metadata.configured) {
      throw new Error('Claude Code DeepSeek settings are not configured; configure env in settings.json without storing secrets in app settings');
    }

    const model = metadata.model || merged.deepseekModel;
    const args = [
      '--bare', '--no-session-persistence',
      '--print',
      '--output-format', 'json',
      '--settings', metadata.settingsPath,
      '--model', model,
      '--add-dir', cwd,
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none'
    ];
    args.push('--allowedTools', writable ? 'Read,Write,Edit,Bash,Glob,Grep' : 'Read,Glob,Grep');
    if (!writable) args.push('--tools', 'Read,Glob,Grep');

    if (schema) {
      args.push('--json-schema', JSON.stringify(schema));
    }

    safeEmit({ type: 'log', provider: 'deepseek', message: 'Running Claude Code with DeepSeek settings' });
    const result = await run(claudeCommand, args, { cwd, signal, input: prompt, timeoutMs: timeoutMsFor() });

    if (result.code !== 0) {
      throw new Error(`Claude Code exited with code ${result.code}: ${sanitizeErrorText(result.stderr || result.stdout)}`);
    }

    const parsed = parseClaudeOutput(result.stdout);
    if (parsed.isError) {
      throw new Error(`Claude Code returned an error: ${sanitizeErrorText(parsed.error || result.stderr || result.stdout)}`);
    }
    if ((parsed.text === null || parsed.text === '') && !(schema && parsed.structured)) {
      throw new Error('Claude Code completed without result text');
    }

    const structured = schema ? (parsed.structured || parseStructuredJson(parsed.text)) : undefined;
    safeEmit({ type: 'usage', provider: 'deepseek', usage: parsed.usage });
    safeEmit({ type: 'log', provider: 'deepseek', message: 'Claude Code run completed' });
    return {
      text: structured ? JSON.stringify(structured) : parsed.text,
      structured,
      usage: parsed.usage,
      model,
      provider: 'deepseek'
    };
  };

  const runQwen = async ({ prompt, cwd, signal, schema, writable, thinking = false }) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new TypeError('qwen.run requires a non-empty prompt string');
    }

    const baseUrl = merged.ollamaUrl || DEFAULT_OLLAMA_URL;
    const url = new URL('/api/chat', baseUrl);
    const options = qwenOptions(prompt, schema, thinking);
    const body = {
      model: merged.qwenModel,
      messages: [{ role: 'user', content: prompt }],
      options,
      think: thinking === true,
      keep_alive: '15m',
      stream: false
    };
    if (schema) {
      body.format = schema;
    }

    safeEmit({ type: 'log', provider: 'qwen', message: `Qwen 上下文 ${options.num_ctx / 1024}K；思考${thinking ? '开启' : '关闭'}；发送 Ollama 请求` });
    const payload = await httpJson(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: timeoutMsFor()
    });

    const parsed = parseOllamaChatResponse(payload, schema);
    if (parsed.thinkingChars > 0) {
      safeEmit({ type: 'log', provider: 'qwen', message: `Ollama returned ${parsed.thinkingChars} thinking characters separately` });
    }

    safeEmit({ type: 'usage', provider: 'qwen', usage: parsed.usage });
    return {
      text: parsed.text,
      structured: parsed.structured,
      usage: parsed.usage,
      model: parsed.model || merged.qwenModel,
      performance: {
        contextTokens: options.num_ctx, thinking: thinking === true,
        totalMs: Number(payload.total_duration || 0) / 1e6,
        loadMs: Number(payload.load_duration || 0) / 1e6,
        promptMs: Number(payload.prompt_eval_duration || 0) / 1e6,
        generationMs: Number(payload.eval_duration || 0) / 1e6,
      },
      provider: 'qwen'
    };
  };

  return {
    codex: { run: runCodex },
    deepseek: { run: runDeepseek },
    qwen: { run: runQwen }
  };
}

function qwenOptions(prompt, schema, thinking = false) {
  // UTF-8 byte count is a conservative upper bound for Qwen's byte-level tokens.
  // Include schema and template overhead; never silently trim the request.
  const outputTokens = thinking ? 4096 : 2048;
  const needed = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify(schema || {}), 'utf8') + 512 + outputTokens;
  const context = [8192, 16384, 32768].find((size) => size >= needed);
  if (!context) throw new Error('Qwen 输入超过安全上下文容量，请缩小任务材料或交由 DeepSeek 处理；未截断输入。');
  return { num_ctx: context, num_predict: outputTokens };
}

module.exports = {
  qwenOptions,
  createProviders,
  parseCodexJsonl,
  parseClaudeOutput,
  parseOllamaChatResponse,
  parseStructuredJson,
  normalizeUsage,
  sanitizeText,
  sanitizeErrorText
};
