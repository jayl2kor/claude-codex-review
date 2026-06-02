# CCR Templates

Use these templates when introducing CCR to a team, enabling a repository, opening a support request, or handing off a change for validation. For command recipes, see [examples.md](examples.md). For repository-owner acceptance checks, see [adoption-checklist.md](adoption-checklist.md). For rollout policy, see [rollout.md](rollout.md). For validation gates, see [validation.md](validation.md). For security and privacy defaults, see [security.md](security.md).

## Team Announcement

```markdown
Subject: CCR review loop pilot for <team/repository>

We are piloting CCR, a local Claude/Codex review loop inside cmux.

What changes:
- One agent can work while the opposite agent reviews the resulting git diff.
- Review artifacts stay under `.cmux/ccr/` in the target repository.
- Support bundles exclude request/review/diff payloads by default.

First-run path:
1. Run `bash ccr.sh` from the CCR repository.
2. Start Claude and Codex in the same cmux workspace.
3. Run `cmux-setup-claude` and `cmux-setup-codex` in the matching surfaces.
4. Run `ccr-enable` from the target repository.
5. Run `ccr-ready`, then `ccr-check`, then `ccr-preview`.

Reference docs:
- `docs/quickstart.md`
- `docs/examples.md`
- `docs/adoption-checklist.md`
- `docs/faq.md`
- `docs/security.md`
- `docs/validation.md`
```

## Repository Enablement Issue

```markdown
# Enable CCR for <repository>

Owner: <name>
Target repo: `<path or repo name>`
Pilot window: <dates>

Setup checklist:
- [ ] `bash ccr.sh` completed.
- [ ] Claude surface registered with `cmux-setup-claude`.
- [ ] Codex surface registered with `cmux-setup-codex`.
- [ ] `ccr-enable` run from the target git repository.
- [ ] `ccr-ready` exits 0.
- [ ] `ccr-check` has no blocking failures.
- [ ] `ccr-preview` explains the expected first review behavior.

Policy checklist:
- [ ] Team understands when to use `NEEDS_HUMAN`.
- [ ] `ccr-support --print` is the default support bundle command.
- [ ] `--include-diffs` requires explicit approval.
- [ ] Retention cadence chosen for `ccr-prune`.

Acceptance:
- [ ] One automatic review reaches `PASS` or `NEEDS_CHANGES`.
- [ ] `ccr-report --print` produces a readable session report.
- [ ] `ccr-support --print` creates a payload-free bundle.
- [ ] `docs/adoption-checklist.md` evidence recorded.
```

## Support Request

````markdown
# CCR Support Request

Summary:
<one sentence>

Environment:
- Repository:
- OS/shell:
- Running inside cmux: yes/no
- Claude/Codex surfaces registered: yes/no/unknown

Command outputs:
```text
ccr-status
<paste output>

ccr-check
<paste output>

ccr-preview
<paste output>
```

Support bundle:
- Created with `ccr-support --print`: yes/no
- Payloads included with `--include-diffs`: no by default
- If payloads are included, approval source:

Recent events:
```text
ccr-events --limit 20
<paste output>
```
````

## Human Review Policy Snippet

```markdown
CCR reviewers should use:

- `REVIEW_DECISION: PASS` when no blocking issues remain.
- `REVIEW_DECISION: NEEDS_CHANGES` for routine implementation defects the worker can fix.
- `REVIEW_DECISION: NEEDS_HUMAN` only for policy, security, privacy, ownership, or business judgment.

Examples requiring `NEEDS_HUMAN`:
- sharing request/review/diff payloads outside the team,
- accepting a security tradeoff,
- handling customer, regulated, or proprietary data,
- approving a risky automated fix.
```

## Validation Handoff

```markdown
# CCR Change Validation

Change summary:
- <what changed>

Minimum checks:
- [ ] `bash -n ccr.sh`
- [ ] isolated `bash ccr.sh`
- [ ] isolated `ccr-selftest --json`
- [ ] `ccr-help` mentions current docs entry points
- [ ] README, `docs/index.md`, `docs/README.md`, and `ccr-help` link new user-facing docs

If setup/routing changed:
- [ ] `ccr-check --json`
- [ ] `ccr-ready --json`
- [ ] `ccr-preview --json`

If support/privacy changed:
- [ ] `ccr-support --print` excludes payloads
- [ ] `ccr-support --include-diffs --print` includes payloads only with safe sample data

If retention changed:
- [ ] `ccr-prune --json` dry-run reviewed
- [ ] `ccr-prune --apply --json` tested only in disposable state
```
