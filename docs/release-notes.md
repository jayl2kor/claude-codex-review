# CCR Usability And Adoption Notes

This document summarizes the current usability and broader-adoption work so another maintainer can quickly understand what changed and where to continue.

## Summary

CCR has been expanded from a single installer/review-loop script into a more operable local workflow with:

- safer automatic review triggering,
- follow-up context for multi-round reviews,
- stronger diagnostics and scriptable JSON outputs,
- support bundles and retention cleanup,
- one-command readiness/check/self-test flows,
- documentation for commands, troubleshooting, automation, and rollout.

The implementation remains centered in [`../ccr.sh`](../ccr.sh). User-facing documentation now starts at [index.md](index.md).

## Major Runtime Improvements

### Review Triggering

- Automatic reviews are marked dirty only after known mutating tools or mutating-looking Bash commands.
- Read-only commands, test runs, and CCR control commands do not start reviews by themselves.
- New user prompts reset `review_count` only when no review request is active.
- CCR handoff prompts include a sentinel so they do not reset round counters.

### Multi-Round Review Context

- Round 2+ requests include previous review metadata.
- `delta.patch` captures round-to-round changes when available.
- `worker-followup.md` records the worker's latest response when present.
- Request text asks reviewers to verify worker claims rather than assume they are correct.

### Safety And Limits

- `NEEDS_HUMAN` is a first-class terminal decision for policy/security/business judgment.
- Diff collection excludes `.open-research/logs/` in addition to existing sensitive/noisy paths.
- `CCR_MAX_DIFF_BYTES` caps combined review payload size.
- `CCR_MIN_DIFF_LINES` can skip small automatic reviews.
- Same-diff and max-round terminal states generate reports.

## New And Expanded Commands

Setup and quickstart:

- `ccr-help`
- `ccr-ready`
- `ccr-check`

Daily review and inspection:

- `ccr-preview`
- `ccr-events`
- `ccr-history`
- `ccr-show`
- `ccr-report`
- `ccr-skip-next`
- `ccr-cancel`

Diagnostics and support:

- `ccr-doctor --json`
- `ccr-selftest --json`
- `ccr-config --json`
- `ccr-support`

Maintenance:

- `ccr-prune`
- `ccr-uninstall`

All generated command names are tracked in `GENERATED_BIN_NAMES` inside [`../ccr.sh`](../ccr.sh). Claude slash command files are tracked in `GENERATED_CLAUDE_COMMAND_FILES`.

## Documentation Added

- [start-here.md](start-here.md): role-based route to the right CCR document or command.
- [quickstart.md](quickstart.md): shortest install, setup, first-review, and recovery path.
- [examples.md](examples.md): task-oriented command recipes for common CCR workflows.
- [faq.md](faq.md): common setup, routing, review, support, and retention questions.
- [commands.md](commands.md): command reference grouped by workflow.
- [glossary.md](glossary.md): runtime terms used in status, reports, events, and troubleshooting.
- [troubleshooting.md](troubleshooting.md): symptom-based recovery steps.
- [automation.md](automation.md): JSON output, CI checks, onboarding scripts, and support workflows.
- [rollout.md](rollout.md): phased team and multi-repository adoption plan.
- [adoption-checklist.md](adoption-checklist.md): repository-owner checklist for rollout acceptance evidence.
- [security.md](security.md): security and privacy defaults for payloads, support bundles, retention, and human review.
- [validation.md](validation.md): standard checks before sharing or rolling out changes.
- [templates.md](templates.md): copy-paste rollout, repository enablement, support, policy, and validation templates.
- [upgrade.md](upgrade.md): reinstall, post-upgrade validation, rollback, purge, and repository state reset guidance.
- [release-notes.md](release-notes.md): this handoff summary.
- [architecture.md](architecture.md): generated components, hook flow, state, self-tests, and extension checklist.

## Recommended Validation

For the maintained validation checklist, see [validation.md](validation.md).

After editing `ccr.sh`:

```sh
bash -n ccr.sh
```

After changing generated commands or runtime helpers, run an isolated install:

```sh
tmp_home=/private/tmp/ccr-home-$$
tmp_cwd=/private/tmp/ccr-cwd-$$
mkdir -p "$tmp_home" "$tmp_cwd"
env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID HOME="$tmp_home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" bash ccr.sh
cd "$tmp_cwd"
env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID HOME="$tmp_home" PATH="$tmp_home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" ccr-selftest
env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID HOME="$tmp_home" PATH="$tmp_home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" ccr-doctor --json
```

For documentation-only changes:

```sh
rg -n "start-here.md|quickstart.md|examples.md|adoption-checklist.md|faq.md|commands.md|glossary.md|troubleshooting.md|automation.md|rollout.md|security.md|validation.md|templates.md|upgrade.md|release-notes.md|architecture.md" README.md docs ccr.sh
```

## Operational Entry Points

For a new user:

```sh
ccr-help
ccr-check
ccr-ready
```

For a user asking why review did not start:

```sh
ccr-preview
ccr-events
ccr-status
```

For support:

```sh
ccr-check
ccr-doctor
ccr-support --print
```

For team rollout:

```sh
ccr-selftest
ccr-ready
ccr-check
```

## Known Follow-Up Areas

- Keep command lists in [commands.md](commands.md), [index.md](index.md), and `GENERATED_BIN_NAMES` aligned.
- Consider adding generated-command metadata directly from one source if the shell script grows further.
- Consider a small fixture-based test harness outside the installer if self-tests become too large.
- Keep support bundle defaults conservative; payload files should remain opt-in.
- Prefer `bun` examples over `jq` for JSON parsing so install-time dependencies stay minimal (`bun` is the sole install-time prerequisite).
