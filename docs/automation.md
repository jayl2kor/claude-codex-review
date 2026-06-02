# CCR Automation Guide

This guide shows how to use CCR's script-friendly commands in setup scripts, CI jobs, onboarding checks, and support workflows. For command details, see [commands.md](commands.md); for symptom-based recovery, see [troubleshooting.md](troubleshooting.md); for team rollout, see [rollout.md](rollout.md); for payload sharing policy, see [security.md](security.md); for support request templates, see [templates.md](templates.md).

CCR's installer only requires `python3`, so the examples below use Python for JSON parsing instead of `jq`.

## JSON-Capable Commands

| Command | Typical Automation Use |
|---|---|
| `ccr-check --json` | One-command health summary for onboarding or support preflight. |
| `ccr-ready --json` | Strict ready/not-ready gate for automatic review routing. |
| `ccr-doctor --json` | Detailed installation and runtime diagnostics with action items. |
| `ccr-preview --json` | Determine whether the current diff would trigger automatic review. |
| `ccr-config --json` | Capture effective settings, env overrides, paths, generated commands, and exclusions. |
| `ccr-events --json` | Collect recent runtime events for logs or support. |
| `ccr-selftest --json` | Run installed runtime smoke tests. |
| `ccr-prune --json` | Preview retention cleanup candidates. |
| `ccr-support --print` | Create a portable diagnostic zip and list its contents. |

## Setup Preflight

Use `ccr-check --json` after installation and surface registration:

```sh
ccr-check --json > /tmp/ccr-check.json || true
python3 - <<'PY'
import json
doc = json.load(open("/tmp/ccr-check.json"))
print("overall:", doc["overall"])
for action in doc.get("actions", []):
    print("-", action)
raise SystemExit(0 if doc["overall"] == "pass" else 1)
PY
```

This is the broadest single command: it summarizes self-tests, doctor checks, readiness, current diff preview, and env overrides.

## Strict Readiness Gate

Use `ccr-ready --json` when a script should proceed only if automatic handoff can work now:

```sh
ccr-ready --json > /tmp/ccr-ready.json
```

Exit code behavior:

- `0`: automatic routing is ready.
- nonzero: one or more readiness checks failed.

To print actions without `jq`:

```sh
python3 - <<'PY'
import json
doc = json.load(open("/tmp/ccr-ready.json"))
for action in doc.get("actions", []):
    print(action)
PY
```

## Current Diff Eligibility

Use `ccr-preview --json` before expecting an automatic review:

```sh
ccr-preview --json > /tmp/ccr-preview.json || true
python3 - <<'PY'
import json
doc = json.load(open("/tmp/ccr-preview.json"))
print("eligible:", doc["eligible"])
print("changed_lines:", doc["changed_lines"])
for blocker in doc.get("blockers", []):
    print("blocker:", blocker)
PY
```

This command does not mark a session dirty, consume skip markers, create rounds, or send handoffs.

## Support Bundle Workflow

For support without code/review payloads:

```sh
ccr-support --print
```

For support where request, review, and diff payloads are allowed:

```sh
ccr-support --include-diffs --print
```

Use `--include-diffs` only after confirming that sharing code and review content is acceptable.

## Event Log Collection

To capture the latest runtime events:

```sh
ccr-events --limit 100 --json > /tmp/ccr-events.json
```

The event log is useful for understanding skipped rounds, dirty markers, prompt resets, report creation, and manual interventions.

## Effective Config Snapshot

Use `ccr-config --json` to capture the exact settings a machine is using:

```sh
ccr-config --json > /tmp/ccr-config.json
```

The output includes whether each environment value came from a default or an env override.

## Retention Cleanup

Always dry-run first:

```sh
ccr-prune --json > /tmp/ccr-prune.json
```

Apply only after reviewing candidates:

```sh
ccr-prune --apply --json
```

Defaults are `--keep 20 --days 30`.

## Minimal Onboarding Script

```sh
#!/usr/bin/env bash
set -euo pipefail

ccr-selftest
ccr-doctor --json > /tmp/ccr-doctor.json || true
ccr-ready --json > /tmp/ccr-ready.json || true

python3 - <<'PY'
import json
doctor = json.load(open("/tmp/ccr-doctor.json"))
ready = json.load(open("/tmp/ccr-ready.json"))
print("doctor:", doctor["summary"])
print("ready:", ready["ready"])
if not ready["ready"]:
    for action in ready.get("actions", []):
        print("-", action)
raise SystemExit(0 if ready["ready"] and doctor["summary"]["fail"] == 0 else 1)
PY
```
