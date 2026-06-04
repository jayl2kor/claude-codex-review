# CCR Command Reference

This page groups CCR commands by the job a user is trying to finish. For copy-paste command recipes, see [examples.md](examples.md). For a short first-run path, start with [quickstart.md](quickstart.md). For common command-selection questions, see [faq.md](faq.md). For the end-to-end workflow and runtime file map, see [index.md](index.md). For symptom-based recovery, see [troubleshooting.md](troubleshooting.md). For JSON output and CI/support examples, see [automation.md](automation.md).

Most commands support `--help`. Commands with `--json` are suitable for scripts, CI checks, or support bundles.

## Install And Pair Setup

| Command | Use When | Notes |
|---|---|---|
| `bash ccr.sh` | Installing or reinstalling CCR. | Requires only `bun`; runtime dependencies are checked later. |
| `ccr-help` | You need the shortest local quickstart. | Prints setup steps, daily commands, diagnostics, and docs entry points. |
| `cmux-setup-claude` | Registering the current cmux surface as Claude. | Also launches Claude Code. |
| `cmux-setup-codex` | Registering the current cmux surface as Codex. | Also launches Codex in workspace-write mode. |
| `ccr-enable` | Enabling automatic review for this cmux workspace and repository. | Run from the target git repository. |
| `ccr-disable` | Disabling automatic review for this cmux workspace. | Leaves files and history intact. |
| `ccr-ready [--json]` | Checking whether automatic review can run now. | Strict gate: exits nonzero until setup is complete. |
| `ccr-check [--json]` | Running a one-command diagnostic summary. | Summarizes selftest, doctor, readiness, preview, and config overrides. |

## Daily Review Flow

| Command | Use When | Notes |
|---|---|---|
| `ccr-status` | Checking current CCR state. | Shows surfaces, active request, review count, skip marker, and latest report. |
| `ccr-preview [--json]` | Asking why the current diff would or would not trigger review. | Does not mutate state or consume skip markers. |
| `ccr-request` | Asking the opposite agent for a scoped manual review. | Supports files, dirs, questions, notes, reviewer selection, `--use-diff`, and `--follow-up` (thread the previous round's review + delta). |
| `ccr-skip-next` | Skipping one automatic review. | Workspace-scoped one-shot marker. |
| `ccr-cancel` | Recovering from a stale active review request. | Preserves session history and clears dirty flags. |

## Inspect History And Artifacts

| Command | Use When | Notes |
|---|---|---|
| `ccr-history [--limit N] [--session ID]` | Listing completed rounds. | Latest-first table. |
| `ccr-show [--session ID] [--round N] [--review]` | Finding request/diff/review paths. | `--review` prints `review.md`. |
| `ccr-report [--session ID] [--outcome OUT] [--print]` | Regenerating or printing a session report. | Reports are also auto-generated at terminal states. |
| `ccr-events [--limit N] [--json]` | Inspecting recent runtime events. | Reads `.cmux/ccr/events.jsonl`; default limit is 50. |

## Diagnostics And Support

| Command | Use When | Notes |
|---|---|---|
| `ccr-doctor [--json]` | Diagnosing installation, hooks, cmux registration, git state, active requests, and skip markers. | Text mode includes next actions; JSON is script-friendly. |
| `ccr-selftest [--json]` | Re-running installed runtime smoke tests. | Checks decision parsing, dirty filtering, prompt safety, diff helpers, diagnostics, preview, prune, config, and events. |
| `ccr-config [--json]` | Inspecting effective settings. | Shows env overrides, paths, generated commands, and diff exclusions. |
| `ccr-support [--session ID] [--include-diffs] [--print]` | Creating a portable diagnostic zip. | Excludes request/review/diff payloads unless `--include-diffs` is explicit. |

## Maintenance

| Command | Use When | Notes |
|---|---|---|
| `ccr-prune [--keep N] [--days N] [--apply] [--json]` | Cleaning old sessions and support bundles. | Dry-run by default; defaults to `--keep 20 --days 30`. |
| `ccr-reset` | Wiping local `.cmux/ccr` state for the current repository. | Destructive; removes round history for that repo. |
| `ccr-uninstall [--apply] [--purge]` | Removing installed commands, slash commands, and hook entries. | Dry-run by default; `--purge` also removes CCR config/state caches. |

## Recommended First Checks

After installation and surface registration:

```sh
ccr-ready
ccr-check
ccr-preview
```

When something behaves unexpectedly:

```sh
ccr-status
ccr-events
ccr-doctor
ccr-support
```
