---
description: Preview whether the current diff is eligible for automatic CCR review.
allowed-tools: Bash(ccr-preview:*), Bash(ccr-status:*)
---

# CCR Preview

Preview the current git diff and automatic review blockers:

```sh
ccr-preview $ARGUMENTS
```

Summarize whether auto-review would run, then list blockers and notes. This command must not create review rounds or consume skip markers.
