# CCR Rollout Guide

This guide is for adopting CCR across a team or multiple repositories. For role-based document routing, see [start-here.md](start-here.md). For first-run setup, see [quickstart.md](quickstart.md). For task-oriented command recipes, see [examples.md](examples.md). For repository-owner acceptance checks, see [adoption-checklist.md](adoption-checklist.md). For common onboarding questions, see [faq.md](faq.md). For command details, see [commands.md](commands.md). For JSON and CI examples, see [automation.md](automation.md). For security and privacy defaults, see [security.md](security.md). For release checks, see [validation.md](validation.md). For copy-paste rollout materials, see [templates.md](templates.md). For upgrade and rollback steps, see [upgrade.md](upgrade.md).

## Rollout Goals

Use CCR broadly only after these are true:

- Developers can install and verify CCR without manual debugging.
- Each target repository has a clear owner for CCR enablement.
- Teams know how to inspect review artifacts and reports.
- Support bundles can be collected without accidentally sharing diffs.
- Payload sharing, `NEEDS_HUMAN`, and retention policy are understood before broad rollout.
- Old CCR state has a retention policy.
- Uninstall and rollback are documented.

## Phase 1: Local Pilot

Pick one low-risk repository and one Claude/Codex pair.

Setup:

```sh
bash ccr.sh
cmux-setup-claude
cmux-setup-codex
ccr-enable
ccr-ready
ccr-check
```

Pilot acceptance checks:

- `ccr-selftest` passes.
- `ccr-ready` exits `0`.
- `ccr-preview` explains the current diff correctly.
- One automatic review round reaches `PASS` or `NEEDS_CHANGES`.
- `ccr-report --print` produces a readable summary.
- `ccr-support --print` creates a bundle without payload files by default.

## Phase 2: Team Onboarding

Give users three entry points:

- [quickstart.md](quickstart.md) for first-run setup and first review.
- [start-here.md](start-here.md) for role-based docs and command routing.
- [examples.md](examples.md) for copy-paste workflows by task.
- [adoption-checklist.md](adoption-checklist.md) for repository-owner acceptance evidence.
- [faq.md](faq.md) for recurring setup, routing, review, support, and retention questions.
- [commands.md](commands.md) for command lookup.
- [troubleshooting.md](troubleshooting.md) for symptom-based recovery.
- [automation.md](automation.md) for JSON/CI/support workflows.
- [security.md](security.md) for payload, support bundle, retention, and human-review policy.
- [templates.md](templates.md) for announcement, repository enablement, support request, and policy snippets.
- [upgrade.md](upgrade.md) for reinstall, rollback, purge, and repository state reset guidance.

Recommended first commands for each user:

```sh
ccr-help
ccr-selftest
ccr-check
```

Use `ccr-check --json` in onboarding scripts if you want a machine-readable pass/attention summary.

## Phase 3: Repository Enablement

For each repository:

1. Confirm the repository is a git worktree.
2. Start both agents in the same cmux workspace.
3. Register surfaces with `cmux-setup-claude` and `cmux-setup-codex`.
4. Run `ccr-enable` from the target repository.
5. Run `ccr-ready`.
6. Run `ccr-preview` before expecting the first automatic review.

If a repository has very noisy diffs, consider:

```sh
CCR_MIN_DIFF_LINES=5 ccr-enable
```

For large repositories, inspect:

```sh
ccr-config
```

## Phase 4: Operating Policy

Recommended defaults:

- Keep `CCR_MAX_ROUNDS=3` unless a team has a clear reason to raise it.
- Use `ccr-skip-next` for commit-only, formatting-only, or housekeeping turns.
- Use `NEEDS_HUMAN` only for policy, security, or business judgment.
- Use `ccr-cancel` instead of `ccr-reset` for stale active requests.
- Use `ccr-reset` only when local CCR history for the repository should be deleted.

Routine checks:

```sh
ccr-status
ccr-events
ccr-history
```

## Support Workflow

When a user reports a CCR issue:

```sh
ccr-check
ccr-events
ccr-support --print
```

Ask for `--include-diffs` only when request, review, and diff payloads are safe to share:

```sh
ccr-support --include-diffs --print
```

Support triage order:

1. Read `ccr-check` overall result and actions.
2. Inspect `ccr-events` for skipped rounds, stale requests, and reports.
3. Inspect `ccr-ready` failures for setup or surface issues.
4. Inspect `ccr-preview` blockers for diff eligibility issues.
5. Use `ccr-show --review` and `ccr-report --print` for review-specific issues.

## Retention Policy

CCR stores local session history under `.cmux/ccr`. Preview cleanup first:

```sh
ccr-prune
```

Apply only after reviewing candidates:

```sh
ccr-prune --apply
```

Default retention is `--keep 20 --days 30`. Teams with strict storage or privacy requirements should set an explicit cleanup cadence.

## Rollback

Disable CCR without removing installed files:

```sh
ccr-disable
```

Remove installed commands and hook entries:

```sh
ccr-uninstall
ccr-uninstall --apply
```

Remove CCR config/state caches as well:

```sh
ccr-uninstall --apply --purge
```

Local repository runtime state remains under `.cmux/ccr` unless you remove it with `ccr-reset` or delete it manually.

## Rollout Checklist

- [ ] Pilot repository completed one automatic review loop.
- [ ] `ccr-check` action list is understood by the team.
- [ ] `ccr-support` policy for payload sharing is documented.
- [ ] `ccr-prune` retention cadence is chosen.
- [ ] `ccr-disable` and `ccr-uninstall --apply` rollback paths are known.
- [ ] [adoption-checklist.md](adoption-checklist.md) is copied into the repository issue or rollout ticket.
- [ ] Links to [commands.md](commands.md), [troubleshooting.md](troubleshooting.md), and [automation.md](automation.md) are shared with users.
