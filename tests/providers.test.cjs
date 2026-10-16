'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCommand, runProcess, ProcessTimeoutError, ProcessAbortError } = require('../src/core/process.cjs');
const { resolveCodexExecutable } = require('../src/core/discovery.cjs');
const {
  createProviders,
  parseCodexJsonl,
  parseClaudeOutput,
  parseOllamaChatResponse,
  parseStructuredJson,
  normalizeUsage,
  sanitizeText
} = require('../src/core/providers.cjs');

test('resolveCommand resolves npm to the native Node entry point', () => {
  const resolved = resolveCommand('npm');
  assert.equal(resolved.command, process.execPath);
  assert.match(resolved.argsPrefix[0], /npm-cli\.js$/);
});

test('resolveCommand rejects unknown shell wrappers instead of spawning cmd.exe', () => {
  assert.throws(() => resolveCommand('C:\\Tools\\mystery.cmd'), /Refusing to spawn unknown shell wrapper/);
});

test('resolveCommand leaves a normal executable untouched', () => {
  const exe = process.execPath;
  assert.deepEqual(resolveCommand(exe), { command: exe, argsPrefix: [] });
});

test('runProcess writes UTF-8 stdin and collects stdout/stderr', async () => {
  const script = [
    "let s = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { s += d; });",
    "process.stdin.on('end', () => { console.log(s.toUpperCase()); console.error('done'); });"
  ].join('');
  const result = await runProcess(process.execPath, ['-e', script], { input: 'héllo' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /HÉLLO/);
  assert.match(result.stderr, /done/);
});

test('runProcess emits complete stdout lines to onLine', async () => {
  const lines = [];
  await runProcess(process.execPath, ['-e', 'console.log("one"); console.log("two")'], {
    onLine: (line) => lines.push(line)
  });
  assert.deepEqual(lines, ['one', 'two']);
});

test('runProcess exposes stderr progress before process completion without mixing stdout', async () => {
  let progress = '';
  const result = await runProcess(process.execPath, ['-e', 'process.stderr.write("DEVICE-CODE");setTimeout(()=>console.log("done"),50)'], {
    onStderr: (chunk) => { progress += chunk; },
  });
  assert.equal(progress, 'DEVICE-CODE');
  assert.equal(result.stderr, 'DEVICE-CODE');
  assert.equal(result.stdout.trim(), 'done');
});

test('runProcess times out and rejects with ProcessTimeoutError', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }),
    (error) => error instanceof ProcessTimeoutError
  );
});

test('runProcess aborts through AbortController and rejects with ProcessAbortError', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error) => error instanceof ProcessAbortError);
});

test('excessive command output fails visibly instead of exhausting memory', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000);'], { maxOutputBytes: 1024 }), /输出超过限制/);
});

test('normalizeUsage maps provider token fields to the app contract', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    output_tokens: 4,
    cached_input_tokens: 3
  }), { inputTokens: 10, outputTokens: 4, cachedTokens: 3 });

  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 5
  }), { inputTokens: 17, outputTokens: 4, cachedTokens: 2 });
});

test('parseCodexJsonl captures only item.completed agent_message text and normalizes usage', () => {
  const stdout = [
    JSON.stringify({ type: 'turn.started', turn_id: '1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 4 } })
  ].join('\n');

  const parsed = parseCodexJsonl(stdout);
  assert.equal(parsed.text, 'final answer');
  assert.deepEqual(parsed.usage, { inputTokens: 12, outputTokens: 3, cachedTokens: 4 });
  assert.equal(parsed.failed, null);
});

test('parseCodexJsonl reports turn.failed and returns null when no agent message exists', () => {
  const failed = parseCodexJsonl(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }));
  assert.equal(failed.failed, 'boom');
  assert.equal(failed.text, null);
});

test('parseClaudeOutput handles single JSON result output', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'claude answer',
    usage: {
      input_tokens: 7,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3
    }
  });
  const parsed = parseClaudeOutput(stdout);
  assert.equal(parsed.text, 'claude answer');
  assert.equal(parsed.isError, false);
  assert.deepEqual(parsed.usage, { inputTokens: 12, outputTokens: 5, cachedTokens: 2 });
});

