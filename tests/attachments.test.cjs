'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Attachments, attachmentContext } = require('../src/core/attachments.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-attachments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, attachments: new Attachments(path.join(root, 'data')) };
}

test('attachments preserve independent sanitized snapshots across restart and source removal', async (t) => {
  const { root, attachments } = await fixture(t);
  const source = path.join(root, '需求.txt');
  await fs.writeFile(source, '参考需求\napi_key="secret-value-123456"\n' + '说明'.repeat(2000));
  const [file] = await attachments.importFiles([source]);
  await fs.unlink(source);
  const restored = await new Attachments(path.join(root, 'data')).resolve([file.id]);
  assert.equal(restored[0].name, '需求.txt');
  assert.equal(restored[0].truncated, true);
  assert.equal(restored[0].preview.length, 3000);
  const full = await fs.readFile(file.snapshotPath, 'utf8');
  assert.ok(full.length > 3000);
  assert.ok(!full.includes('secret-value-123456'));
  assert.match(attachmentContext(restored), /参考需求/);
  assert.match(attachmentContext(restored), /excerptTruncated/);
});

test('binary documents remain byte-identical and are never presented as extracted text', async (t) => {
  const { root, attachments } = await fixture(t);
  const source = path.join(root, '图.png');
  const bytes = Buffer.from([0x89, 0x50, 0, 0xff]);
  await fs.writeFile(source, bytes);
  const [file] = await attachments.importFiles([source]);
  assert.deepEqual(await fs.readFile(file.snapshotPath), bytes);
  assert.equal(file.kind, 'file');
  assert.equal(file.preview, '');
  assert.match(attachmentContext([file]), /无法读取时必须明确报告/);
});

test('invalid ids, file types, secrets, oversized files and excessive batches fail visibly', async (t) => {
  const { root, attachments } = await fixture(t);
  await assert.rejects(attachments.resolve(['../metadata']), /ID/);
  await assert.rejects(attachments.importFiles(Array(9).fill('x')), /1–8/);
  for (const name of ['sample.exe', 'auth.json', '.env.txt']) {
    const source = path.join(root, name);
    await fs.writeFile(source, 'content');
    await assert.rejects(attachments.importFiles([source]), /不支持|凭据/);
  }
  const big = path.join(root, 'large.txt');
  await fs.writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(attachments.importFiles([big]), /10 MB/);
  const invalid = path.join(root, 'invalid.txt');
  await fs.writeFile(invalid, Buffer.from([0xff, 0x80]));
  await assert.rejects(attachments.importFiles([invalid]), /UTF-8/);
});

test('UTF-16 text is normalized and duplicate attachment references are refused', async (t) => {
  const { root, attachments } = await fixture(t);
  const source = path.join(root, 'utf16.txt');
  await fs.writeFile(source, Buffer.from('\ufeff中文需求', 'utf16le'));
  const [file] = await attachments.importFiles([source]);
  assert.equal(file.preview, '中文需求');
  await assert.rejects(attachments.resolve([file.id, file.id]), /重复/);
});
