# Start here / 开始使用

[English](#english) · [简体中文](#简体中文)

## English

### 1. Download and extract

Download **Agent-Studio-0.2.0-win-x64.zip** from [GitHub Releases](https://github.com/zhangsiyu1266/agent-studio/releases/latest). The “Source code” ZIP is for developers; it is not the desktop application.

Extract the entire archive to a writable folder, such as `Documents\Agent Studio`. Open the extracted folder and double-click **Agent Studio.exe** or **Start Agent Studio.cmd**. Do not run the app from inside the ZIP or move only the EXE.

The desktop package targets **Windows 10/11 x64**. It includes Electron, Node.js/npm, Codex CLI and GitHub CLI. No separate Node.js or Codex installation is needed. macOS, Linux and native Windows ARM64 packages are not provided in this release.

The build is not code-signed. Windows may show an unknown-publisher or SmartScreen message. Confirm that your download came from this repository and verify its SHA-256 before deciding whether to run it. Do not disable antivirus protection. If a managed computer blocks the app, use your organization's approved installation process.

To verify the download in PowerShell, compare the result with `SHA256SUMS.txt` from the same release:

```powershell
Get-FileHash .\Agent-Studio-0.2.0-win-x64.zip -Algorithm SHA256
```

### 2. Sign in with your own account

The start card checks the bundled runtime. Click **登录 ChatGPT / Sign in** and complete the official browser login. You need a ChatGPT account with Codex access and available usage. The app includes no shared account, model credits, or API key.

If you already use Codex on this computer, your existing login may be detected. This workbench accepts **ChatGPT login only**, not API-key billing. Credentials are managed by Codex, not stored in workbench settings or bundled into downloads. Signing in is an account check; the first real task verifies inference.

After browser authorization, the app checks the connection again. If login fails, check your account access and network, then retry. You can cancel a pending login. No model call is made merely by opening the app.

### 3. Run your first task

1. Create a new project or open a local folder. This is where your output will be saved.
2. Enter a small request, for example: “Create a greeting function and a Node behavioral test, run the test, and document how to use it.”
3. Start the run. GPT plans, implements and reviews when no optional workers are configured.
4. Inspect the task, checks and review. Accepted outcomes appear under **完成任务 / Completed**.

Only use projects you intend to let the model change. Cancellation preserves edits already written. Requirements and relevant files can be sent to cloud models. Additional languages and projects may require their own Python, compiler, browser or dependency installations.

### Optional tools

| Tool | When you need it | Setup |
|---|---|---|
| DeepSeek + Claude Code | Delegate implementation to another model | Use the app's DeepSeek setup link and the [official integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/). Configure credentials locally outside the workbench. |
| Ollama + Qwen | Local read-only analysis | Install [Ollama](https://ollama.com/download/windows), then pull the selected model, for example `ollama pull qwen3:8b`. Model downloads can be large. |
| Git | GitHub repository import and Git-based development | Install [Git for Windows](https://git-scm.com/downloads/win) and restart the app. GitHub CLI is already included. |

Missing optional workers are explicitly assigned to GPT. If a configured provider fails during execution, the failure is shown; it is not replaced with simulated success. GitHub login is separate from ChatGPT login, and is needed only for account/private-repository features.

### Troubleshooting

- **Nothing happens after double-clicking:** fully extract the ZIP, keep all files together, and use a Windows x64 computer. Check whether Windows security or organization policy blocked the executable.
- **Codex missing:** check that `resources\app\tools\codex` was extracted. Download a fresh complete archive rather than copying only the EXE. For source builds, follow the README prerequisites.
- **Login hangs:** finish authorization in the browser, check account/network access, or cancel and retry. Browser authorization may be blocked by local proxy/firewall rules.
- **GitHub import fails:** install Git, restart the app, and confirm repository access. A ChatGPT login does not authenticate GitHub.
- **A generated project cannot run:** inspect the actual check error and install that project's required toolchain. The bundled Node.js is not a replacement for every language runtime.
- **A model is listed but a task fails:** catalog detection is not an inference guarantee. Check permissions, usage availability, service response and the run's actual error.

For upgrades, extract the new version to a separate folder. Run records are stored in the user's application data directory, not in the download folder. When reporting a problem, include the app version, Windows version, reproduction steps and a redacted error; do not share credentials or private code.

## 简体中文

### 1. 下载并完整解压

在 [GitHub Releases](https://github.com/zhangsiyu1266/agent-studio/releases/latest) 下载 **Agent-Studio-0.2.0-win-x64.zip**。“Source code” 压缩包是开发者源码，不是可直接运行的桌面程序。

把整个压缩包解压到可写目录，例如“文档\Agent Studio”。进入解压后的文件夹，双击 **Agent Studio.exe** 或 **Start Agent Studio.cmd**。不要直接在压缩包内运行，也不要只复制 EXE。

本次提供 **Windows 10/11 x64** 便携版，包含 Electron、Node.js/npm、Codex CLI 和 GitHub CLI，无需额外安装 Node.js 或 Codex。本次不提供 macOS、Linux 或 Windows ARM64 原生包。

当前构建未做代码签名，Windows 可能提示未知发布者或 SmartScreen。请确认文件来自本仓库，并核对 SHA-256 后自行判断是否运行，不要关闭杀毒保护。单位管理的电脑如阻止运行，请遵循单位批准的安装流程。

在 PowerShell 中计算下载文件的校验值，与同一 Release 的 `SHA256SUMS.txt` 比较：

```powershell
Get-FileHash .\Agent-Studio-0.2.0-win-x64.zip -Algorithm SHA256
```

### 2. 登录你自己的账号

入门卡片会检查随包组件。点击 **登录 ChatGPT / Sign in**，在官方浏览器页面完成登录。你需要有 Codex 访问权限及可用额度的 ChatGPT 账号；下载包不含共享账号、模型额度或 API key。

如果本机已使用 Codex，应用可能直接识别已有登录。工作台只接受 **ChatGPT 登录**，不使用 GPT API-key 计费。凭据由 Codex 管理，不存入工作台设置，也不随下载包分发。登录成功只代表账号检查通过，第一次实际任务才验证推理能否成功。

浏览器授权后，应用会重新检测。登录失败时请检查账号权限和网络后重试，也可以取消正在进行的登录。仅打开应用不会调用模型推理。

### 3. 完成第一个任务

1. 新建项目或打开本地文件夹；这里是成果保存位置。
2. 输入一个小需求，例如：“创建一个问候函数和 Node 行为测试，运行测试并说明使用方式。”
3. 开始运行。未配置辅助模型时，GPT 会负责规划、实现和审查。
4. 查看任务、检查和审查，通过验收的成果出现在“完成任务”。

请只选择允许模型修改的项目。取消会保留已产生的编辑。需求和相关文件可能发送给云端模型；Python、编译器、浏览器及项目依赖仍需按实际任务准备。

### 可选增强

| 工具 | 何时需要 | 配置方式 |
|---|---|---|
| DeepSeek + Claude Code | 希望由另一模型承担实现 | 使用应用中的 DeepSeek 配置入口，参照[官方集成指南](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)，在工作台外本地配置凭据 |
| Ollama + Qwen | 需要本地只读分析 | 安装 [Ollama](https://ollama.com/download/windows)，拉取所选模型，例如 `ollama pull qwen3:8b`；模型下载可能较大 |
| Git | 从 GitHub 导入及 Git 开发 | 安装 [Git for Windows](https://git-scm.com/downloads/win) 后重启应用；GitHub CLI 已随包提供 |

缺少辅助模型时，任务会明确交给 GPT。已配置模型在运行中失败时会显示错误，不会用模拟结果代替成功。GitHub 登录与 ChatGPT 登录分开，仅在需要账号或私有仓库功能时使用。

### 常见问题

- **双击没有启动：** 确认已完整解压、所有文件放在一起，使用 Windows x64，并检查是否被系统安全策略拦截。
- **提示缺少 Codex：** 检查 `resources\app\tools\codex` 是否完整。请重新下载完整包，不要只复制 EXE；源码用户按 README 安装依赖。
- **登录一直等待：** 完成浏览器授权，检查账号和网络，或取消重试；本地代理、防火墙可能影响授权。
- **GitHub 导入失败：** 安装 Git、重启应用并确认仓库访问权限。ChatGPT 登录不会代替 GitHub 登录。
- **生成的项目无法运行：** 查看实际检查错误，并准备该项目所需工具链；附带 Node.js 不代表包含所有语言环境。
- **能看到模型却执行失败：** 模型目录检测不等于推理验证，请检查权限、额度、服务响应和实际错误记录。

升级时解压到新文件夹，不要混合覆盖旧版本。执行记录存放在用户应用数据目录，不在下载目录里。反馈问题时请附应用版本、Windows 版本、复现步骤和脱敏错误，不要提供凭据或私有源码。
