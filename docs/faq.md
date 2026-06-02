# CCR FAQ

This page answers the recurring questions that come up during first-time setup and team rollout. If you are not sure which CCR document fits your job, see [start-here.md](start-here.md). For task-oriented command recipes, see [examples.md](examples.md). For the shortest first-run path, see [quickstart.md](quickstart.md). For runtime terms, see [glossary.md](glossary.md). For commands by task, see [commands.md](commands.md). For symptom-based recovery, see [troubleshooting.md](troubleshooting.md).

## Which Command Should I Run First?

Use this order for a new repository:

```sh
ccr-help
ccr-ready
ccr-check
ccr-preview
```

- `ccr-help` shows the shortest command map and docs entry points.
- `ccr-ready` answers whether automatic routing can run now.
- `ccr-check` gives a broader health summary with action items.
- `ccr-preview` explains whether the current diff would trigger an automatic review.

If setup is still unclear, run:

```sh
ccr-doctor
```

## What Is The Difference Between doctor, ready, check, And preview?

| Command | Best Use |
|---|---|
| `ccr-doctor` | Diagnose installed commands, hooks, cmux registration, git state, active requests, and skip markers. |
| `ccr-ready` | Strict yes/no gate for automatic review routing. |
| `ccr-check` | One command that summarizes selftest, doctor, ready, preview, and config state. |
| `ccr-preview` | Explain whether the current diff would be reviewed without changing CCR state. |

Use `ccr-ready` in setup scripts when a nonzero exit should stop onboarding. Use `ccr-check` when a human wants the broadest local summary.

## Why Did No Automatic Review Start?

Common reasons:

- CCR is not enabled in this cmux workspace.
- Claude and Codex are not registered in the same cmux workspace.
- The current directory is not a git repository.
- The last turn only ran read-only commands or CCR control commands.
- The diff is below `CCR_MIN_DIFF_LINES`.
- The same diff hash was already reviewed.
- `ccr-skip-next` is pending.
- Another review request is already active.

Run:

```sh
ccr-preview
ccr-status
ccr-events
```

## When Should I Use ccr-skip-next?

Use `ccr-skip-next` for a single worker stop that should not create a review:

- commit-only turns,
- formatting-only cleanup already reviewed elsewhere,
- documentation or housekeeping turns the team intentionally wants to skip,
- recovery steps where an automatic handoff would be noise.

The marker is one-shot and workspace-scoped. If several worker sessions share the same cwd, the next eligible worker stop consumes it.

## When Should A Reviewer Use NEEDS_HUMAN?

Use `NEEDS_HUMAN` only when the reviewer is raising policy, security, privacy, or business judgment that another agent should not auto-apply.

Examples:

- deciding whether a support bundle may include diffs,
- approving a security tradeoff,
- handling customer or regulated data,
- escalating a product or ownership decision.

Routine implementation defects should use `NEEDS_CHANGES`.

## What Can I Share For Support?

Start with:

```sh
ccr-support --print
```

By default, support bundles exclude request, review, and diff payloads. Add payloads only after approval:

```sh
ccr-support --include-diffs --print
```

For sharing policy, read [security.md](security.md).

## How Do I Clean Up Old CCR Files?

Preview cleanup candidates first:

```sh
ccr-prune
```

Delete only after reviewing the candidate list:

```sh
ccr-prune --apply
```

The default retention behavior is `--keep 20 --days 30`.

## Does CCR Require jq?

No. Installation requires only `python3`. Runtime workflow commands require `cmux`, `claude`, and `codex`. JSON validation and automation examples use Python.

## Where Are Review Files Stored?

Automatic and manual review rounds are stored under:

```text
.cmux/ccr/sessions/<session-id>/rounds/<round>/
```

Session reports are written to:

```text
.cmux/ccr/sessions/<session-id>/report.md
```

Support bundles are written to:

```text
.cmux/ccr/support/
```
