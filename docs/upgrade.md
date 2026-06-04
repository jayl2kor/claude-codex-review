# CCR Upgrade And Rollback Guide

Use this guide when reinstalling CCR, rolling out a new CCR script, or backing out an installation. For validation checks, see [validation.md](validation.md). For rollout planning, see [rollout.md](rollout.md). For command details, see [commands.md](commands.md).

## Upgrade Model

CCR upgrades are reinstall-style:

```sh
bash ccr.sh
```

The installer rewrites generated files such as:

- `~/.local/bin/ccr-cli.js`
- `~/.local/bin/ccr-*`
- `~/.local/bin/cmux-setup-*`
- `~/.claude/commands/ccr-*.md`

It also merges CCR hook entries into:

- `~/.claude/settings.json`
- `~/.codex/hooks.json`

The installer removes old CCR hook groups before writing the current ones, so rerunning `bash ccr.sh` is the normal upgrade path.

## What Is Preserved

Repository-local CCR state is not deleted by reinstalling:

- `.cmux/ccr/sessions/`
- `.cmux/ccr/state.json`
- `.cmux/ccr/status.json`
- `.cmux/ccr/events.jsonl`
- `.cmux/ccr/support/`

Workspace registration and enablement files under `~/.config/claude-codex-review` are also preserved unless you purge them.

## Post-Upgrade Checks

After reinstalling, run:

```sh
ccr-selftest --json
ccr-help
ccr-check --json
ccr-ready --json
ccr-preview --json
```

Expected results:

- `ccr-selftest --json` reports zero failures.
- `ccr-help` shows the current docs entry points.
- `ccr-check --json` has no unexpected failures.
- `ccr-ready --json` is true in repositories where automatic routing should run.
- `ccr-preview --json` explains current diff eligibility without mutating state.

## Safe Rollback

To stop automatic behavior without removing installed files:

```sh
ccr-disable
```

To remove generated commands, slash commands, and hook entries:

```sh
ccr-uninstall          # dry run
ccr-uninstall --apply
```

To also remove CCR config and global state caches:

```sh
ccr-uninstall --apply --purge
```

`ccr-uninstall --apply --purge` removes `~/.config/claude-codex-review` and `~/.local/state/claude-codex-review`. It does not remove repository-local `.cmux/ccr/` directories.

## Repository State Reset

Use `ccr-reset` only when the current repository's local CCR history and state should be wiped:

```sh
ccr-reset
```

This deletes and recreates `.cmux/ccr` for the current cwd. It is more destructive than `ccr-disable` or `ccr-cancel`.

## Upgrade Checklist

- [ ] Run `bash ccr.sh`.
- [ ] Run `ccr-selftest --json`.
- [ ] Run `ccr-help` and confirm docs entry points are current.
- [ ] Run `ccr-check --json`.
- [ ] Run `ccr-ready --json` in a target repository.
- [ ] Run `ccr-preview --json` before expecting the first post-upgrade review.
- [ ] Keep `ccr-disable` as the first rollback option.
- [ ] Use `ccr-uninstall --apply` only when generated files and hooks should be removed.
- [ ] Use `ccr-uninstall --apply --purge` only when workspace registrations and global CCR config should also be removed.
