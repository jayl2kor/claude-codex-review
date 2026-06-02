# CCR Start Here

Use this page when you are not sure which CCR document or command to open first. It routes by job, not by implementation area.

## I Am Installing CCR For The First Time

Start with:

- [quickstart.md](quickstart.md)
- `ccr-help`
- `ccr-ready`
- `ccr-check`

Outcome: both agents are registered, the target repository is enabled, and automatic review routing is ready.

## I Need The Exact Commands For A Task

Start with:

- [examples.md](examples.md)
- [commands.md](commands.md)

Use this path for first automatic review, manual architecture/security review, stale review recovery, support bundle collection, post-upgrade checks, and retention cleanup.

## I Own A Repository Rollout

Start with:

- [adoption-checklist.md](adoption-checklist.md)
- [rollout.md](rollout.md)
- [templates.md](templates.md)

Outcome: owner, setup evidence, first review evidence, support policy, retention policy, and rollback path are all recorded.

## I Am Debugging A Problem

Start with:

- [troubleshooting.md](troubleshooting.md)
- [faq.md](faq.md)
- `ccr-status`
- `ccr-check`
- `ccr-events`
- `ccr-doctor`

Use `ccr-preview` when the question is specifically "why did no automatic review start?"

## I Need A Support Bundle

Start with:

- [automation.md](automation.md)
- [security.md](security.md)
- `ccr-support --print`

Default support bundles exclude request, review, diff, delta, and worker-followup payloads. Use `ccr-support --include-diffs --print` only after approval.

## I Am Automating Setup Or CI Checks

Start with:

- [automation.md](automation.md)
- [validation.md](validation.md)
- `ccr-selftest --json`
- `ccr-check --json`
- `ccr-ready --json`
- `ccr-preview --json`

Use Python to parse JSON outputs; CCR does not require `jq`.

## I Need Security Or Privacy Policy

Start with:

- [security.md](security.md)
- [glossary.md](glossary.md)

Use this path before sharing support bundles, allowing `--include-diffs`, changing retention, or deciding whether a review should return `NEEDS_HUMAN`.

## I Am Upgrading Or Rolling Back

Start with:

- [upgrade.md](upgrade.md)
- [validation.md](validation.md)
- `ccr-selftest --json`
- `ccr-check --json`
- `ccr-uninstall`

Remember that `ccr-uninstall` is dry-run by default; add `--apply` only when you intend to remove installed files and hook entries.

## I Am Maintaining CCR Itself

Start with:

- [architecture.md](architecture.md)
- [release-notes.md](release-notes.md)
- [validation.md](validation.md)
- [index.md](index.md)

Keep generated command registries, `ccr-help`, README links, docs index entries, and validation checks aligned whenever user-facing behavior changes.

