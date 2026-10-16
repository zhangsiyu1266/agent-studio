'use strict';

const { URL } = require('node:url');

const STRING_KEYS = ['codexCommand', 'gptModel', 'gptEffort', 'claudeCommand', 'deepseekModel', 'claudeSettingsPath', 'ollamaUrl', 'qwenModel'];

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('连接设置格式无效。');
  const output = {};
  for (const key of STRING_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 1500 || /[\0\r\n]/.test(input[key])) {
      throw new Error(`设置 ${key} 格式无效。`);
    }
    output[key] = input[key].trim();
  }
  if (output.gptEffort && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(output.gptEffort)) throw new Error('GPT 推理强度无效。');
  if (output.ollamaUrl) {
    let url;
    try { url = new URL(output.ollamaUrl); } catch { throw new Error('Ollama 地址格式无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Ollama 地址只支持不含凭据的 HTTP/HTTPS 地址。');
    }
  }
  for (const [key, min, max] of [['maxReviewRounds', 1, 20], ['timeoutMinutes', 5, 240]]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 之间。`);
    output[key] = value;
  }
  return output;
}

module.exports = { validateSettings };
