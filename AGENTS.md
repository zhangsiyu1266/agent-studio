# Shared engineering standards

Read docs/ENGINEERING.md before changing this project. GPT owns architecture, task assignment, and final acceptance. Delegated workers implement only their assigned scope; do not change other workers' files or perform Git commits unless explicitly assigned.

Use CommonJS for Electron/main/core modules and plain browser JavaScript for the renderer. Two-space indentation, single quotes in JavaScript, semicolons, camelCase variables/functions, PascalCase classes. Keep modules focused and export explicit interfaces. Never put Node access or credentials in the renderer. All IPC must validate payloads. Use textContent for model output, never innerHTML with untrusted content. Fail visibly on provider errors; never substitute simulated success. Do not print, persist, or return credentials.

Run npm test and npm run check. Add behavioral tests for orchestration, path boundaries, cancellation, authentication mode and provider parsing. No mock response may appear as a real model execution. Demo mode must be explicitly labeled.