test('parseClaudeOutput handles stream-json lines and error inspection', () => {
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'streamed answer' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'final answer', usage: { input_tokens: 4, output_tokens: 2 } })
  ].join('\n');
  const parsed = parseClaudeOutput(stdout);
  assert.equal(parsed.text, 'final answer');
  assert.equal(parsed.isError, false);

  const errorOut = JSON.stringify({ type: 'result', is_error: true, result: 'request failed' });
  const errorParsed = parseClaudeOutput(errorOut);
  assert.equal(errorParsed.isError, true);
  assert.equal(errorParsed.error, 'request failed');
});

test('parseOllamaChatResponse keeps thinking separate and parses structured output', () => {
  const payload = {
    model: 'qwen3:8b',
    message: { role: 'assistant', content: '{"ok":true}', thinking: 'private reasoning' },
    prompt_eval_count: 9,
    eval_count: 4
  };
  const parsed = parseOllamaChatResponse(payload, { type: 'object' });
  assert.equal(parsed.text, '{"ok":true}');
  assert.deepEqual(parsed.structured, { ok: true });
  assert.deepEqual(parsed.usage, { inputTokens: 9, outputTokens: 4, cachedTokens: 0 });
  assert.equal(parsed.thinkingChars, 'private reasoning'.length);
});

test('parseStructuredJson accepts JSON and fenced JSON', () => {
  assert.deepEqual(parseStructuredJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseStructuredJson('```json\n{"b":2}\n```'), { b: 2 });
  assert.throws(() => parseStructuredJson('not json'), /invalid structured JSON/);
});

test('sanitizeText redacts common secret shapes', () => {
  const dirty = 'token sk-abc1234567890 and ANTHROPIC_AUTH_TOKEN: sk-secret and Bearer abc.def';
  const clean = sanitizeText(dirty);
  assert.doesNotMatch(clean, /sk-abc1234567890/);
  assert.doesNotMatch(clean, /sk-secret/);
  assert.doesNotMatch(clean, /abc\.def/);
});

test('codex.run enforces ChatGPT auth, passes safe sandbox flags, and parses JSONL', async () => {
  const calls = [];
  const events = [];
  const written = [];
  const removed = [];

  const codexOut = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"result":"ok"}' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 6 } })
  ].join('\n');

  const fakeRun = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'login' && args[1] === 'status') {
      return { stdout: '', stderr: 'Logged in using ChatGPT\n', code: 0 };
    }
    if (args[0] === 'exec') {
      return { stdout: codexOut, stderr: '', code: 0 };
    }
    throw new Error(`Unexpected run call: ${args.join(' ')}`);
  };

  const providers = createProviders(
    {
      codexCommand: 'C:\\Codex\\codex.exe',
      gptModel: 'gpt-6.1-sol',
      gptEffort: 'high',
      timeoutMinutes: 1
    },
    (event) => events.push(event),
    {
      runProcess: fakeRun,
      resolveCodexExecutable: () => 'C:\\Codex\\codex.exe',
      mkdtemp: async () => 'C:\\Temp\\agent-studio-codex-test',
      writeFile: async (file, data, encoding) => written.push({ file, data, encoding }),
      rm: async (dir) => removed.push(dir)
    }
  );

  const result = await providers.codex.run({
    prompt: 'do work',
    cwd: 'C:\\work',
    schema: { type: 'object' },
    writable: false
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.text, '{"result":"ok"}');
  assert.deepEqual(result.structured, { result: 'ok' });
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5, cachedTokens: 6 });
  assert.equal(result.model, 'gpt-6.1-sol');

  const execCall = calls.find((call) => call.args[0] === 'exec');
  assert.ok(execCall);
  assert.ok(execCall.args.includes('--json'));
  assert.equal(execCall.options.input, 'do work');
  assert.equal(execCall.args.includes('--ask-for-approval'), false);
  assert.ok(execCall.args.includes('--skip-git-repo-check'));
  assert.ok(execCall.args.includes('--sandbox'));
  assert.ok(execCall.args.includes('read-only'));
  assert.ok(execCall.args.includes('-c'));
  assert.ok(execCall.args.includes('forced_login_method="chatgpt"'));
  assert.ok(execCall.args.includes('model_provider="openai"'));
  assert.ok(execCall.args.includes('--output-schema'));
  assert.deepEqual(written, [{ file: 'C:\\Temp\\agent-studio-codex-test\\schema.json', data: '{"type":"object"}', encoding: 'utf8' }]);
  assert.deepEqual(removed, ['C:\\Temp\\agent-studio-codex-test']);
  assert.ok(events.some((event) => event.type === 'usage' && event.provider === 'codex'));
});

