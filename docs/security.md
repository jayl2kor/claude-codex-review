# CCR Security And Privacy Guide

This guide summarizes CCR's security and privacy defaults for teams adopting the review loop across more repositories. For command details, see [commands.md](commands.md); for rollout policy, see [rollout.md](rollout.md); for support workflows, see [automation.md](automation.md).

## Data Flow

CCR keeps review payloads on disk and sends file paths through cmux.

- Review requests, diffs, reviews, decisions, reports, and events are written under `.cmux/ccr/` in the target repository.
- Agent handoffs send a short message plus a local file path such as `.cmux/ccr/sessions/<session-id>/rounds/<round>/request.md`.
- `ccr-support` writes diagnostic bundles under `.cmux/ccr/support/`.
- Generated install files live under `~/.local/bin`, `~/.claude/commands`, `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.config/claude-codex-review`.

CCR does not turn review artifacts into remote uploads by itself. Any external sharing happens when a user copies, sends, uploads, or attaches generated files.

## Payload Defaults

Automatic review payloads are bounded and filtered before they are sent to the reviewer.

- `CCR_MAX_UNTRACKED_BYTES` caps each untracked text file included in review diffs.
- `CCR_MAX_DIFF_BYTES` caps the combined diff payload sent to the reviewer.
- `CCR_MIN_DIFF_LINES` can skip small automatic reviews when teams want less background traffic.
- `ccr-preview` shows whether the current diff would be reviewable without changing CCR state.
- `ccr-config` shows effective limits, path settings, generated command names, and diff exclusion rules.

Diff collection excludes common sensitive or noisy paths:

- `.cmux/ccr/`
- `.git/`
- `.env*`
- private key and certificate suffixes
- `node_modules/`
- common build output directories
- `.open-research/logs/`

These exclusions reduce accidental exposure, but they are not a substitute for repository-level secret scanning. Teams should still keep secrets out of source-controlled files and generated review payloads.

## Support Bundles

`ccr-support` is conservative by default.

```sh
ccr-support --print
```

The default bundle includes diagnostic metadata such as doctor output, version information, status, state, event tail, and session metadata. It excludes `request.md`, `review.md`, `diff.patch`, `delta.patch`, and `worker-followup.md`.

Payload files require an explicit opt-in:

```sh
ccr-support --include-diffs --print
```

Use `--include-diffs` only when code, review text, and reviewer comments are approved for the destination support channel. If the bundle will be shared outside the team, prefer the default bundle first and attach payload files only after a human confirms they are safe.

## Human Review Policy

`NEEDS_HUMAN` is reserved for policy, security, or business judgment that should not be auto-applied by another agent.

Use `NEEDS_HUMAN` when a review raises questions such as:

- whether code or review artifacts may be shared with a third party,
- whether a security tradeoff is acceptable for the product,
- whether customer, regulated, or proprietary data may be included in a support bundle,
- whether a risky automated fix should be approved by a repository owner.

Routine implementation defects should stay as `NEEDS_CHANGES` so the worker can fix them through the normal loop.

## Retention

CCR state can accumulate session artifacts over time. Use dry-run cleanup before removing anything:

```sh
ccr-prune
```

Only delete after reviewing the candidate list:

```sh
ccr-prune --apply
```

The default retention behavior is `--keep 20 --days 30`. Teams with stricter storage or privacy requirements should choose an explicit cadence and document it in repository onboarding notes.

## Safe Operating Checklist

- Run `ccr-config` before enabling CCR in repositories with unusual generated files or sensitive local paths.
- Run `ccr-preview` before the first automatic review in a new repository.
- Share `ccr-support --print` output first; add `--include-diffs` only after explicit approval.
- Use `NEEDS_HUMAN` for policy, security, privacy, and business judgment.
- Set a recurring `ccr-prune --apply` cadence for repositories with strict retention rules.
- Keep `.cmux/ccr/` out of commits unless a repository intentionally tracks review artifacts.
