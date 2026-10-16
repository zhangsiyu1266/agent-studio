'use strict';

// Explicit desktop acceptance mode only; never called by normal startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { clipboard, dialog, Menu } = require('electron');

async function testComposer(window, output) {
  const contents = window.webContents;
  const evaluate = (script) => contents.executeJavaScript(script, true);
  const waitFor = async (script) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(script)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Composer UI timeout: ' + script);
  };
  const savedClipboard = clipboard.availableFormats().map((format) => [format, clipboard.readBuffer(format)]);
  const originalDialog = dialog.showOpenDialog;
  const originalMenu = Menu.buildFromTemplate;
  const checks = [];
  try {
    const source = path.join(output, '界面验收需求.md');
    await fs.writeFile(source, '支持复制、粘贴、附件和中文文件名。');
    clipboard.writeText('复制粘贴验收');
    await evaluate('document.querySelector("#paste-requirement").click()');
    await waitFor('document.querySelector("#requirement-input").value === "复制粘贴验收"');
    clipboard.writeText('different');
    await evaluate('document.querySelector("#copy-requirement").click()');
    for (let attempt = 0; clipboard.readText() !== '复制粘贴验收' && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(clipboard.readText(), '复制粘贴验收');
    checks.push('copy and paste buttons');

    await evaluate('document.querySelector("#requirement-input").focus(); document.querySelector("#requirement-input").select()');
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(clipboard.readText(), '复制粘贴验收');
    clipboard.writeText('快捷键粘贴验收');
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    await waitFor('document.querySelector("#requirement-input").value === "快捷键粘贴验收"');
    checks.push('Ctrl+C / Ctrl+V');

    let menuItems = [];
    Menu.buildFromTemplate = (items) => { menuItems = items; return { popup() {} }; };
    const point = await evaluate('(() => { const r = document.querySelector("#requirement-input").getBoundingClientRect(); return {x:Math.round(r.x+20),y:Math.round(r.y+20)}; })()');
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
    for (let attempt = 0; !menuItems.length && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(menuItems.some((item) => item.role === 'paste'));
    assert.ok(menuItems.some((item) => item.role === 'copy'));
    Menu.buildFromTemplate = originalMenu;
    checks.push('native right-click editing menu');

    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    await evaluate('document.querySelector("#add-attachments").click()');
    await waitFor('document.querySelectorAll(".attachment-item").length === 1');
    assert.match(await evaluate('document.querySelector("#attachment-list").innerText'), /界面验收需求.md/);
    await evaluate('document.querySelector(".attachment-item button").click()');
    assert.equal(await evaluate('document.querySelectorAll(".attachment-item").length'), 0);
    checks.push('file picker and removal');

    contents.debugger.attach('1.3');
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await contents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [source], dragOperationsMask: 1 } });
    }
    await waitFor('document.querySelectorAll(".attachment-item").length === 1');
    contents.debugger.detach();
    checks.push('native file drag-and-drop through preload');

    const image = await contents.capturePage({ x: 0, y: 0, width: 64, height: 64 });
    assert.equal(image.isEmpty(), false);
    clipboard.writeImage(image);
    await evaluate('document.querySelector("#requirement-input").focus()');
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    await waitFor('document.querySelectorAll(".attachment-item").length === 2');
    checks.push('Ctrl+V screenshot attachment');

    await evaluate('document.querySelector("[data-view=connections]").click(); document.querySelector("[data-view=workbench]").click()');
    assert.equal(await evaluate('document.querySelectorAll(".attachment-item").length'), 2);
    assert.equal(await evaluate('document.querySelector("#requirement-input").value'), '快捷键粘贴验收');
    checks.push('draft survives view changes');
    await fs.writeFile(path.join(output, 'composer.png'), (await contents.capturePage()).toPNG());
    await fs.writeFile(path.join(output, 'composer-smoke.json'), JSON.stringify({ checks, passed: true }, null, 2));
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
    dialog.showOpenDialog = originalDialog;
    Menu.buildFromTemplate = originalMenu;
    clipboard.clear();
    for (const [format, buffer] of savedClipboard) clipboard.writeBuffer(format, buffer);
  }
}

module.exports = { testComposer };
