---
title: ChroMill agent instructions
status: active
updated: 2026-10-04
---

# ChroMill

## Product and framework

Build a Plasmo Framework extension for Chrome Manifest V3 with React and TypeScript. Follow the approved compact popup in windmill-mockup.html. Keep the toolbar popup at 380 by 572 pixels. Use the native side panel for full run inspection.

Use Plasmo entry points and its generated manifest. The extension service worker owns browser requests and state. A local native messaging helper calls Windmill with host-only credentials. Do not substitute a generic website or custom extension bundler.

Read .codex/skills/plasmo/SKILL.md and the relevant references before extension changes. Read ~/.claude/plugins/frontend-design/skills/frontend-design/SKILL.md before UI work. If that file is absent, report the absence and use the available frontend-ui-engineering skill.

## Planning and delivery

Use Backlog for all task state, decisions, documentation, and evidence references. Read doc-001, doc-002, and doc-003 before starting a feature task. Use CLI commands for all Backlog mutations.

Deliver vertical slices that include UI, service-worker behavior, data behavior, tests, and documentation. Keep each slice independently committable and testable. Record the implementation plan only after reading and activating the task.

Use BB Workflows only for substantive implementation, such as features, cross-layer bug fixes, or independent parallel tasks. Handle small documentation, configuration, and focused maintenance changes directly. Do not launch subagents for routine edits.

The default dispatcher for substantive implementation is .bb/workflows/deliver-slices.js. Use provider codex, model gpt-6.1-sol, reasoningLevel medium for workers. Use provider codex, model gpt-6-astra, reasoningLevel medium for every task review.

Run two or three workers at once when dependencies and file ownership permit. Use temporary detached Git worktrees only for concurrent implementation. Sequential tasks share the feature checkout. Serialize shared-document updates and integration. Do not force concurrency through dependencies or shared-file conflicts.

Use one named branch per feature, shared by all of its Backlog tasks. Do not create a branch per task. Use the feature branch authorized for the current work as the integration branch. Main merges require a user instruction. Use focused Conventional Commits. Do not push, publish, or upload without a user instruction. Backlog remoteOperations stays false. After a successful merge, remove clean temporary worktrees and delete merged local feature branches. Keep uncommitted or unmerged work. Do not use forced deletion.

## Review and completion

Add or update automated tests when behavior lacks coverage. Reproduce bugs with a regression test before fixing them. Run affected tests during implementation.

For substantive implementation, Astra reviews the actual changed source and tests with /ponytail:ponytail-review, correctness, security, and race checks. Handle small changes directly with relevant tests and a direct review.

The final integrated source must pass the full applicable automated suite, lint, typecheck, and build once. Codex must drive the actual built extension in Chrome for the changed user journey. Use the toolbar popup, native side panel, and background behavior when relevant. A mockup or extension page in a normal tab does not satisfy this check. Automation can drive the journey, but Codex must inspect its results.

Reuse passing results when the tested source does not change. After a fix, repeat affected tests and Chrome actions. Repeat the full suite only when subsequent changes or unresolved concerns justify it. Do not require the same suite at every worker, review, and integration stage.

Keep one concise completion note in Backlog with commands and outcomes, Chrome actions and results, limitations, review verdict, and commit. Normal test logs suffice. Screenshots and traces are optional unless needed to diagnose or review a failure. Do not require file fingerprints, evidence inventories, tool-version dumps, per-phase receipts, or separate criterion JSON files.

Use production Chrome fixtures for deterministic behavior. Require a live-instance check when the change needs live compatibility proof. State the limits of fixture and live coverage. Missing relevant tests, failing checks, or unavailable Chrome capabilities keep the task open.

Workers leave substantive tasks In Progress. Apply reviewed commits once and shared documentation serially through Backlog. The serial Astra reviewer checks proven criteria, writes the final summary, marks Done, and commits metadata. The current agent can finalize small changes directly after the relevant checks.

Keep accepted findings, fixes, and unresolved blockers in task notes. Structured workflow findings contain only current actionable defects. Resolved findings and historical limitations stay in notes and do not block approval. Allow at most two fixes and three reviews per gate. Retain worktrees for recovery without repeated preparation or cherry-picks.

## Runtime and tools

Mise must pin runtimes before project code. Use pnpm or Bun, never npm. Run project commands through mise tasks. Run mise install when a pinned tool is missing.

Run dev servers, watchers, and test suites in named tmux sessions. Keep normal test logs and record command outcomes in task notes. Search contents with rg and locate files with fd or rg --files. Do not use grep, find, tree, or ls -R.

When .codegraph exists, use CodeGraph before locating or reading code. Follow /Users/vulture/.codex/RTK.md for shell commands. Prefix shell commands with rtk.

Prefer rewriting an existing component over adding a parallel one. Flag obsolete files. Use less code. Do not add speculative dependencies or abstractions.

## Safety and secrets

Use structured logging and handle errors explicitly. Do not silently convert failed live requests into demo results. Check inputs at trust boundaries and test concurrent paths. Do not log secrets, tokens, private inputs, or personal data.

Before creating environment variables or wiring connection configuration, ask for 1Password Environments or a plain .env unless Backlog records the choice. Never bundle a secret into extension assets. Keep host secrets in environment variables and gitignore their paths.

A 1Password mount is a named pipe with zero bytes on disk. Read it only on the host. Do not bind-mount it into a container. Do not inspect or print its values. The desktop MCP route needs an unlocked app and in-app approval.

A host environment file is not directly accessible to a Chrome extension. The user selected 1Password and mounted root .env with WMILL_URL and WMILL_API_KEY. Use the native messaging helper described in decision-004 and doc-003. Do not copy the FIFO or credentials to worktrees. Production credentials must not enter standing test containers.

## Writing

Use plain English. Do not use em dashes, emoji, or gradients unless the user asks. Update affected Backlog documentation when behavior changes. State where a code snippet belongs. Do not describe edited code as remaining unchanged.


<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.52.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
