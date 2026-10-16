'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const { Projects, folderName } = require('../src/core/projects.cjs');
const { Github, repositoryName } = require('../src/core/github.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'data'));
  const projects = new Projects(store, path.join(root, 'projects'));
  return { root, store, projects };
}

test('create/select persist across restart, deduplicate and forget only removes records', async (t) => {
  const { store, projects } = await fixture(t);
  const created = await projects.create({ name: '微信助手' });
  assert.equal(path.basename(created.selectedPath), '微信助手');
  await fs.writeFile(path.join(created.selectedPath, 'keep.txt'), 'user work');
  await projects.select(created.selectedPath);
  const reopened = new Projects(new Store(store.directory), projects.defaultParent);
  const state = await reopened.state();
  assert.equal(state.selectedPath, created.selectedPath);
  assert.equal(state.recent.length, 1);
  const forgotten = await reopened.forget(created.selectedPath);
  assert.equal(forgotten.selectedPath, '');
  assert.equal(forgotten.recent.length, 0);
  assert.equal(await fs.readFile(path.join(created.selectedPath, 'keep.txt'), 'utf8'), 'user work');
  await assert.rejects(projects.create({ name: '微信助手' }), /同名目录/);
});

test('moved projects are unavailable without silently selecting another directory', async (t) => {
  const { projects } = await fixture(t);
  const first = await projects.create({ name: 'first' });
  const second = await projects.create({ name: 'second' });
  await fs.rename(second.selectedPath, second.selectedPath + '-moved');
  const state = await projects.state();
  assert.equal(state.selectedPath, '');
  assert.match(state.warning, /已移动/);
  assert.equal(state.recent.find((item) => item.path === first.selectedPath).available, true);
  await assert.rejects(projects.select(second.selectedPath));
});

test('unsafe names and paths are rejected; shortcut folders can be selected as output locations', async (t) => {
  const { root, projects } = await fixture(t);
  for (const name of ['..', '../escape', 'a\\b', 'C:drive', 'NUL', 'CON.txt', 'LPT9', 'name.', 'trailing ', '.git', 'bad\0name']) {
    assert.throws(() => folderName(name), /名称/);
  }
  await assert.rejects(projects.create({ name: 'safe', parent: 'relative' }), /目录/);
  const shortcut = path.join(root, 'shortcuts');
  await fs.mkdir(shortcut);
  await fs.writeFile(path.join(shortcut, 'app.lnk'), 'fixture');
  assert.equal((await projects.select(shortcut)).selectedPath, shortcut);
  const state = await projects.create({ name: 'actual-project', parent: shortcut });
  assert.equal(state.selectedPath, path.join(shortcut, 'actual-project'));
});

test('existing run directories appear in recent projects without claiming a selected project', async (t) => {
  const { store, projects } = await fixture(t);
  const created = await projects.create({ name: 'older' });
  const run = store.createRun(created.selectedPath, 'prior task');
  run.status = 'completed';
  store.saveRun(run);
  await fs.unlink(path.join(store.directory, 'projects.json'));
  const migrated = await new Projects(new Store(store.directory), projects.defaultParent).state();
  assert.equal(migrated.recent[0].path, created.selectedPath);
  assert.equal(migrated.selectedPath, '');
});

test('repository input permits only canonical GitHub repositories, not options or credentials', () => {
  assert.equal(repositoryName('https://github.com/octocat/Hello-World.git'), 'octocat/Hello-World');
  assert.equal(repositoryName('octocat/Hello-World'), 'octocat/Hello-World');
  assert.equal(repositoryName('owner/.github'), 'owner/.github');
  assert.equal(folderName('.github'), '.github');
  for (const value of ['--config=x/y', 'owner/repo/tree/main', 'https://evil.example/o/r', 'https://user:pass@github.com/o/r', 'file:///tmp/repo', 'o/../r', 'o/r?x=1', 'https://github.com/o/r#token', 'git@github.com:o/r', 'o/repo\n--upload-pack=bad']) {
    assert.throws(() => repositoryName(value), value);
  }
});

