---
description: Run consolidated CCR diagnostics.
allowed-tools: Bash(ccr-check:*), Bash(ccr-doctor:*), Bash(ccr-ready:*)
---

# CCR Check

Run the consolidated CCR diagnostic summary:

```sh
ccr-check $ARGUMENTS
```

Summarize the overall result first, then selftest, doctor, ready, preview, env overrides, and next actions. Use `--json` only when the user asks for machine-readable output.
