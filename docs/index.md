# Project Index

## Overview

This repository contains **Claude-Codex Review Loop for cmux**. It installs a hook-based workflow that runs Claude Code and Codex side by side in a cmux workspace so one agent can work and the other can review the resulting git diff.

The main implementation is the single installer script:

- [`ccr.sh`](../ccr.sh): installs CCR commands, hook scripts, Claude/Codex hook configuration, slash-command files, self-tests, and runtime helpers.

The primary user guide is:

- [`README.md`](../README.md): language switcher for the primary user guide. The full text (setup, daily usage, commands, configuration, safety rules, troubleshooting, uninstall) lives in [`docs/i18n/README.en.md`](i18n/README.en.md) (English, default) and [`docs/i18n/README.ko.md`](i18n/README.ko.md) (한국어).
- [`start-here.md`](start-here.md): role-based route to the right CCR document or command.
- [`quickstart.md`](quickstart.md): shortest install, setup, first-review, and recovery path.
- [`examples.md`](examples.md): task-oriented command recipes for common CCR workflows.
- [`faq.md`](faq.md): common setup, routing, review, support, and retention questions.
- [`commands.md`](commands.md): command reference grouped by setup, daily flow, inspection, diagnostics, and maintenance.
- [`glossary.md`](glossary.md): runtime terms used in status, reports, events, and troubleshooting.
- [`troubleshooting.md`](troubleshooting.md): scenario-based recovery steps for setup, handoff, stale reviews, stops, support bundles, and cleanup.
- [`automation.md`](automation.md): JSON output, CI checks, onboarding scripts, and support bundle workflows.
- [`rollout.md`](rollout.md): phased team and multi-repository adoption guide.
- [`adoption-checklist.md`](adoption-checklist.md): repository-owner checklist for enablement, policy, support, retention, and rollback.
- [`security.md`](security.md): security and privacy defaults for payloads, support bundles, retention, and human review.
- [`validation.md`](validation.md): standard checks before sharing or rolling out changes.
- [`templates.md`](templates.md): copy-paste rollout, repository enablement, support, policy, and validation templates.
- [`upgrade.md`](upgrade.md): reinstall, post-upgrade validation, rollback, purge, and repository state reset guidance.
- [`release-notes.md`](release-notes.md): maintainer handoff summary of the usability/adoption work.
- [`architecture.md`](architecture.md): implementation structure for maintainers extending CCR.

## Module Map

| Area | Location | Purpose |
|---|---|---|
| Installer | [`ccr.sh`](../ccr.sh) | Creates shell commands in `~/.local/bin`, writes hook configuration, creates slash commands, and runs self-tests. |
| Runtime hook engine | Generated from [`ccr.sh`](../ccr.sh) into `~/.local/bin/ccr-cli.js` (Bun bundle) | Handles Claude/Codex hook events, diff collection, review routing, decisions, state, and reports. |
| Shell helpers | Generated from [`ccr.sh`](../ccr.sh) into `~/.local/bin/ccr-lib.sh` | Detects cmux workspace/surface state and registered agent surfaces. |
| User commands | Generated from [`ccr.sh`](../ccr.sh) into `~/.local/bin/ccr-*` | Exposes enable, disable, status, request, cancel, history, events, show, preview, prune, config, check, report, ready, selftest, support, skip-next, reset, and uninstall commands. |
| Claude slash commands | Generated from [`ccr.sh`](../ccr.sh) into `~/.claude/commands` | Adds Claude-side helper commands such as `/ccr-request`, `/ccr-status`, `/ccr-history`, `/ccr-events`, `/ccr-skip-next`, `/ccr-preview`, `/ccr-prune`, `/ccr-config`, `/ccr-check`, `/ccr-report`, `/ccr-ready`, `/ccr-selftest`, `/ccr-doctor`, and `/ccr-support`. |
| Runtime state | `.cmux/ccr/` in the target project | Stores sessions, rounds, request files, diff patches, reviews, decisions, reports, status, and events. |
| Start here | [`docs/start-here.md`](start-here.md) | Routes new users, repository owners, support/debugging, automation, security/privacy, upgraders, and maintainers to the right docs and commands. |
| Quickstart | [`docs/quickstart.md`](quickstart.md) | Gives a 10-minute path through install, surface setup, readiness, first review, and recovery. |
| Examples | [`docs/examples.md`](examples.md) | Gives command recipes for automatic review, manual review, skip, stale recovery, support, preflight, upgrade, and retention tasks. |
| FAQ | [`docs/faq.md`](faq.md) | Answers common setup, routing, review, support, and retention questions. |
| Command reference | [`docs/commands.md`](commands.md) | Groups commands by install/setup, daily review, inspection, diagnostics, support, and maintenance. |
| Glossary | [`docs/glossary.md`](glossary.md) | Defines runtime terms used in status output, reports, events, and troubleshooting. |
| Troubleshooting | [`docs/troubleshooting.md`](troubleshooting.md) | Gives recovery steps for common setup and runtime failures. |
| Automation guide | [`docs/automation.md`](automation.md) | Shows script-friendly JSON outputs, CI gates, and support workflows. |
| Rollout guide | [`docs/rollout.md`](rollout.md) | Defines pilot, onboarding, operating policy, support, retention, and rollback steps. |
| Adoption checklist | [`docs/adoption-checklist.md`](adoption-checklist.md) | Gives repository owners a copyable acceptance checklist for setup, first review, policy, support, retention, rollback, and evidence. |
| Security and privacy | [`docs/security.md`](security.md) | Explains local payload handling, support bundle defaults, retention, and human-review policy. |
| Validation | [`docs/validation.md`](validation.md) | Defines standard checks for docs, scripts, generated commands, rollout, support, and release changes. |
| Templates | [`docs/templates.md`](templates.md) | Provides copy-paste team announcement, repository enablement, support request, policy, and validation handoff templates. |
| Upgrade and rollback | [`docs/upgrade.md`](upgrade.md) | Explains reinstall-style upgrades, preserved state, post-upgrade validation, rollback, purge, and repository reset behavior. |
| Release notes | [`docs/release-notes.md`](release-notes.md) | Summarizes current changes, validation, and follow-up areas for maintainers. |
| Architecture | [`docs/architecture.md`](architecture.md) | Explains generated components, hook flow, state, reports, self-tests, and extension steps. |

