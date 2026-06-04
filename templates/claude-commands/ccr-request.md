---
description: Send a scoped CCR review request to the opposite cmux agent.
allowed-tools: Bash(ccr-request:*), Bash(ccr-status:*)
---

# CCR Request

Create a scoped review request for the opposite cmux agent.

Usage examples:

```sh
ccr-request --type architecture_review --file ccr.sh --file README.md --question "Is the protocol robust?"
ccr-request --reviewer codex --type code_review --file src/app.ts --use-diff
ccr-request --reviewer claude --type design_review --dir docs --question "Does this design fit the codebase?"
# Follow-up after a NEEDS_CHANGES round: thread the previous review + an incremental delta.
ccr-request --type code_review --use-diff --follow-up --note "Applied X at file:line; skipped Y (reason)."
```

`--reviewer auto` (the default) routes to the opposite agent. Pass `--follow-up`
to include the most recent prior review and, with `--use-diff`, a delta of just
the changes since that round.

Run this shell command with the user's arguments:

```sh
ccr-request $ARGUMENTS
```

Then summarize the request file path and current CCR status. Do not perform the requested review yourself.
