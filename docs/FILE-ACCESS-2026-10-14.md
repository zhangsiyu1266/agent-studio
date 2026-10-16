# On-demand local file browsing acceptance — 2026-10-14

The latest real user run selected E:\mycode for a README about software whose sources were elsewhere. GPT successfully read the external sources but stopped because the old dispatch contract required the selected directory to equal the source directory. This was a scheduling error, not evidence of denied read access.

The selected directory now means the work/output location. GPT and DeepSeek may locate and read task-relevant files on accessible local disks, while absolute reference paths are recorded separately. Shortcut-only output folders reach read-only planning. Output baselines, diff capture, relative edit scopes and default check directory remain attached to the selected location. Qwen still analyzes supplied evidence only. OS permissions and credential exclusions remain in force.

Verification:

- 72 behavioral tests passed under normal Windows permissions; syntax and renderer CSP checks passed.
- A real isolated run resolved a file URL in a shortcut-only output directory, read an external sibling source, and returned ready planning with verified reference paths. DeepSeek read those references and wrote a bilingual README into the selected output directory. Actual checks confirmed the random source marker, example and unchanged reference hashes.
- That run's final GPT review timed out. It is saved as failed, not as a completed delivery. Successful discovery, worker output and checks do not imply final review approval.
- The published desktop executable passed UI acceptance with that genuine run: reference paths and output location were visible in the task plan and exported report; copy/paste, attachments and project-selection regression passed. No renderer console errors or horizontal overflow were reported in checked views.
- All 22 published source files matched their source copies. The existing desktop shortcut continues to point at the updated executable.

Evidence: `.build/file-access-acceptance-1791901074926/report.json` and `.build/file-access-published-ui/` reports/screenshots. An earlier restricted-sandbox test attempt failed on Node realpath EPERM; the later normal-permission test suite passed. The earlier automatic approval quota failure was transient and the subsequent review succeeded.

Located reference paths are a planning record, not an exhaustive access audit. No dedicated whole-disk index or whole-machine write permission was introduced.
