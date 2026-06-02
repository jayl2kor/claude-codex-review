---
description: Diagnose CCR installation, hooks, cmux, git, and runtime state.
allowed-tools: Bash(ccr-doctor:*), Bash(ccr-status:*)
---

# CCR Doctor

Run the diagnostic command:

```sh
ccr-doctor
```

For machine-readable diagnostics:

```sh
ccr-doctor --json
```

Summarize failures first, then warnings, then the numbered Next actions. If there are hook or command failures, tell the user to rerun `bash ccr.sh`. If the only warnings are cmux/workspace registration warnings, tell the user which setup command is missing. Use `--json` only when the user asks for scriptable output or a support bundle; in that case summarize the `actions` array.