test('codex.run rejects non-ChatGPT authentication before execution', async () => {
  let execCalled = false;
  const fakeRun = async (command, args) => {
    if (args[0] === 'login' && args[1] === 'status') {
      return { stdout: '', stderr: 'Logged in using API key\n', code: 0 };
    }
    execCalled = true;
    return { stdout: '', stderr: '', code: 0 };
  };

  const providers = createProviders(
    { codexCommand: 'C:\\Codex\\codex.exe' },
    () => {},
    { runProcess: fakeRun, resolveCodexExecutable: () => 'C:\\Codex\\codex.exe' }
  );

  await assert.rejects(
    providers.codex.run({ prompt: 'do work', cwd: 'C:\\work' }),
    /ChatGPT subscription authentication/
  );
  assert.equal(execCalled, false);
});

test('installed Codex accepts writable automation flags without sandbox conflicts', async (t) => {
  const command = resolveCodexExecutable();
  if (!command) { t.skip('Codex is not installed'); return; }
  const result = await runProcess(command, ['exec', '--json', '--approve-for-me', '--skip-git-repo-check', '--ephemeral', '--help'], { timeoutMs: 15000 });
  assert.equal(result.code, 0, result.stderr);
});

test('codex.run rejects nonzero exit and never fabricates success', async () => {
  const fakeRun = async (command, args) => {
    if (args[0] === 'login' && args[1] === 'status') {
      return { stdout: '', stderr: 'Logged in using ChatGPT\n', code: 0 };
    }
    return { stdout: '', stderr: 'codex exploded', code: 2 };
  };

  const providers = createProviders(
    { codexCommand: 'C:\\Codex\\codex.exe' },
    () => {},
    { runProcess: fakeRun, resolveCodexExecutable: () => 'C:\\Codex\\codex.exe' }
  );

  await assert.rejects(
    providers.codex.run({ prompt: 'do work', cwd: 'C:\\work' }),
    /exited with code 2/
  );
});

test('deepseek.run passes settings path without leaking secrets and parses Claude JSON', async () => {
  const calls = [];
  const events = [];
  const stdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: '{"answer":"deepseek"}',
    usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 3 }
  });

  const providers = createProviders(
    {
      claudeCommand: 'C:\\Claude\\claude.exe',
      deepseekModel: 'deepseek-v4-pro',
      claudeSettingsPath: 'C:\\Users\\tester\\.claude\\settings.json',
      timeoutMinutes: 1
    },
    (event) => events.push(event),
    {
      runProcess: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout, stderr: '', code: 0 };
      },
      resolveClaudeExecutable: () => 'C:\\Claude\\claude.exe',
      readClaudeSettingsMetadata: () => ({
        configured: true,
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-pro',
        settingsPath: 'C:\\Users\\tester\\.claude\\settings.json'
      })
    }
  );

  const result = await providers.deepseek.run({
    prompt: 'implement feature',
    cwd: 'C:\\work',
    schema: { type: 'object' },
    writable: true
  });

  assert.equal(result.provider, 'deepseek');
  assert.equal(result.text, '{"answer":"deepseek"}');
  assert.deepEqual(result.structured, { answer: 'deepseek' });
  assert.deepEqual(result.usage, { inputTokens: 14, outputTokens: 2, cachedTokens: 3 });
  assert.equal(result.model, 'deepseek-v4-pro');

  const call = calls[0];
  assert.equal(call.options.input, 'implement feature');
  assert.equal(call.args.includes('implement feature'), false);
  assert.equal(call.command, 'C:\\Claude\\claude.exe');
  assert.ok(call.args.includes('--output-format'));
  assert.ok(call.args.includes('json'));
  assert.ok(call.args.includes('--settings'));
  assert.ok(call.args.includes('C:\\Users\\tester\\.claude\\settings.json'));
  assert.ok(call.args.includes('--json-schema'));
  const serialized = JSON.stringify(call.args);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(serialized, /ANTHROPIC_AUTH_TOKEN/);
  assert.ok(events.some((event) => event.type === 'usage' && event.provider === 'deepseek'));
});

test('partial model messages are not accepted without successful terminal events', () => {
  const codex = parseCodexJsonl(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }));
  const claude = parseClaudeOutput(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }));
  assert.equal(codex.text, null);
  assert.equal(claude.text, null);
});

