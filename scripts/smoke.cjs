'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { discover, defaultSettings } = require('../src/core/discovery.cjs');
const { createProviders } = require('../src/core/providers.cjs');

async function main() {
  const settings = defaultSettings();
  const connections = await discover(settings);
  console.log(JSON.stringify(connections, null, 2));
  if (!process.argv.includes('--live')) return;
  const directory = path.resolve('.build', 'smoke-project');
  await fs.mkdir(directory, { recursive: true });
  const providers = createProviders(settings, () => {});
  const results = {};
  for (const [key, provider] of Object.entries({ gpt: providers.gpt || providers.codex, deepseek: providers.deepseek, qwen: providers.qwen })) {
    const started = Date.now();
    try {
      const result = await provider.run({ cwd: directory, prompt: '这是模型连接验收。不要读取文件或调用工具。只回复 AGENT_STUDIO_OK。', writable: false, signal: AbortSignal.timeout(180000) });
      results[key] = { passed: result.text.includes('AGENT_STUDIO_OK'), text: result.text, model: result.model, usage: result.usage, durationMs: Date.now() - started };
    } catch (error) { results[key] = { passed: false, error: error.message, durationMs: Date.now() - started }; }
    console.log(`${key}: ${results[key].passed ? 'PASS' : 'FAIL'}`);
  }
  await fs.writeFile(path.resolve('.build', 'live-smoke.json'), JSON.stringify(results, null, 2));
  if (Object.values(results).some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