test('clone selects only successful downloads and passes strict argument boundaries', async (t) => {
  const { projects } = await fixture(t);
  const calls = [];
  const github = new Github(projects, () => {}, {
    resolveGithub: () => "C:/user's tools/gh.exe", environment: async () => ({}),
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      await fs.writeFile(path.join(args.at(-1), 'README.md'), 'cloned fixture');
      options.onStderr('Receiving objects: 100% (1/1)');
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const operation = github.clone({ repository: 'octocat/Hello-World', name: 'local-copy' });
  assert.equal(operation.status, 'running');
  await github.pending;
  assert.equal(github.operation.status, 'completed');
  const state = await projects.state();
  assert.equal(state.recent[0].repository, 'octocat/Hello-World');
  assert.deepEqual(calls[0].args.slice(-3), ['--', 'https://github.com/octocat/Hello-World.git', state.selectedPath]);
  assert.ok(calls[0].args.includes('--no-recurse-submodules'));
  assert.equal(calls[0].command, 'git');
  assert.ok(calls[0].args.some((arg) => arg.includes("user'\\''s tools")));
});

test('failed and cancelled clones preserve folders and never replace the current project', async (t) => {
  const { projects } = await fixture(t);
  const current = await projects.create({ name: 'current' });
  for (const cancel of [false, true]) {
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const github = new Github(projects, () => {}, {
      resolveGithub: () => null, environment: async () => ({}),
      runProcess: async (_command, args, options) => {
        await fs.writeFile(path.join(args.at(-1), 'partial.txt'), 'partial');
        ready();
        if (cancel) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled'))));
        return { code: 1, stderr: 'private token must not surface', stdout: '' };
      },
    });
    const op = github.clone({ repository: 'o/r', name: cancel ? 'cancelled' : 'failed' });
    await started;
    assert.throws(() => github.login(), /组件/);
    assert.throws(() => github.clone({ repository: 'o/another' }), /当前 GitHub 操作/);
    if (cancel) github.cancel(op.id);
    await github.pending;
    assert.equal(github.operation.status, cancel ? 'cancelled' : 'failed');
    assert.equal((await projects.state()).selectedPath, current.selectedPath);
    assert.equal(await fs.readFile(path.join(github.operation.projectPath, 'partial.txt'), 'utf8'), 'partial');
    assert.doesNotMatch(JSON.stringify(github.operation), /private token/);
  }
});

test('login emits only a device code and verified account, never raw CLI output', async () => {
  const events = [];
  const github = new Github(null, (event) => events.push(structuredClone(event)), {
    resolveGithub: () => 'gh.exe', environment: async () => ({}),
    runProcess: async (_command, args, options) => {
      if (args[1] === 'login') {
        assert.ok(args.includes('--web'));
        assert.equal(args.includes('--with-token'), false);
        options.onStderr('First copy your one-time code: ABCD-');
        options.onStderr('1234\ncredential text should remain private');
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'tester', token: 'private-credential' }] } }), stderr: '' };
    },
  });
  github.login();
  await github.pending;
  assert.equal(github.operation.status, 'completed');
  assert.ok(events.some((event) => event.operation.code === 'ABCD-1234'));
  assert.equal(github.operation.code, '');
  assert.equal(github.operation.account, 'tester');
  assert.doesNotMatch(JSON.stringify(events), /private|credential/);
});

test('repository listing is paginated and strips unrelated API fields', async () => {
  const calls = [];
  const github = new Github(null, () => {}, {
    resolveGithub: () => 'gh.exe', environment: async () => ({}),
    runProcess: async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify([{ full_name: 'owner/private-repo', private: true, description: 'description', temp_clone_token: 'do-not-expose' }]) };
    },
  });
  const page = await github.repositories(2);
  assert.equal(page.page, 2);
  assert.equal(page.repositories[0].private, true);
  assert.match(calls[0].at(-1), /page=2/);
  assert.doesNotMatch(JSON.stringify(page), /do-not-expose/);
  await assert.rejects(github.repositories('2'), /页码/);
});
