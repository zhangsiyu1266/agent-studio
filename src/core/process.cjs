'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ProcessAbortError extends Error {
  constructor(message = 'Process aborted') {
    super(message);
    this.name = 'ProcessAbortError';
  }
}

class ProcessTimeoutError extends Error {
  constructor(message = 'Process timed out') {
    super(message);
    this.name = 'ProcessTimeoutError';
  }
}

/**
 * Resolve a command to a safe spawn target.
 *
 * Never builds shell strings. Known npm/npx launchers are translated to the
 * matching Node entry point so they can be spawned without cmd.exe. Unknown
 * .cmd/.bat wrappers are rejected because executing them through cmd.exe would
 * require building a shell string.
 *
 * @param {string} command
 * @returns {{ command: string, argsPrefix: string[] }}
 */
function resolveCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new TypeError('command must be a non-empty string');
  }

  const trimmed = command.trim();
  const base = path.basename(trimmed).toLowerCase();

  if (base === 'npm' || base === 'npm.cmd') {
    const npmCli = findNodeCli('npm-cli.js');
    if (npmCli) {
      return { command: findNodeRuntime(), argsPrefix: [npmCli] };
    }
    throw new Error('Could not locate npm-cli.js; refusing to spawn npm through cmd.exe');
  }

  if (base === 'npx' || base === 'npx.cmd') {
    const npxCli = findNodeCli('npx-cli.js');
    if (npxCli) {
      return { command: findNodeRuntime(), argsPrefix: [npxCli] };
    }
    throw new Error('Could not locate npx-cli.js; refusing to spawn npx through cmd.exe');
  }

  if (base.endsWith('.cmd') || base.endsWith('.bat')) {
    throw new Error(`Refusing to spawn unknown shell wrapper "${command}"; provide a native executable or Node entry point`);
  }

  return { command: trimmed, argsPrefix: [] };
}

function findNodeRuntime() {
  if (!process.versions.electron) return process.execPath;
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    if (directory && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error('找不到 Node.js。请安装 Node.js，并重新启动桌面应用。');
}

/**
 * Find a Node CLI script next to the active Node installation or in the npm
 * global prefix. Returns null when no known native entry point exists.
 *
 * @param {string} scriptName
 * @returns {string | null}
 */
function findNodeCli(scriptName) {
  const candidates = [];

  if (process.env.npm_execpath && path.basename(process.env.npm_execpath) === scriptName) {
    candidates.push(process.env.npm_execpath);
  }

  const execDir = path.dirname(findNodeRuntime());
  candidates.push(path.join(execDir, 'node_modules', 'npm', 'bin', scriptName));
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', scriptName));
  }

  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', scriptName));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep checking the remaining candidates.
    }
  }

  return null;
}

/**
 * Kill a child process and, on Windows, its whole descendant tree.
 *
 * @param {import('child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child || !child.pid) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      const fallback = () => { try { child.kill('SIGKILL'); } catch {} resolve(); };
      killer.on('error', fallback);
      killer.on('close', (code) => { if (code !== 0) fallback(); else resolve(); });
    });
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // The child may already be gone.
  }
  return Promise.resolve();
}

/**
 * Run a child process without a shell.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   input?: string,
 *   env?: Record<string, string | undefined>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onLine?: (line: string) => void
 *   onStderr?: (chunk: string) => void
 * }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
async function runProcess(command, args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }
  if (options.signal?.aborted) throw new ProcessAbortError();

  const resolved = resolveCommand(command);
  const env = { ...process.env };
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || value === null) {
        delete env[key];
      } else {
        env[key] = String(value);
      }
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let timeoutId = null;
    let abortHandler = null;
    let stopError = null;
    let stopPending = null;
    const outputLimit = options.maxOutputBytes || 16 * 1024 * 1024;

    const child = spawn(resolved.command, resolved.argsPrefix.concat(args), {
      cwd: options.cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (options.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    const finishWithError = (error) => {
      if (settled || stopError) {
        return;
      }
      stopError = error;
      cleanup();
      if (!child.pid) { settled = true; reject(error); return; }
      stopPending = killProcessTree(child);
    };

    const handleLineChunk = (chunk) => {
      lineBuffer += chunk;
      let newlineIndex = lineBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const rawLine = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (options.onLine) {
          options.onLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        }
        newlineIndex = lineBuffer.indexOf('\n');
      }
    };

    const flushLineBuffer = () => {
      if (options.onLine && lineBuffer.length > 0) {
        options.onLine(lineBuffer);
        lineBuffer = '';
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      if (stdout.length + stderr.length + chunk.length > outputLimit) {
        finishWithError(new Error('子进程输出超过限制，已停止执行；请减少命令的详细输出。'));
        return;
      }
      stdout += chunk;
      handleLineChunk(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (stdout.length + stderr.length + chunk.length > outputLimit) {
        finishWithError(new Error('子进程输出超过限制，已停止执行；请减少命令的详细输出。'));
        return;
      }
      stderr += chunk;
      if (options.onStderr) options.onStderr(chunk);
    });

    child.on('error', (error) => {
      finishWithError(error);
    });

    child.on('close', (code) => {
      flushLineBuffer();
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (stopError) {
        Promise.resolve(stopPending).then(() => reject(stopError));
      } else resolve({ stdout, stderr, code: code === null ? null : code });
    });

    if (options.signal) {
      if (options.signal.aborted) {
        finishWithError(new ProcessAbortError());
        return;
      }
      abortHandler = () => {
        finishWithError(new ProcessAbortError());
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
      const timeoutMs = Number(options.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        finishWithError(new RangeError('timeoutMs must be a positive number'));
        return;
      }
      timeoutId = setTimeout(() => {
        timeoutId = null;
        finishWithError(new ProcessTimeoutError(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdin.on('error', () => {
      // EPIPE can happen if the child exits before consuming all input. The
      // close handler owns the final result.
    });
    if (options.input !== undefined && options.input !== null) {
      child.stdin.write(String(options.input), 'utf8');
    }
    child.stdin.end();
  });
}

module.exports = {
  runProcess,
  resolveCommand,
  killProcessTree,
  ProcessAbortError,
  ProcessTimeoutError
};
