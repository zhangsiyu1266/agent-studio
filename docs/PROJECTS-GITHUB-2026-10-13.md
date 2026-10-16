# Project selection and GitHub acceptance — 2026-10-13

## Delivered

- Workbench entries for creating a project, opening a local project, importing from GitHub, and switching recent projects.
- Persist the last selection and up to 20 recent projects; visibly handle unavailable directories. Removing a recent record does not remove files.
- GitHub.com public URL import and official GitHub CLI browser authorization. Authenticated repository browsing supports pagination and filtering the current page. Clone progress and cancellation remain visible after closing the dialog.
- New directories are reserved without overwriting existing paths. Failed or cancelled imports retain their partial directory without switching the current project.
- Official GitHub CLI 2.102.0 and its license are bundled. The download script checks the official archive SHA-256. Per-process proxy and credential helper settings leave global Git settings unchanged.

## Verification

- `npm test`: 69 tests passed, 0 failed.
- `npm run check`: passed.
- Source Electron acceptance passed with real project IPC, directory creation, recent selection, and restoration after renderer reload.
- Published `dist/Agent-Studio/Agent Studio.exe` acceptance passed using isolated data under `.build/projects-published-data` and captures under `.build/projects-published-ui`.
- Public import performed an actual network clone of `octocat/Hello-World`, checked its `.git` directory and README, and verified automatic project selection. No model inference or remote writes were involved.
- Composer regression passed: copy/paste buttons, keyboard shortcuts, native context menu, attachment picker, drag-and-drop, screenshot paste, and draft retention when switching views.
- Completed-task and process-view regression passed using a prior genuine completed run plus explicitly labeled UI-only event replay. Replay is not evidence of fresh model execution.
- Published UI reported no renderer console errors or horizontal overflow in checked views. GitHub import and compact workbench screenshots were visually inspected.
- All 23 source/tool/license files matched the published copies byte-for-byte. Published CLI resolution points to the bundled executable.

Evidence: `.build/projects-published-ui/projects-smoke.json`, `composer-smoke.json`, `delivery-smoke.json`, `ui-smoke.json`, and PNG captures in the same directory.

## Limits

The local GitHub CLI was not authenticated during acceptance. Device-code parsing, verified-login handling, private credential-helper configuration, and repository pagination have behavioral unit coverage; actual account authorization and private repository access require the user's first browser login and have not been live-verified. This version imports GitHub.com repositories to local projects; it has no dedicated push or pull-request UI.

## Official references

- [GitHub CLI browser authentication](https://cli.github.com/manual/gh_auth_login)
- [Repositories accessible to the authenticated user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [GitHub CLI 2.102.0 release](https://github.com/cli/cli/releases/tag/v2.102.0)
