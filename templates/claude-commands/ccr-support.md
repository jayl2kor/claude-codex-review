---
description: Create a CCR diagnostic support bundle zip.
allowed-tools: Bash(ccr-support:*), Bash(ccr-status:*)
---

# CCR Support

Create a portable diagnostic zip with `ccr-doctor --json`, current CCR state, event tail, and latest session metadata.

```sh
ccr-support $ARGUMENTS
```

Summarize the bundle path and whether payload files were included. Do not add `--include-diffs` unless the user explicitly agrees to include review requests, reviews, and diff contents.