## Workflow

1. Install CCR by running `bash ccr.sh`.
2. Open Claude Code and Codex in the same cmux workspace.
3. Register surfaces with `cmux-setup-claude` and `cmux-setup-codex`.
4. Enable CCR in the target repository with `ccr-enable`.
5. Run `ccr-ready` to verify automatic routing is ready.
6. A worker agent changes files.
7. On the worker's Stop hook, CCR collects the git diff and creates a review round.
8. CCR sends the request file path to the opposite agent.
9. The reviewer replies with one decision: `PASS`, `NEEDS_CHANGES`, or `NEEDS_HUMAN`.
10. If changes are requested, the worker is asked to state what was applied and why any item was not applied.
11. In later rounds, CCR includes the previous review, incremental delta, worker's latest response, and touched-file summary in the next review request.
12. CCR routes the result back to the worker and continues or stops according to the decision and loop guards.

CCR marks a turn as reviewable only after known file-mutating tools or Bash commands that look like they modify files. CCR control commands such as `ccr-status`, `ccr-reset`, and read-only test/status commands do not start review rounds by themselves.

New user prompts reset the automatic review round counter only when no review request is active. In-flight reviews keep their round number, diff hash, and request metadata until the reviewer responds or the request is cancelled.

The installer only requires `bun` (the runtime is a bundled Bun CLI). Runtime workflow commands require `cmux`, `claude`, and `codex`; `ccr-doctor` reports those as runtime checks. CCR does not require `jq`; JSON validation is handled by `bun`.

## Command Index

| Command | Purpose |
|---|---|
| `cmux-setup-claude` | Register the current cmux surface as Claude and launch Claude Code. |
| `cmux-setup-codex` | Register the current cmux surface as Codex and launch Codex. |
| `ccr-help` | Print a compact quickstart, daily command map, and diagnostics entry points. |
| `ccr-enable` | Enable automatic review for the current cmux workspace and repository. |
| `ccr-disable` | Disable automatic review for the current cmux workspace. |
| `ccr-status` | Show workspace, surfaces, state, active request, review count, skip marker, and latest report. |
| `ccr-request` | Send a manual scoped review request. |
| `ccr-cancel` | Soft-cancel an active review and clear dirty flags. |
| `ccr-history` | List completed review rounds. |
| `ccr-events [--json]` | Show recent runtime events from `.cmux/ccr/events.jsonl`. |
| `ccr-show` | Show paths for a review round, or print `review.md`. |
| `ccr-preview [--json]` | Explain whether the current diff would be eligible for automatic review without changing CCR state. |
| `ccr-prune` | Dry-run cleanup for old CCR sessions and support bundles; `--apply` removes candidates. |
| `ccr-config [--json]` | Show effective environment settings, active paths, generated command names, and diff exclusions. |
| `ccr-check [--json]` | Run consolidated diagnostics across selftest, doctor, ready, preview, and config state. |
| `ccr-report` | Generate or print a session report. |
| `ccr-ready [--json]` | Strict readiness gate that exits 0 only when automatic review routing can run now. |
| `ccr-selftest [--json]` | Run installed runtime smoke tests without reinstalling CCR. |
| `ccr-skip-next` | Skip the next eligible automatic review. |
| `ccr-reset` | Delete and recreate local `.cmux/ccr` state. |
| `ccr-doctor [--json]` | Diagnose required commands, installed files, hook entries, cmux registration, git state, active requests, and skip markers, then print concrete next actions; `--json` is script-friendly. |
| `ccr-support` | Create a diagnostic support zip with doctor output, state, event tail, and session metadata; payload files require `--include-diffs`. |
| `ccr-uninstall` | Remove CCR commands, slash commands, and hook entries. |

## Runtime Files

Automatic and manual reviews are stored under:

