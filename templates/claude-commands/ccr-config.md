---
description: Show effective CCR configuration and path settings.
allowed-tools: Bash(ccr-config:*), Bash(ccr-status:*)
---

# CCR Config

Show effective CCR settings:

```sh
ccr-config $ARGUMENTS
```

Summarize environment values, which ones came from env overrides, and the active CCR root. Use `--json` when the user asks for machine-readable config.
