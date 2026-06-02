# CCR Quickstart

This is the shortest path for a new user to install CCR, verify routing, trigger a first review, and recover from the common first-run failures. If you are not sure this is the right entry point, see [start-here.md](start-here.md). For task-oriented recipes, see [examples.md](examples.md). For common questions, see [faq.md](faq.md). For runtime terms, see [glossary.md](glossary.md). For the full command reference, see [commands.md](commands.md). For setup failures by symptom, see [troubleshooting.md](troubleshooting.md).

## 1. Install

From this repository:

```sh
bash ccr.sh
ccr-help
```

Install-time requirement:

- `python3`

Runtime commands are checked after install:

- `cmux`
- `claude`
- `codex`

## 2. Open Both Agents In One cmux Workspace

Open one cmux surface for Claude and one for Codex.

In the Claude surface:

```sh
cmux-setup-claude
```

In the Codex surface:

```sh
cmux-setup-codex
```

If Codex asks to trust hooks, open `/hooks` and trust the CCR hook entries.

## 3. Enable A Repository

From the target git repository:

```sh
ccr-enable
ccr-ready
```

`ccr-ready` exits `0` only when automatic review routing can run now. If it fails, read the numbered actions and run:

```sh
ccr-check
ccr-doctor
```

## 4. Preview The First Review

Before expecting the first automatic review:

```sh
ccr-preview
```

This explains whether the current diff would trigger a review without changing CCR state, consuming skip markers, or sending a handoff.

## 5. Run The First Loop

Make a small file change with one agent. When that worker stops, CCR sends a review request to the opposite agent.

Useful inspection commands:

```sh
ccr-status
ccr-history
ccr-show
```

The reviewer replies with one decision:

- `REVIEW_DECISION: PASS`
- `REVIEW_DECISION: NEEDS_CHANGES`
- `REVIEW_DECISION: NEEDS_HUMAN`

Use `NEEDS_HUMAN` only for policy, security, privacy, or business judgment. Routine defects should use `NEEDS_CHANGES`.

## 6. Recover Fast

If no review starts:

```sh
ccr-check
ccr-ready
ccr-preview
```

If a review is stuck:

```sh
ccr-status
ccr-cancel
```

If you need a support bundle without code or review payloads:

```sh
ccr-support --print
```

Add `--include-diffs` only after confirming request, review, and diff payloads are safe to share.

## 7. Daily Command Map

| Need | Command |
|---|---|
| Short command reminder | `ccr-help` |
| Is setup ready? | `ccr-ready` |
| Broad health check | `ccr-check` |
| Will this diff review? | `ccr-preview` |
| What is CCR doing now? | `ccr-status` |
| What happened recently? | `ccr-events` |
| Show recent rounds | `ccr-history` |
| Print latest review paths | `ccr-show` |
| Skip one automatic review | `ccr-skip-next` |
| Cancel a stale active request | `ccr-cancel` |
| Create diagnostics | `ccr-support` |
