---
description: Generate (or regenerate) the Markdown report for the latest CCR session.
allowed-tools: Bash(ccr-report:*), Bash(ccr-status:*)
---

# CCR Report

Render a single-file Markdown summary of the latest (or specified) CCR session: outcome, round-by-round decisions, files touched, and embedded review.md bodies. Use after the loop terminates (PASS / max_rounds / same_hash / cancelled / needs_human). Terminal states also auto-generate this report, so this command is mainly for regeneration or printing.

```sh
ccr-report $ARGUMENTS
```

Print the resulting file path. With `--print`, also stream the report body to stdout. Do not run additional commands.
