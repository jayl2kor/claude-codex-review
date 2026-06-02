---
description: Check whether automatic CCR review routing is ready now.
allowed-tools: Bash(ccr-ready:*), Bash(ccr-doctor:*)
---

# CCR Ready

Run the strict readiness gate:

```sh
ccr-ready $ARGUMENTS
```

Report `Ready: yes` or `Ready: no`. If it is not ready, summarize the numbered next actions. Use `ccr-doctor` only when the user asks for deeper diagnostics.