```text
.cmux/ccr/sessions/<session-id>/rounds/<round>/
```

Important files:

| File | Purpose |
|---|---|
| `request.md` | Instructions sent to the reviewer. |
| `diff.patch` | Diff payload being reviewed. |
| `delta.patch` | Round-to-round diff, available from later rounds when changed. |
| `worker-followup.md` | Worker response after the previous review, available from later rounds when present. |
| `review.md` | Reviewer response. |
| `decision.json` | Parsed review decision and metadata. |
| `report.md` | Session-level report generated at terminal states or by `ccr-report`. |

Repository-level CCR state includes:

| File | Purpose |
|---|---|
| `.cmux/ccr/state.json` | Loop state such as active request, review count, and last diff hash. |
| `.cmux/ccr/status.json` | Human-readable status and latest report pointer. |
| `.cmux/ccr/events.jsonl` | Operational event log. |
| `.cmux/ccr/skip-next.json` | One-shot workspace-scoped skip marker. |
| `.cmux/ccr/support/` | Diagnostic zip bundles created by `ccr-support`. |

## Safety And Limits

CCR is designed to reduce same-worktree conflicts:

- Reviewers are blocked from supported mutating tools while reviewer-only mode is active.
- Worker turns are marked dirty only after file-mutating tools or mutating-looking Bash commands.
- Diff collection excludes `.cmux/ccr/`, `.git/`, `.env*`, private key/certificate suffixes, build output folders, dependency folders, and `.open-research/logs/`.
- Large untracked files and combined diffs are bounded by `CCR_MAX_UNTRACKED_BYTES` and `CCR_MAX_DIFF_BYTES`.
- Small automatic reviews can be skipped with `CCR_MIN_DIFF_LINES`.
- Read-only prompts (questions/explanations) and developer `CCR_REVIEW: skip` verdicts suppress the automatic review when `CCR_PROMPT_GATE` is `on` (default); this is suppress-only and never starts a review by itself.

For payload handling, support bundle sharing, retention, and `NEEDS_HUMAN` policy, read [`security.md`](security.md).

## Configuration

| Environment Variable | Default | Purpose |
|---|---:|---|
| `CCR_MAX_ROUNDS` | `3` | Maximum automatic review rounds per user request. |
| `CCR_ROOT` | `<cwd>/.cmux/ccr` | Override runtime state location. |
| `CCR_MAX_UNTRACKED_BYTES` | `200000` | Maximum untracked text file size included in review diffs. |
| `CCR_MAX_DIFF_BYTES` | `300000` | Maximum combined diff payload size sent to reviewer. |
| `CCR_MIN_DIFF_LINES` | `0` | If greater than zero, skip automatic review below this changed-line count. |
| `CCR_PROMPT_GATE` | `on` | Prompt-based suppression of automatic reviews (`on`/`advisory`/`off`). Suppress-only; honors `CCR_REVIEW: skip`/`request`. |

## Where To Start

- For installation and daily usage, read [`README.md`](../README.md).
- If you are unsure where to begin, read [`start-here.md`](start-here.md).
- For the shortest first-run path, read [`quickstart.md`](quickstart.md).
- For task-oriented command recipes, read [`examples.md`](examples.md).
- For common setup and routing questions, read [`faq.md`](faq.md).
- For commands grouped by task, read [`commands.md`](commands.md).
- For runtime terms, read [`glossary.md`](glossary.md).
- For recovery steps by symptom, read [`troubleshooting.md`](troubleshooting.md).
- For JSON output and CI/support examples, read [`automation.md`](automation.md).
- For team or multi-repository rollout, read [`rollout.md`](rollout.md).
- For repository-owner rollout acceptance checks, read [`adoption-checklist.md`](adoption-checklist.md).
- For security and privacy defaults, read [`security.md`](security.md).
- For validation before sharing changes, read [`validation.md`](validation.md).
- For copy-paste rollout and support materials, read [`templates.md`](templates.md).
- For reinstall, upgrade, and rollback guidance, read [`upgrade.md`](upgrade.md).
- For a maintainer handoff summary, read [`release-notes.md`](release-notes.md).
- For implementation structure, read [`architecture.md`](architecture.md).
- For implementation details, inspect [`ccr.sh`](../ccr.sh).
- For review-session artifacts, inspect `.cmux/ccr/sessions/`.
- For operational status, run `ccr-status`.
- For recent operational events, run `ccr-events`.
- For current diff eligibility, run `ccr-preview`.
- For retention cleanup, run `ccr-prune` first and add `--apply` only after reviewing the candidate list.
- For effective settings and env overrides, run `ccr-config`.
- For a one-command diagnostic summary, run `ccr-check`.
- For a strict setup gate after registration, run `ccr-ready`.
- For repeatable installed runtime checks, run `ccr-selftest`.
- For setup or routing problems, run `ccr-doctor` before changing configuration.
- For automation or support bundles, run `ccr-doctor --json` and read the `actions` array.
- For shareable diagnostics, run `ccr-support`; add `--include-diffs` only when request/review/diff contents are safe to share.
