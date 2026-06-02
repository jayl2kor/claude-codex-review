---
description: Skip the next automatic CCR review round (one-shot marker).
allowed-tools: Bash(ccr-skip-next:*), Bash(ccr-status:*)
---

# CCR Skip Next

Place a one-shot marker so the next Stop hook does NOT send a review request. Use for commit-only or chore turns.

```sh
ccr-skip-next
```

Confirm the marker path and run `ccr-status` to show it as `Skip-next: pending`.
