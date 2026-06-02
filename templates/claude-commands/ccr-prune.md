---
description: Dry-run cleanup for old CCR sessions and support bundles.
allowed-tools: Bash(ccr-prune:*), Bash(ccr-status:*)
---

# CCR Prune

Preview or apply retention cleanup:

```sh
ccr-prune $ARGUMENTS
```

Default behavior is dry-run with `--keep 20 --days 30`. Do not add `--apply` unless the user explicitly asks to delete old CCR artifacts.
