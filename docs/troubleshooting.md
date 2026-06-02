# CCR Troubleshooting

Use this guide when CCR is installed but the loop is not behaving as expected. For first-run setup, see [quickstart.md](quickstart.md). For common questions, see [faq.md](faq.md). For runtime terms, see [glossary.md](glossary.md). For command details, see [commands.md](commands.md). For JSON output and CI/support examples, see [automation.md](automation.md). For payload sharing and retention policy, see [security.md](security.md). For reinstall or rollback, see [upgrade.md](upgrade.md).

## Fast Triage

Run these first from the target repository:

```sh
ccr-check
ccr-status
ccr-preview
```

If setup still looks unclear:

```sh
ccr-doctor
ccr-events
```

If you need to share diagnostics:

```sh
ccr-support
```

By default, `ccr-support` does not include request, review, or diff payloads.

## Commands Are Missing

Symptoms:

- `ccr-status: command not found`
- `cmux-setup-claude: command not found`
- `ccr-doctor` reports missing generated command files

Recovery:

```sh
bash ccr.sh
source ~/.zshrc
ccr-selftest
ccr-doctor
```

If `~/.local/bin` is still not in `PATH`, open a new shell or inspect:

```sh
ccr-config
```

## Pair Setup Is Not Ready

Symptoms:

- `ccr-ready` exits nonzero
- `ccr-status` shows missing Claude or Codex surface
- review handoff is not sent to the other agent

Recovery:

```sh
cmux-setup-claude
cmux-setup-codex
ccr-enable
ccr-ready
```

Run each setup command in the matching cmux surface. Both surfaces must be in the same cmux workspace.

## No Automatic Review Starts

Check whether the current diff is eligible:

```sh
ccr-preview
```

Common blockers:

- Current directory is not a git worktree.
- There is no git diff.
- The turn only ran non-mutating commands such as tests, `ccr-status`, or `ccr-reset`.
- `CCR_MIN_DIFF_LINES` is set and the diff is below the threshold.
- `ccr-skip-next` is pending.
- The current diff hash matches the last reviewed diff.
- A review request is already active.

Useful commands:

```sh
ccr-status
ccr-events
ccr-config
```

## Active Review Is Stale

Symptoms:

- `ccr-status` shows an old active request.
- Worker stops are ignored with a review already active.
- The reviewer surface never replied.

Recovery:

```sh
ccr-status
ccr-show
ccr-cancel
ccr-ready
```

`ccr-cancel` clears the active request and dirty flags while preserving session history.

## Same Diff Or Max Rounds Stops The Loop

If the loop stops with `same diff hash`, the worker did not change the reviewed diff after feedback.

```sh
ccr-show --review
ccr-preview
```

Make a real change or continue manually.

If the loop stops with `max rounds`, inspect the latest review and report:

```sh
ccr-show --review
ccr-report --print
```

Then decide whether to continue manually, raise `CCR_MAX_ROUNDS`, or stop.

## Needs Human

`NEEDS_HUMAN` is for policy, security, or business judgment outside an agent's safe scope.

Use:

```sh
ccr-show --review
ccr-report --print
```

Do not auto-apply the review. Surface the relevant review and report to the user.

## Support Bundle And Sensitive Payloads

For support without code payloads:

```sh
ccr-support --print
```

To include request, review, and diff payloads:

```sh
ccr-support --include-diffs --print
```

Use `--include-diffs` only when sharing code and review content is acceptable.

## Runtime State Is Too Large

Preview cleanup first:

```sh
ccr-prune
```

Apply cleanup only after reviewing candidates:

```sh
ccr-prune --apply
```

Defaults are `--keep 20 --days 30`.

## Last-Resort Reset

Use `ccr-reset` only when local CCR state for the current repository should be wiped:

```sh
ccr-reset
ccr-enable
ccr-ready
```

This deletes local `.cmux/ccr` history for the current repository.
