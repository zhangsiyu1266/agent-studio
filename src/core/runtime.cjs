'use strict';

const fs = require('node:fs');
const path = require('node:path');

const toolsDirectory = path.resolve(__dirname, '../../tools');

function bundledCodex() {
  return path.join(toolsDirectory, 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
}

function bundledNode() {
  return path.join(toolsDirectory, 'node', 'node.exe');
}

function configureRuntimeEnvironment() {
  const candidates = [path.dirname(bundledNode()), path.join(toolsDirectory, 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'path')];
  const available = candidates.filter((directory) => fs.existsSync(directory));
  process.env.PATH = [...available, process.env.PATH || ''].join(path.delimiter);
}

module.exports = { bundledCodex, bundledNode, configureRuntimeEnvironment };
