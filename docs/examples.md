# CCR Examples

Use these recipes when you know the job you need to finish and want the exact CCR command sequence. For the shortest first-run path, see [quickstart.md](quickstart.md). For command details, see [commands.md](commands.md). For common questions, see [faq.md](faq.md). For rollout material, see [templates.md](templates.md).

## First Automatic Review

Use this when a new repository should start using the normal worker-to-reviewer loop.

```sh
bash ccr.sh
cmux-setup-claude
cmux-setup-codex
ccr-enable
ccr-ready
ccr-preview
```

Then make a small file change with one agent and let the worker stop. CCR sends the review request to the opposite agent. Inspect the result with:

```sh
ccr-status
ccr-history
ccr-show
```

If no review starts, run:

```sh
ccr-check
ccr-doctor
ccr-events
```

## Manual Architecture Review

Use this when you want review feedback before or after a focused architecture change, without waiting for the automatic Stop hook.

```sh
ccr-request \
  --type architecture_review \
  --file ccr.sh \
  --question "Is the state transition protocol robust?" \
  --question "Are there cases where the loop can overwrite review artifacts?"
```

Add `--use-diff` when the current git diff is relevant context:

```sh
ccr-request \
  --type architecture_review \
  --file ccr.sh \
  --use-diff \
  --question "Does this implementation preserve active review state?"
```

After a `NEEDS_CHANGES` round, add `--follow-up` so the next request threads the
previous review (decision + Must Fix count + review file) and — with `--use-diff`
— an incremental delta of just the changes since that round. Put your
applied/not-applied account in `--note`; the reviewer is told to verify each
claim against the diff rather than trust it:

```sh
ccr-request \
  --type code_review \
  --use-diff \
  --follow-up \
  --note "Applied the null-check at parser.ts:42; skipped the rename (out of scope)."
```

`--follow-up` finds the most recent reviewed round in this workspace, so it
works even though each manual request runs in its own session.

## Manual Security Review

Use this before sharing CCR output, adding support workflows, or changing payload collection.

```sh
ccr-request \
  --type security_review \
  --file ccr.sh \
  --file docs/security.md \
  --question "Could support bundles include request, review, diff, secrets, or private key payloads by default?" \
  --question "Are NEEDS_HUMAN cases routed to the user instead of auto-fixes?"
```

If the reviewer returns `REVIEW_DECISION: NEEDS_HUMAN`, stop the automatic loop and surface the review to the user.

## Skip One Chore Turn

Use this before a commit-only, formatting-only, or metadata-only turn where automatic review would be noise.

```sh
ccr-skip-next
ccr-status
```

The marker is one-shot and workspace-scoped. The first eligible automatic review consumes it. Confirm the next state afterward:

```sh
ccr-events --limit 10
ccr-preview
```

## Recover A Stale Review

Use this when `ccr-status` shows an old active request and the reviewer will not respond.

```sh
ccr-status
ccr-events --limit 20
ccr-cancel
ccr-status
```

`ccr-cancel` clears the active request and dirty flags while preserving session history. If you still need feedback, send a manual review:

```sh
ccr-request --type code_review --use-diff --question "Please review the current diff after the stale request was cancelled."
```

## Collect A Payload-Free Support Bundle

Use this when asking another person to diagnose setup or routing issues.

```sh
ccr-doctor --json
ccr-support --print
```

By default, the bundle excludes `request.md`, `review.md`, `diff.patch`, `delta.patch`, and `worker-followup.md`. Only include payloads after checking policy and repository sensitivity:

```sh
ccr-support --include-diffs --print
```

## CI Or Onboarding Preflight

Use this in local onboarding scripts or a repository enablement checklist.

```sh
ccr-selftest --json
ccr-check --json
ccr-ready --json
ccr-preview --json
```

For shell scripts, treat nonzero exits from `ccr-selftest` and `ccr-ready` as hard failures. Treat `ccr-check` actions as the human-readable fix list.

## Post-Upgrade Check

Use this after pulling a newer `ccr.sh` or reinstalling CCR.

```sh
bash ccr.sh
ccr-selftest --json
ccr-check --json
ccr-ready --json
ccr-help
```

If the upgrade needs to be backed out:

```sh
ccr-uninstall
ccr-uninstall --apply
```

Use `--purge` only when the local CCR config and state caches should also be removed:

```sh
ccr-uninstall --apply --purge
```

## Retention Cleanup Dry Run

Use this before deleting old review sessions or support bundles.

```sh
ccr-prune
ccr-prune --json
```

Review the candidate list first. Then apply cleanup explicitly:

```sh
ccr-prune --apply
```

