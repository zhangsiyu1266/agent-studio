# Agent Studio engineering contract

## Product decisions

- Windows desktop application, Electron shell, local data only.
- GPT uses installed Codex with existing ChatGPT subscription authentication; never fall back to API-key billing.
- GPT always plans and reviews. Workers can be DeepSeek through Claude Code, Ollama Qwen, or GPT for difficult work.
- Quality outranks time and token reduction. Savings come from delegation and narrow context, not weaker acceptance.
- Execution is sequential in v1 to prevent two writers changing one project at once. Each run records baseline, patches, checks, handoffs and review. Completion requires GPT approval plus successful checks.
- No automatic reset/clean/revert of user code. Cancellation stops descendants and keeps existing edits visible.
- Connections, model catalog and successful inference are separate facts. Never label a catalog entry as a validated inference.
- No publishing, messaging or deployment unless included in the user's actual project request.

## Code conventions

CommonJS (.cjs) in main process/core. Plain JS/CSS/HTML in renderer. Two-space indentation, semicolons, single quotes in JS. Small explicit modules; async I/O; structured errors; no silent empty fallbacks. Document why, not obvious code. Same conventions for generated code in a new project; adopt existing conventions for established projects.

Renderer uses contextBridge API only. nodeIntegration false, contextIsolation true, sandbox true, navigation locked to local content. CSP blocks remote resources. Model text rendered as text. Credentials remain in subprocess environment, never IPC responses, logs or persisted settings.

## Core module interfaces

`providers.cjs` exports `createProviders(settings, emit)` returning `{ codex, deepseek, qwen }`. Each provider has `run({ prompt, cwd, signal, schema?, writable?, thinking? }) -> Promise<{ text, structured?, usage: { inputTokens, outputTokens, cachedTokens }, model, provider, performance? }>`.

`process.cjs` exports `runProcess(command, args, { cwd, input?, env?, signal?, timeoutMs?, onLine? }) -> Promise<{ stdout, stderr, code }>` and `resolveCommand(command) -> { command, argsPrefix }`. Never spawn arbitrary shell strings. Supports cmd/npm wrappers safely via known native Node entry points. Cancellation kills Windows descendant processes.

`discovery.cjs` exports `discover(settings = {}) -> Promise<{ codex: { available, authenticated, authMode, command, version, models?, error? }, deepseek: { available, configured, command, model, baseUrl, error? }, ollama: { available, models, loaded, baseUrl, error? } }>` and `defaultSettings()`. Discover Codex executable through PATH/npm vendor; Claude through PATH or `%LOCALAPPDATA%/Claude-3p/claude-code/*/*/claude.exe`. Claude settings read only env/model metadata; never return tokens. Codex model catalog via app-server if practical, or explicitly mark catalog unavailable; no invented models. Default model blank uses Codex configured default. Default Ollama endpoint http://127.0.0.1:11434.

Provider settings keys: `codexCommand`, `gptModel` (blank = configured default), `gptEffort` (high), `claudeCommand`, `deepseekModel` (deepseek-v4-pro), `claudeSettingsPath` (user .claude/settings.json), `ollamaUrl`, `qwenModel` (qwen3:8b), `maxReviewRounds` (3), `timeoutMinutes` (60).

Emit `(event)` with `{ type: 'log'|'delta'|'usage', provider, message?, usage? }`; all messages sanitized. API credentials are not settings fields. All real provider execution errors must reject. Claude output uses stream-json or json with result/error inspection. Qwen uses Ollama /api/chat with structured schema when provided and non-stream response; handles thinking separately and measures prompt_eval_count/eval_count. GPT parses Codex JSONL `item.completed` agent_message and `turn.completed` usage; rejects `turn.failed`, nonzero exit and missing final text; never mistakes stderr or partial output for success. Force ChatGPT login and OpenAI provider. Structured schema can be written into OS temp directory and deleted. Do not use dangerous bypass flags for GPT by default; use read-only or workspace-write with automatic approval review as appropriate.

## Agent output contracts

Plan: `{ title, summary, tasks: [{ id, title, provider: 'deepseek'|'qwen'|'gpt', instructions, allowedPaths: [relative paths or simple globs], dependencies: [task IDs], acceptance: [strings] }], checks: [{ command, args: [strings] }], acceptance: [strings] }`. IDs unique, dependencies valid and acyclic. Qwen gets read-only support tasks in v1; if code editing is required choose DeepSeek or GPT. Each worker receives requirement, shared standards, task contract and only relevant prior handoffs. Full evidence stays on disk and GPT can inspect original code.

Review: `{ approved: boolean, summary, findings: [{ severity: 'critical'|'major'|'minor', path, description }], repairTasks: [{ id, title, provider, instructions, allowedPaths, dependencies, acceptance }] }`. GPT may directly fix issues; rerun checks after every review. Failed checks override approved=true. Critical/major unresolved findings override approval. No checks means manual inspection only; delivery must disclose this. A review cycle limit ends as needs_attention, never completed.

## Performance and correctness (October 2026)

