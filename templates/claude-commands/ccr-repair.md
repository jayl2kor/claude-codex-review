---
description: Re-pair the current cmux surface for CCR after a surface restart.
allowed-tools: Bash(ccr-repair:*), Bash(ccr-doctor:*), Bash(ccr-status:*)
---

# CCR Repair

Re-pair this surface when the CCR pair broke because a surface was closed and
reopened (a reopened surface gets a fresh id, so its old registration is stale):

```sh
ccr-repair $ARGUMENTS
```

Run this from inside the surface you want to (re)pair. The role is inferred when
only one slot is free or its surface is gone; pass `--role claude|codex` to be
explicit, and `--force` to take over a registration that still points at a live
surface. Report which role was paired and the partner's state. Use `ccr-doctor`
for deeper diagnostics if the partner still looks gone afterward.