test('deepseek.run rejects Claude result errors', async () => {
  const providers = createProviders(
    { claudeCommand: 'C:\\Claude\\claude.exe', deepseekModel: 'deepseek-v4-pro' },
    () => {},
    {
      runProcess: async () => ({
        stdout: JSON.stringify({ type: 'result', is_error: true, result: 'bad result' }),
        stderr: '',
        code: 0
      }),
      resolveClaudeExecutable: () => 'C:\\Claude\\claude.exe',
      readClaudeSettingsMetadata: () => ({
        configured: true,
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-pro',
        settingsPath: 'C:\\Users\\tester\\.claude\\settings.json'
      })
    }
  );

  await assert.rejects(
    providers.deepseek.run({ prompt: 'do work', cwd: 'C:\\work' }),
    /returned an error/
  );
});

test('qwen.run posts a non-stream Ollama chat request and measures prompt/eval tokens', async () => {
  const requests = [];
  const events = [];

  const providers = createProviders(
    { ollamaUrl: 'http://127.0.0.1:11434', qwenModel: 'qwen3:8b', timeoutMinutes: 1 },
    (event) => events.push(event),
    {
      httpJson: async (url, options) => {
        requests.push({ url, options });
        return {
          model: 'qwen3:8b',
          message: { role: 'assistant', content: '{"answer":42}', thinking: 'think think' },
          prompt_eval_count: 15,
          eval_count: 7
        };
      }
    }
  );

  const result = await providers.qwen.run({
    prompt: 'what is six by seven',
    cwd: 'C:\\work',
    schema: { type: 'object' }
  });

  assert.equal(result.provider, 'qwen');
  assert.equal(result.text, '{"answer":42}');
  assert.deepEqual(result.structured, { answer: 42 });
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 7, cachedTokens: 0 });
  assert.equal(result.model, 'qwen3:8b');
  assert.doesNotMatch(result.text, /think think/);

  const request = requests[0];
  assert.match(request.url, /\/api\/chat$/);
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.keep_alive, '15m');
  assert.equal(body.model, 'qwen3:8b');
  assert.deepEqual(body.format, { type: 'object' });
  assert.ok(events.some((event) => event.type === 'usage' && event.provider === 'qwen'));
  assert.ok(events.some((event) => event.type === 'log' && /thinking characters separately/.test(event.message)));
});

test('Claude structured_output is accepted without result text, only on terminal result', async () => {
  const outcome = { status: 'blocked', summary: 'Missing source' };
  const parsed = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, structured_output: outcome }));
  assert.deepEqual(parsed.structured, outcome);
  assert.equal(parseClaudeOutput(JSON.stringify({ type: 'assistant', structured_output: outcome })).structured, undefined);
  const providers = createProviders({}, () => {}, {
    resolveClaudeExecutable: () => 'claude.exe',
    readClaudeSettingsMetadata: () => ({ configured: true, model: 'deepseek-v4-pro', settingsPath: 'settings.json' }),
    runProcess: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: outcome }) }),
  });
  const result = await providers.deepseek.run({ prompt: 'inspect', cwd: 'C:\\work', schema: { type: 'object' } });
  assert.deepEqual(result.structured, outcome);
  assert.equal(JSON.parse(result.text).status, 'blocked');
  const stream = parseClaudeOutput([
    JSON.stringify({ type: 'assistant', message: { content: 'intermediate' } }),
    JSON.stringify({ type: 'result', is_error: false, structured_output: outcome }),
  ].join('\n'));
  assert.deepEqual(stream.structured, outcome);
});

test('Qwen context scales with Unicode bytes and reserves output without truncating input', () => {
  const { qwenOptions } = require('../src/core/providers.cjs');
  assert.equal(qwenOptions('short').num_ctx, 8192);
  assert.equal(qwenOptions('a'.repeat(7000)).num_ctx, 16384);
  assert.equal(qwenOptions('汉'.repeat(6000)).num_ctx, 32768);
  assert.equal(qwenOptions('reason', {}, true).num_predict, 4096);
  assert.throws(() => qwenOptions('汉'.repeat(11000)), /未截断/);
  assert.throws(() => parseOllamaChatResponse({ done: false, message: { content: 'partial' } }), /未完成/);
  assert.throws(() => parseOllamaChatResponse({ done: true, done_reason: 'length', message: { content: '{}' } }), /输出上限/);
});
