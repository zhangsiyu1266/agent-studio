'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { planSchema, reviewSchema, workerSchema, parseStructured, validatePlan, validateWorker, validateReview, isAccepted, redact, sanitizeData } = require('./contracts.cjs');
const { makeContext, fingerprint, assertComplete, validateProjectDirectory, changedFiles, matchesScope, sourceSnapshot } = require('./context.cjs');
const { createProviders } = require('./providers.cjs');
const { runProcess, resolveCommand } = require('./process.cjs');
const { discover } = require('./discovery.cjs');
const { Attachments, attachmentContext } = require('./attachments.cjs');
const { browsingContext, accessInstructions, resolveReferences } = require('./file-access.cjs');

const STANDARDS = `工程规范：采用项目既有语言、结构和风格；新项目建立一致的命名、模块边界、格式化和错误处理。明确接口再实现。修复根因，必要时补充行为测试。不可伪造测试或模型结果。不得读取或输出密钥。不要改动用户已有的不相关代码，不要执行 reset、clean、强制覆盖或递归删除。提交、部署、发布和对外通信只有用户需求明确要求时才执行。任务结束提供修改文件、检查证据、已知限制。质量优先，不能为了节省 token 降低标准。`;

class Orchestrator {
  constructor(store, notify = () => {}, dependencies = {}) {
    this.store = store;
    this.notify = notify;
    this.createProviders = dependencies.createProviders || createProviders;
    this.runProcess = dependencies.runProcess || runProcess;
    this.discover = dependencies.discover || discover;
    this.fingerprint = dependencies.fingerprint || fingerprint;
    this.attachments = new Attachments(store.directory);
    this.activeRunId = null;
    this.controller = null;
    this.pending = null;
  }

  publish(run) {
    this.store.saveRun(run);
    this.notify({ type: 'run.updated', run });
  }

  log(run, message, provider = 'system', type = 'log') {
    this.store.addEvent(run, { type, provider, message });
    this.notify({ type: 'run.updated', run });
  }

  phase(run, status, phase) {
    const time = new Date().toISOString();
    run.phaseHistory = run.phaseHistory || [];
    run.phaseHistory.push({ status, phase, time, round: run.round || 0 });
    if (status === 'completed') run.completedAt = time;
    run.status = status;
    run.phase = phase;
    this.publish(run);
  }

