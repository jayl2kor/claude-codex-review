# CCR Adoption Checklist

Use this checklist when enabling CCR for a repository or team. It is intentionally shorter than the full [rollout guide](rollout.md) and is meant to be copied into an issue, ticket, or pull request. For exact command recipes, see [examples.md](examples.md). For policy details, see [security.md](security.md).

## Ownership

- [ ] Repository owner named: `<name>`.
- [ ] Target repository path or name recorded: `<repo>`.
- [ ] Pilot window chosen: `<dates>`.
- [ ] Claude/Codex users know where to find [quickstart.md](quickstart.md), [examples.md](examples.md), and [faq.md](faq.md).

## Prerequisites

- [ ] `python3` is available for installation.
- [ ] `cmux`, `claude`, and `codex` are available for runtime use.
- [ ] The target directory is a git worktree.
- [ ] The team understands that review artifacts are stored under `.cmux/ccr/`.
- [ ] Payload-sharing policy is known before any `ccr-support --include-diffs` bundle is created.

## Setup

```sh
bash ccr.sh
cmux-setup-claude
cmux-setup-codex
ccr-enable
ccr-ready
ccr-check
ccr-preview
```

- [ ] `bash ccr.sh` completed.
- [ ] Claude surface registered.
- [ ] Codex surface registered.
- [ ] `ccr-enable` run from the target repository.
- [ ] `ccr-ready` exits `0`, or its action list is assigned.
- [ ] `ccr-check` has no unexpected failures.
- [ ] `ccr-preview` explains the expected first review behavior.

## First Review

- [ ] One small file change was made by a worker agent.
- [ ] CCR created a request under `.cmux/ccr/sessions/<session-id>/rounds/<round>/`.
- [ ] The opposite agent received the request and did not edit files during review.
- [ ] Review response included exactly one `REVIEW_DECISION` line.
- [ ] The round reached `PASS`, `NEEDS_CHANGES`, or `NEEDS_HUMAN`.
- [ ] `ccr-history` lists the completed round.
- [ ] `ccr-report --print` produces a readable report.

## Operating Policy

- [ ] `CCR_MAX_ROUNDS` policy chosen; default is `3`.
- [ ] `CCR_MIN_DIFF_LINES` policy chosen for noisy repositories; default is `0`.
- [ ] Team knows to use `ccr-skip-next` for commit-only or housekeeping turns.
- [ ] Team knows to use `ccr-cancel` for stale active reviews before considering `ccr-reset`.
- [ ] `NEEDS_HUMAN` criteria are documented for policy, security, privacy, or business judgment.

## Support

```sh
ccr-check
ccr-events
ccr-support --print
```

- [ ] Support workflow starts with `ccr-check` and `ccr-events`.
- [ ] `ccr-support --print` creates a payload-free bundle by default.
- [ ] `--include-diffs` requires explicit approval for request, review, diff, and worker-followup payloads.
- [ ] Support request template from [templates.md](templates.md) is available to users.

## Retention

```sh
ccr-prune
ccr-prune --json
```

- [ ] Retention cadence chosen.
- [ ] Default retention understood: `--keep 20 --days 30`.
- [ ] Cleanup is previewed before `ccr-prune --apply`.
- [ ] Repositories with stricter privacy requirements have an explicit cleanup owner.

## Rollback

```sh
ccr-disable
ccr-uninstall
ccr-uninstall --apply
```

- [ ] Users know `ccr-disable` stops automatic behavior without removing installed files.
- [ ] Users know `ccr-uninstall` is dry-run by default.
- [ ] `ccr-uninstall --apply` rollback path has been tested or accepted.
- [ ] `ccr-uninstall --apply --purge` is reserved for removing CCR config/state caches.
- [ ] Repository-local `.cmux/ccr` cleanup policy is documented separately from uninstall.

## Acceptance Evidence

Attach or record:

- [ ] `ccr-ready` output or `ccr-ready --json` summary.
- [ ] `ccr-check` output or `ccr-check --json` summary.
- [ ] `ccr-preview` output for the first review.
- [ ] First `ccr-history` row.
- [ ] `ccr-report --print` path or summary.
- [ ] `ccr-support --print` file list showing payloads are excluded by default.
- [ ] Chosen retention cadence and rollback owner.

