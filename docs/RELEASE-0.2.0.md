# Agent Studio 0.2.0

## English

The first downloadable Windows portable release: extract the folder, open **Agent Studio.exe**, and sign in with your own ChatGPT account.

### Download

- **Agent-Studio-0.2.0-win-x64.zip**: Windows 10/11 x64 portable desktop app. Download this asset rather than GitHub's automatic source archives.
- **SHA256SUMS.txt**: checksum for the desktop ZIP.
- [First-run guide](https://github.com/zhangsiyu1266/agent-studio/blob/master/docs/GETTING-STARTED.md)

### What's included

- Electron desktop runtime, Node.js/npm, Codex CLI and GitHub CLI, with upstream license notices.
- An onboarding card with environment detection, official ChatGPT browser sign-in, cancellation and rechecking.
- GPT basic mode: planning, implementation, checks and final source review without DeepSeek or Qwen installed. Missing optional workers are explicitly reassigned to GPT; genuine provider failures remain visible.
- Optional setup links for DeepSeek, Ollama/Qwen and Git.
- Bilingual instructions, SHA-256 verification and MIT licensing for the application source.

### Requirements and limits

You need your own ChatGPT account with Codex access, available usage and a working network connection. No accounts, tokens, model credits, private projects or local run data are bundled. Additional project toolchains may be required; Git is needed for repository import. This build is unsigned, and Windows may show an unknown-publisher prompt. There are no macOS, Linux or native Windows ARM64 binaries in this release.

Packaging checks use an isolated profile on the development Windows computer, with host provider settings/tool paths hidden. They are not a full Windows reinstall or an interactive first-time OAuth test. See the [dated validation report](https://github.com/zhangsiyu1266/agent-studio/blob/master/docs/PORTABLE-2026-10-16.md) for verification details and real-inference results.

## 简体中文

首个可下载的 Windows 便携版：完整解压，打开 **Agent Studio.exe**，登录自己的 ChatGPT 账号即可开始配置。

### 下载

- **Agent-Studio-0.2.0-win-x64.zip**：Windows 10/11 x64 桌面便携包。请选择此附件，不要误下 GitHub 自动生成的源码压缩包。
- **SHA256SUMS.txt**：便携 ZIP 的校验值。
- [首次使用指南](https://github.com/zhangsiyu1266/agent-studio/blob/master/docs/GETTING-STARTED.md)

### 本版内容

- 附带 Electron、Node.js/npm、Codex CLI 和 GitHub CLI，以及上游许可声明。
- 入门卡片提供环境检测、官方 ChatGPT 浏览器登录、取消与重新检测。
- GPT 基础模式无需安装 DeepSeek 或 Qwen，仍完成规划、实现、检查和最终源码审查。缺少辅助模型时明确改派 GPT，真实模型错误继续可见。
- 提供 DeepSeek、Ollama/Qwen 和 Git 的可选配置入口。
- 中英双语指引、SHA-256 校验和应用源码 MIT 许可证。

### 条件与限制

需要自己的 ChatGPT 账号具备 Codex 权限和可用额度，并能正常联网。下载包不含共享账号、token、模型额度、私有项目或本机执行数据。任务所需其他工具链仍可能需要安装，导入仓库需要 Git。当前构建未签名，Windows 可能提示未知发布者。本版不提供 macOS、Linux 或 Windows ARM64 原生包。

打包验收在开发用 Windows 电脑的隔离配置下进行，隐藏了已有模型配置和工具路径，不等同于重装 Windows 或实际首次交互式 OAuth 验收。具体测试与真实推理结果见[有日期的验证记录](https://github.com/zhangsiyu1266/agent-studio/blob/master/docs/PORTABLE-2026-10-16.md)。