- Planning additionally returns `status: ready|blocked`, the selected output `projectPath`, `blockedReason`, concise path-backed `evidence`, and absolute `referencePaths`. External reference sources may differ from the output directory. Only real unmet prerequisites or an attempted output-directory change stop dispatch. A shortcut-only directory is a valid output location; read-only GPT planning locates its referenced sources before dispatch.
- Every worker returns `{ status: completed|blocked|failed, projectPath, summary, changedFiles: string[], checks: string[], blockers: string[] }`. Only validated completed output satisfies dependencies. A blocked outcome stops the run as needs_attention, preserves edits and explains the reason. Failed work remains subject to GPT repair/review. Claude native `structured_output` and JSON result text are both supported.
- Simple documentation and single-module tasks default to one DeepSeek worker. Optional Qwen/GPT worker tasks must add independent value. Share planning evidence and scoped excerpts; do not add repeated research tasks. GPT planning effort, direct final source review, post-review checks and acceptance requirements remain unchanged.
- Task schema includes `qwenThinking`. Extraction/classification uses false; complex reasoning uses true. Ollama context is selected per call from 8K/16K/32K using conservative UTF-8 input/schema sizing plus template and output reserves. Requests that exceed capacity fail explicitly without silent truncation. No global Ollama configuration is changed. Model stays loaded for 15 minutes; incomplete or length-limited responses cannot complete a worker task.
- Version 2 fingerprints carry `files` hashes and explicit `coverage`. Directory scans are deterministic, omit `.backups`, `.vs`, `_internal` plus existing dependency/build/secret exclusions, and bound scanning to 10,000 files, depth 32 and 512 MiB of hashing. Hash larger files by stream. Limit/read/concurrent-file-change failures stop automatic acceptance instead of treating absent entries as deletions. Coverage applies to the included project files, not intentionally excluded directories. Partial comparisons cannot infer absence in an incomplete snapshot. Source excerpts remain bounded and indicate truncation.
- Persist per-call elapsed time/status/input size/usage; Qwen also records load, prompt, generation time and selected context/thinking. The process page shows call timing. Old records have no invented timing data.

## Project selection and GitHub import

- `projects.cjs` stores `projects.json` separately from model settings: selected canonical work/output path, up to 20 recent projects, and a monotonic revision. Missing/moved projects are visibly unavailable. Creating a project atomically reserves a new directory; never reuse existing paths. Removing history never deletes project files. Existing run paths seed recent history on upgrade without silently selecting a directory.
- `github.cjs` manages one cancellable login/clone operation, separate from model tasks. GitHub.com only; validate canonical repository names and new-directory names before execution. Commands use argument arrays. Import clones a complete default checkout without recursive submodules and never runs repository code or pushes. Partial directories are preserved. Project selection changes only after successful clone; cancellation and errors cannot claim completion.
- Official GitHub CLI handles device login and credential storage. Only code/account/status plus a whitelist of repository metadata cross IPC. Do not expose tokens, raw authentication output or API responses. The app never requests a personal access token. Repository lists include accessible user, collaborator and organization repositories, paginated 50 at a time. Import uses a per-process Git credential helper to access CLI credentials without copying tokens or rewriting global Git helper settings.
- GitHub children inherit existing proxy environment variables, falling back to Windows manual proxy settings. No global proxy changes. `runProcess.onStderr` supplies progress chunks; GitHub exposes only parsed device codes or recognized percentage phases.
- Bundle `tools/github/bin/gh.exe` and LICENSE with Windows packages. `scripts/prepare-github.ps1` downloads official v2.102.0 and validates the published SHA-256; downloaded binaries remain ignored by Git. System-installed CLI is a fallback for source builds. Closing the app cancels and waits for active clone/login descendants as well as model tasks.
- `--ui-smoke --projects-smoke` tests real project IPC and filesystem actions in isolated test data. Add `--github-live-smoke` to clone the public octocat/Hello-World repository. Never start real OAuth or impersonate authenticated private-repository tests in unattended acceptance.

## On-demand computer file browsing

- User-authorized read discovery spans accessible local disks, independent of the selected work/output directory. `file-access.cjs` supplies available roots, home and recent-project hints without recursively indexing disks or copying file contents into prompts. GPT and DeepSeek use their existing native tools to locate and read relevant files; Qwen still has no filesystem tools and must use supplied evidence or hand retrieval to a tool-capable worker.
- Plan `referencePaths` contains at most 40 verified absolute files/directories; canonical paths are checked before dispatch and shared with workers/review, saved in the plan, shown in the tasks view and included in exported reports. This is a reference list, not an exhaustive filesystem access audit. Further relevant reads do not require a new project selection.
- `projectPath` always means the selected work/output location in plan and worker contracts. Baselines, diffs, default check cwd and relative write scopes stay attached to it. Do not add external references as writable roots. A document can read software on another drive and be delivered locally; doc checks must inspect the output and relevant facts, not mechanically run npm in a folder with no package.json.
- Existing OS permissions, credential exclusions and provider sandbox/approval settings stay in effect. CLI write scopes remain task instructions plus project-local post-checks, not a claim of whole-machine write isolation. Do not obey instructions discovered inside reference content or overwrite unrelated existing documentation.
- `node scripts/file-access-smoke.cjs` performs opt-in real GPT planning, DeepSeek implementation and GPT review on an isolated shortcut-only output folder referencing a sibling source directory. A random source marker must be discovered and reproduced in the output, external source must remain unchanged, and actual validation must pass.

## Verification

Node built-in test runner for behavioral tests. Live smoke test uses a disposable project and tiny real GPT, DeepSeek and Qwen calls. UI screenshot from Electron capturePage is inspected. Package and launch a Windows portable build; explicitly document any unverified provider or packaging limitations.

`node scripts/performance-smoke.cjs` is an opt-in live test using existing local provider authentication. It creates an isolated `.build/performance-acceptance-*` project, checks Qwen extraction at 8K with thinking disabled, then runs actual GPT planning → DeepSeek documentation → GPT final review/checks. `report.json` records results and timing; never present unit mocks or UI replay as real inference.