  async start({ projectPath, request, attachmentIds = [] }) {
    if (this.activeRunId) throw new Error('当前任务仍在执行，请等待完成或先停止。');
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || typeof request !== 'string'
      || request.trim().length < 5 || request.length > 50000) throw new Error('请选择项目目录，并填写至少 5 个字符的需求。');
    const realPath = await fs.realpath(projectPath);
    if (!(await fs.stat(realPath)).isDirectory()) throw new Error('项目路径必须是目录。');
    const root = path.parse(realPath).root;
    if (realPath === root || /(?:^|[\\/])(?:Windows|Program Files(?: \(x86\))?|\.codex|\.claude|\.ollama)$/i.test(realPath)) {
      throw new Error('请选择具体的软件项目文件夹。');
    }
    const attachments = await this.attachments.resolve(attachmentIds);
    await validateProjectDirectory(realPath);
    if (this.activeRunId) throw new Error('已有任务开始执行。');
    const run = this.store.createRun(realPath, request.trim());
    run.attachments = attachments;
    this.activeRunId = run.id;
    this.controller = new AbortController();
    const settings = { ...this.store.settings };
    this.pending = this.execute(run, settings, this.controller.signal)
      .catch((error) => {
        const cancelled = this.controller?.signal.aborted;
        run.error = cancelled ? '已停止执行，项目中的修改已保留。' : redact(error.message);
        this.phase(run, cancelled ? 'cancelled' : error.code === 'SCAN_INCOMPLETE' ? 'needs_attention' : 'failed', cancelled ? '执行已停止' : '执行已暂停，请查看原因');
        this.log(run, run.error, 'system', 'error');
      })
      .finally(() => {
        this.activeRunId = null;
        this.controller = null;
        this.publish(run);
      });
    this.publish(run);
    return run;
  }

  cancel(id) {
    if (id !== this.activeRunId || !this.controller) throw new Error('该任务当前未在执行。');
    this.controller.abort();
    this.log(this.store.getRun(id), '正在停止模型和检查进程；保留已产生的修改。');
    return { stopping: true };
  }

  checkAbort(signal) {
    if (signal.aborted) throw new Error('执行已停止。');
  }

  async call(run, providers, provider, options) {
    this.checkAbort(options.signal);
    const protocol = options.schema === planSchema
      ? `调度约定：projectPath 必须填写当前工作与成果目录 ${run.projectPath}，referencePaths 列出你实际定位并核实的参考文件或源码目录的绝对路径。两者可以不同；例如从 C 盘的软件源码取材，在用户选择的 E 盘目录编写 README，是可执行任务，必须 ready，不得仅因参考源码位于外部而 blocked。当前目录只有快捷方式时先自行解析目标、查找真实源码。只有确实无法找到必要资料、访问失败或必要写入超出当前目录时才 blocked，并给出具体证据。可执行时 status=ready、blockedReason 为空。evidence 用简短的“绝对路径：已核实事实”共享规划证据；文件读取属于工作所需的工具调用，不要拆成无益的重复调研任务。checks 默认在成果目录执行，文档任务检查实际文档和事实，不要在没有 package.json 的输出目录机械运行 npm test；需要外部项目的检查时在参数中明确目标。只能分配给可用的模型；DeepSeek 未配置时由 GPT 实现，Qwen 未配置时无需增加辅助任务。简单文档修改或单个模块修复在 DeepSeek 可用时默认只设一个 DeepSeek 实现任务；有独立、明确收益时才增设 Qwen 或 GPT 工作任务，不要求每个模型都参与。复杂工作仍按实际接口和依赖充分拆分。qwenThinking 对提取、分类、整理设 false，确需复杂推理的 Qwen 任务设 true，其他执行者设 false。GPT 的最终代码核查、测试与验收保持完整。\n本机搜索起点（不是读取范围限制）：${run.fileAccess?.searchContext || ''}`
      : options.schema === workerSchema
        ? `交接约定：projectPath 填写当前工作与成果目录 ${run.projectPath}，不是外部参考源码目录。可以自主读取 referencePaths 及其他任务相关文件，不因跨目录取材而 blocked。必须返回给定 JSON：status 为 completed/blocked/failed；summary 写实际产出；changedFiles 写成果目录内实际修改的相对路径；checks 写实际检查与结果；blockers 写阻塞原因。确实缺少必要资料、读取失败、未满足前置条件时返回 blocked，不得称 completed。只有全部任务验收条件满足且 blockers 为空才能 completed。Qwen 没有工具，不要声称读取了未提供的文件；只读分析的 changedFiles 为空。已核实的规划证据（仍需核对发生变化的原文件）：${JSON.stringify(run.plan?.evidence || []).slice(0, 16000)}`
        : '';
    options = { ...options, prompt: `${options.prompt}\n${protocol}\n${accessInstructions(run.projectPath, run.plan?.referencePaths)}` };
    const metric = { provider, phase: run.phase, startedAt: new Date().toISOString(), inputChars: options.prompt.length, status: 'running' };
    run.modelCalls = run.modelCalls || [];
    run.modelCalls.push(metric);
    this.publish(run);
    const started = Date.now();
    let result;
    try {
      result = await providers[provider].run(options);
      metric.status = 'completed';
      metric.usage = result.usage;
      if (result.performance) metric.performance = result.performance;
    } catch (error) {
      metric.status = options.signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      metric.durationMs = Date.now() - started;
      metric.finishedAt = new Date().toISOString();
      this.publish(run);
    }
    this.checkAbort(options.signal);
    const usage = result.usage || {};
    const totals = run.usage[provider];
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) {
      const amount = Number(usage[key]);
      if (Number.isFinite(amount) && amount > 0) totals[key] += amount;
    }
    this.log(run, result.text, provider, 'result');
    return sanitizeData(result);
  }

  async snapshot(directory) {
    const snapshot = await this.fingerprint(directory);
    assertComplete(snapshot);
    return snapshot;
  }

  needsAttention(run, reason) {
    run.error = reason;
    this.phase(run, 'needs_attention', '前置条件未满足，等待处理');
    this.log(run, reason, 'system', 'error');
  }

  sameProject(left, right) {
    const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normalize(left) === normalize(right);
  }

  async execute(run, settings, signal) {
    const connections = await this.discover(settings);
    this.checkAbort(signal);
    if (!connections.codex.available || !connections.codex.authenticated || connections.codex.authMode !== 'chatgpt') {
      throw new Error('GPT 必须使用已登录 ChatGPT 的 Codex。请在模型连接中检查登录状态；平台不会转用 API 计费。');
    }
    const providers = this.createProviders(settings, (event) => {
      if (event.type !== 'usage' && event.message) this.log(run, event.message, event.provider || 'system', event.type);
    });
    providers.gpt = providers.gpt || providers.codex;
    const artifactDirectory = this.store.artifacts(run.id);
    const baseline = await this.snapshot(run.projectPath);
    await fs.writeFile(path.join(artifactDirectory, 'baseline.json'), JSON.stringify(baseline, null, 2));
    await fs.writeFile(path.join(artifactDirectory, 'baseline-source.json'), JSON.stringify(await sourceSnapshot(run.projectPath)));
    const initialGit = await this.git(run.projectPath, ['status', '--porcelain=v1', '--', '.'], signal);
    run.baseline = { git: initialGit.code === 0, dirty: Boolean(initialGit.stdout.trim()), fingerprintCount: Object.keys(baseline.files).length, coverage: baseline.coverage };
    this.log(run, run.baseline.dirty ? '检测到已有未提交修改；保留这些修改，并记录执行前基线。' : '已记录项目基线。');
    const context = await makeContext(run.projectPath);
    run.fileAccess = { mode: 'computer-read', searchContext: await browsingContext(this.store, run.projectPath) };
    this.log(run, '文件浏览：按需查找本机可访问文件；成果保存到 ' + run.projectPath + '。');
    if ((await validateProjectDirectory(run.projectPath)).shortcutOnly) {
      this.log(run, '当前目录只有快捷方式，将由 GPT 只读解析目标并定位参考源码；成果仍保存在当前目录。');
    }
    run.availableProviders = {
      gpt: true,
      deepseek: connections.deepseek.available && connections.deepseek.configured,
      qwen: connections.ollama.available && connections.ollama.models.some((item) => (typeof item === 'string' ? item : item.name || item.model) === settings.qwenModel),
    };
    const capabilityText = JSON.stringify(run.availableProviders);
    const planResult = await this.call(run, providers, 'gpt', {
      cwd: run.projectPath, signal, writable: false, schema: planSchema,
      prompt: `你是本项目的技术负责人和最终质量负责人。你必须亲自统筹、规划、分配工作，最终由你审查修改。\n${STANDARDS}\n用户需求：\n${run.request}${attachmentContext(run.attachments)}\n可用执行者：${capabilityText}；GPT始终可用。\n项目上下文：\n${context}\n请检查原文件后制定明确的软件实现方案，用给定JSON结构输出。将常规实现分配给deepseek，将只需分析、整理证据或给建议的辅助任务分配给qwen；复杂实现可分配给gpt。平台会在全部tasks执行后运行专用GPT最终审查，不要将最终审查再次列为tasks，避免重复审查。Qwen在首版没有写文件和执行命令的工具，禁止给它直接修改代码或运行测试的任务。每个任务包含文件范围、依赖和可验证的验收标准。不要把需求简化成演示或占位代码。检查命令使用程序名+参数数组，不要用shell复合字符串。任务依赖必须完整且无环；按依赖排序。至少一项最终验收标准。当前阶段只读，不改文件。`,
    });
    run.plan = validatePlan(parseStructured(planResult));
    this.routeAvailableTasks(run, run.plan.tasks);
    run.title = run.plan.title;
    run.tasks = run.plan.tasks.map((task) => ({ ...task, status: 'pending', result: null }));
    await fs.writeFile(path.join(artifactDirectory, 'plan.json'), JSON.stringify(run.plan, null, 2));
    this.publish(run);
    if (run.plan.status === 'blocked' || !this.sameProject(run.plan.projectPath, run.projectPath)) {
      run.planningBlocked = true;
      for (const task of run.tasks) { task.status = 'blocked'; task.result = run.plan.blockedReason || '规划指向其他项目目录。'; }
      this.needsAttention(run, run.plan.blockedReason || `规划把成果目录改为 ${run.plan.projectPath}，与指定目录 ${run.projectPath} 不一致。参考源码请放入 referencePaths，成果目录应保持不变。`);
      return;
    }
    try {
      run.plan.referencePaths = await resolveReferences(run.plan.referencePaths);
    } catch (error) {
      run.planningBlocked = true;
      for (const task of run.tasks) { task.status = 'blocked'; task.result = error.message; }
      this.needsAttention(run, error.message);
      return;
    }
    if (run.plan.referencePaths.length) this.log(run, '已定位只读参考：\n' + run.plan.referencePaths.join('\n'));
    await fs.writeFile(path.join(artifactDirectory, 'plan.json'), JSON.stringify(run.plan, null, 2));
    this.publish(run);
    if (!await this.executeTasks(run, providers, run.tasks, signal, artifactDirectory)) {
      await this.captureChanges(run, baseline, artifactDirectory, signal);
      return;
    }
    await this.checks(run, run.plan.checks, signal);
    const rounds = Number(settings.maxReviewRounds) || 3;
    for (let round = 1; round <= rounds; round++) {
      this.checkAbort(signal);
      run.round = round;
      this.phase(run, 'reviewing', `GPT 正在最终审查 · 第 ${round} 轮`);
      await this.captureChanges(run, baseline, artifactDirectory, signal);
      const handoff = run.tasks.map((task) => ({ id: task.id, title: task.title, provider: task.provider, status: task.status, result: task.result }));
      const reviewContext = await makeContext(run.projectPath, run.tasks.flatMap((task) => task.allowedPaths), 30000);
      const reviewResult = await this.call(run, providers, 'gpt', {
        cwd: run.projectPath, signal, writable: true, schema: reviewSchema,
        prompt: `你是最终质量负责人。必须按你的标准检查当前真实代码、接口、边界行为和验收证据；不得仅凭工作者摘要批准。\n${STANDARDS}\n用户需求：\n${run.request}${attachmentContext(run.attachments)}\n你的方案：\n${JSON.stringify(run.plan)}\n工作者交接（节选，完整原文件可直接读取）：\n${JSON.stringify(handoff).slice(0, 60000)}\n本轮检查：\n${JSON.stringify(run.checks).slice(0, 45000)}\n实际变更文件：\n${JSON.stringify(run.changes)}\n代码上下文：\n${reviewContext}\n执行记录与补丁目录：${artifactDirectory}\n请直接修正你发现的关键问题并验证，必要时读取所有相关原文件。输出给定JSON审查结构，包含真实结论和未解决问题。只要有未解决的critical/major问题、任务未实现、检查失败或需要进一步修改，就不能approved=true。缺少测试时必须说明手工检查覆盖与限制。你也可以分配repairTasks继续委派；仅在全部验收通过时批准。新增任务ID必须唯一，使用r${round}_前缀，不能与已有任务重复；依赖可引用此前已完成任务或本轮repairTasks。Qwen仅执行只读支持任务。不要为了减少GPT用量牺牲成品质量。`,
      });
      run.review = validateReview(parseStructured(reviewResult), run.tasks.map((task) => task.id));
      await fs.writeFile(path.join(artifactDirectory, `review-${round}.json`), JSON.stringify(run.review, null, 2));
      const reviewedSnapshot = await this.snapshot(run.projectPath);
      await this.checks(run, run.plan.checks, signal);
      const afterCheckChanges = changedFiles(reviewedSnapshot, await this.snapshot(run.projectPath));
      if (afterCheckChanges.length) {
        run.review.approved = false;
        run.review.findings.push({ severity: 'major', path: afterCheckChanges.map((item) => item.path).join(', '), description: '检查命令在 GPT 审查后修改了文件，需要再次审查当前代码。' });
        this.log(run, '检查后代码发生变化，原审查批准已失效，将重新交由 GPT 审查。', 'system');
      }
      await this.captureChanges(run, baseline, artifactDirectory, signal);
      run.reviewHistory = run.reviewHistory || [];
      run.reviewHistory.push({ round, time: new Date().toISOString(), review: JSON.parse(JSON.stringify(run.review)),
        checks: run.checks.map((check) => ({ command: check.command, args: check.args, code: check.code })) });
      if (isAccepted(run.review, run.checks)) {
        for (const task of run.tasks) {
          if (['failed', 'blocked'].includes(task.status)) {
            task.status = 'superseded';
            task.result += '\nGPT 已检查当前代码，并确认相关问题已解决、最终需求通过验收。';
          }
        }
        this.phase(run, 'completed', 'GPT 已审查通过，验收完成');
        this.log(run, run.plan.checks.length ? 'GPT 审查通过，自动检查全部成功。' : 'GPT 审查通过。本次未配置自动检查，验收依据为 GPT 的代码与手工检查。');
        return;
      }
      if (round === rounds) break;
      if (run.review.repairTasks.length) {
        this.phase(run, 'repairing', '按 GPT 审查意见修复');
        const repairs = run.review.repairTasks.map((task) => ({ ...task, status: 'pending', result: null }));
        this.routeAvailableTasks(run, repairs);
        run.tasks.push(...repairs);
        if (!await this.executeTasks(run, providers, repairs, signal, artifactDirectory)) {
          await this.captureChanges(run, baseline, artifactDirectory, signal);
          return;
        }
      } else {
        this.log(run, '审查尚未达到交付标准，将请 GPT 继续直接检查与修复。', 'gpt');
      }
    }
    this.phase(run, 'needs_attention', '尚未达到 GPT 验收标准，需要继续处理');
    run.error = '已达到本次审查轮数上限，未标记为完成。可增加轮数后基于当前代码重新执行。';
    this.publish(run);
  }

  routeAvailableTasks(run, tasks) {
    for (const task of tasks) {
      if (run.availableProviders[task.provider]) continue;
      const requestedProvider = task.provider;
      task.provider = 'gpt';
      task.requestedProvider = requestedProvider;
      task.readOnly = requestedProvider === 'qwen';
      task.instructions += task.readOnly ? '\n此任务转由 GPT 执行，只读核查，禁止修改文件。' : '\n此任务转由 GPT 实际实现并验证。';
      this.log(run, `${requestedProvider} 未配置或不可用；任务“${task.title}”明确改由 GPT 执行。`, 'system');
    }
  }

  async executeTasks(run, providers, tasks, signal, artifactDirectory) {
    for (const task of tasks) {
      this.checkAbort(signal);
      const blocked = task.dependencies.some((id) => run.tasks.find((item) => item.id === id)?.status !== 'completed');
      if (blocked) {
        task.status = 'blocked';
        task.result = '依赖任务未完成，交由 GPT 审查和重新分配。';
        this.publish(run);
        continue;
      }
      this.phase(run, 'executing', `${task.provider === 'gpt' ? 'GPT' : task.provider === 'qwen' ? 'Qwen' : 'DeepSeek'} 正在执行：${task.title}`);
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.publish(run);
      const before = await this.snapshot(run.projectPath);
      const context = await makeContext(run.projectPath, task.allowedPaths, task.provider === 'qwen' ? 18000 : 24000);
      const prior = run.tasks.filter((item) => task.dependencies.includes(item.id)).map((item) => ({ id: item.id, result: item.result }));
      try {
        const result = await this.call(run, providers, task.provider, {
          cwd: run.projectPath, signal, writable: task.provider !== 'qwen' && !task.readOnly, schema: workerSchema, thinking: task.qwenThinking === true,
          prompt: `你是 GPT 技术负责人分配的执行者。\n${STANDARDS}\n原始用户需求：\n${run.request}${attachmentContext(run.attachments)}\n整体目标：${run.plan.summary}\n本任务：${JSON.stringify(task)}\n依赖交接：${JSON.stringify(prior).slice(0, 25000)}\n相关上下文：\n${context}\n${task.provider === 'qwen' ? '你仅能分析提供的上下文，不能执行命令或实际修改文件。返回有原文件路径依据的分析、建议和未验证事项。不得声称已经运行测试或完成代码修改。' : '实现本任务，仅修改约定范围的文件。遇到范围外需要修改时报告原因，不擅自扩大范围。可以运行所需检查。不要提交或发布，除非本任务用户需求明确要求。完成后简洁返回实际修改文件、运行检查及结果、未解决问题。'}`,
        });
        const outcome = validateWorker(parseStructured(result));
        if (!this.sameProject(outcome.projectPath, run.projectPath)) {
          outcome.status = 'blocked';
          outcome.blockers.push(`工作目录不一致：${outcome.projectPath}；当前选择：${run.projectPath}`);
        }
        task.outcome = outcome;
        task.result = redact(JSON.stringify(outcome, null, 2)).slice(0, 22000);
        task.status = outcome.status;
        const changed = changedFiles(before, await this.snapshot(run.projectPath));
        const outside = changed.filter((item) => !task.allowedPaths.some((scope) => matchesScope(item.path, scope)));
        if (outside.length) {
          if (task.status !== 'blocked') task.status = 'failed';
          task.result += `\n文件范围检查未通过：${outside.map((item) => item.path).join(', ')}。请 GPT 检查这些修改。`;
          this.log(run, task.result, task.provider, 'error');
        }
        await fs.writeFile(path.join(artifactDirectory, `task-${task.id}.txt`), task.result);
      } catch (error) {
        if (signal.aborted) {
          task.status = 'cancelled';
          task.finishedAt = new Date().toISOString();
          task.result = '任务已停止，已产生的修改保留。';
          this.publish(run);
        }
        this.checkAbort(signal);
        if (error.code === 'SCAN_INCOMPLETE') {
          task.status = 'blocked';
          task.finishedAt = new Date().toISOString();
          task.result = redact(error.message);
          this.publish(run);
          throw error;
        }
        task.status = 'failed';
        task.result = redact(error.message);
        this.log(run, `任务 ${task.id} 失败：${task.result}；由 GPT 审查处理。`, task.provider, 'error');
      }
      task.finishedAt = new Date().toISOString();
      this.publish(run);
      if (task.outcome?.status === 'blocked') {
        for (const pending of run.tasks.filter((item) => item.status === 'pending')) {
          pending.status = 'blocked';
          pending.result = `流程因 ${task.id} 的前置条件受阻而暂停，尚未执行。`;
        }
        this.needsAttention(run, `任务「${task.title}」受阻：${task.outcome.blockers.join('；')}`);
        return false;
      }
    }
    return true;
  }

  async checks(run, checks, signal) {
    this.phase(run, 'checking', '正在运行验收检查');
    run.checks = [];
    for (const check of checks) {
      this.checkAbort(signal);
      const started = Date.now();
      let result;
      try {
        const resolved = resolveCommand(check.command);
        result = await this.runProcess(resolved.command, [...resolved.argsPrefix, ...check.args], {
          cwd: run.projectPath, signal, timeoutMs: 15 * 60 * 1000,
          onLine: (line) => this.log(run, typeof line === 'string' ? line : JSON.stringify(line), 'checks'),
        });
      } catch (error) {
        this.checkAbort(signal);
        result = { code: -1, stdout: '', stderr: redact(error.message) };
      }
      run.checks.push({ ...check, code: result.code, stdout: redact(result.stdout).slice(-20000), stderr: redact(result.stderr).slice(-12000), durationMs: Date.now() - started });
      this.log(run, `${check.command} ${check.args.join(' ')} → ${result.code === 0 ? '通过' : `失败 (${result.code})`}`, 'checks');
    }
    this.publish(run);
  }

  async git(cwd, args, signal) {
    try {
      return await this.runProcess('git', args, { cwd, signal, timeoutMs: 30000 });
    } catch (error) {
      this.checkAbort(signal);
      return { code: -1, stdout: '', stderr: error.message };
    }
  }

  async captureChanges(run, baseline, directory, signal) {
    run.changes = changedFiles(baseline, await this.snapshot(run.projectPath));
    const exclusions = ['*.env*', '*.pem', '*.key', '**/auth.json', '**/credentials*', '.claude/**', '.codex/**', '.aws/**', '.ssh/**', '.ollama/**', '.config/**'].map((scope) => `:(exclude)${scope}`);
    const result = await this.git(run.projectPath, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...exclusions], signal);
    let patch = result.code === 0 ? redact(result.stdout).slice(0, 180000) : '该项目暂无可用的 Git HEAD；以下按执行前源码快照显示变更（大文件或二进制文件仅列出路径）。\n';
    if (run.baseline?.dirty) patch = '提示：Git 补丁包含执行前已有未提交修改。本次变更文件清单按执行前文件哈希对比生成。\n\n' + patch;
    if (result.code !== 0) {
      let before = {};
      try { before = JSON.parse(await fs.readFile(path.join(directory, 'baseline-source.json'), 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const after = await sourceSnapshot(run.projectPath);
      for (const file of run.changes.filter((item) => item.status !== 'added').slice(0, 30)) {
        patch += `\n文件 ${file.path} (${file.status})\n--- 执行前\n${(before[file.path] ?? '[未保存该文件源码快照]').slice(0, 16000)}\n+++ 执行后\n${(after[file.path] ?? '[文件已删除，或不在源码快照范围]').slice(0, 16000)}\n`;
      }
    }
    for (const file of run.changes.filter((item) => item.status === 'added').slice(0, 40)) {
      try {
        const fullPath = path.join(run.projectPath, file.path);
        if ((await fs.stat(fullPath)).size > 100000) continue;
        const content = await fs.readFile(fullPath, 'utf8');
        if (content.includes('\0')) continue;
        patch += `\n+++ 新增 ${file.path}\n${redact(content).slice(0, 12000)}\n`;
      } catch (error) { this.log(run, `读取变更 ${file.path} 失败：${error.message}`); }
    }
    await fs.writeFile(path.join(directory, 'changes.txt'), patch.slice(0, 260000));
    run.changeVersion = (run.changeVersion || 0) + 1;
    this.publish(run);
  }

  async diff(id) {
    const run = this.store.getRun(id);
    const target = path.join(this.store.artifacts(id), 'changes.txt');
    let text;
    try { text = await fs.readFile(target, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      text = '尚未生成变更快照。执行后和 GPT 审查时会更新。';
    }
    return { text, files: run.changes || [], baselineDirty: Boolean(run.baseline?.dirty) };
  }
}

module.exports = { Orchestrator, STANDARDS };
