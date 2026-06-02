---
description: Run installed CCR runtime smoke tests.
allowed-tools: Bash(ccr-selftest:*), Bash(ccr-doctor:*)
---

# CCR Self-Test

Run the installed runtime smoke tests:

```sh
ccr-selftest $ARGUMENTS
```

Summarize failed tests first. If the command fails, suggest `ccr-doctor` for environment diagnostics and `bash ccr.sh` to reinstall generated files.
