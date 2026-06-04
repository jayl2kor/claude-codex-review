# CCR Glossary

Use this glossary when reading CCR status output, review artifacts, events, and troubleshooting docs. For the first-run flow, see [quickstart.md](quickstart.md). For command selection, see [faq.md](faq.md).

| Term | Meaning |
|---|---|
| cmux workspace | The shared cmux workspace that contains both Claude and Codex terminal surfaces. CCR routes handoffs only inside the current workspace. |
| surface | A single cmux terminal surface. `cmux-setup-claude` registers one surface as Claude; `cmux-setup-codex` registers another as Codex. |
| worker | The agent that changed files and triggered a review request. |
| reviewer | The opposite agent that receives `request.md` and must review without editing files. |
| dirty marker | A local `.cmux/ccr/sessions/<session-id>/dirty.json` marker created after a mutating tool or mutating-looking Bash command. A Stop hook uses this marker to decide whether a review may start. |
| active request | The in-flight review recorded in `.cmux/ccr/state.json` as `active_request`. While it exists, new automatic review starts are ignored and normal user prompts do not reset the round counter. |
| review round | One automatic or manual review attempt stored under `.cmux/ccr/sessions/<session-id>/rounds/<round>/`. |
| review count | The per-user-request automatic round counter. It resets on a new user prompt only when no active request exists. |
| diff hash | The SHA-256 hash of the full pre-truncation diff payload. CCR uses it to stop loops when the same diff is sent again. |
| same diff | A terminal guard where the current diff hash matches the last reviewed diff hash. The loop stops instead of sending the same review again. |
| skip marker | A one-shot `.cmux/ccr/skip-next.json` marker created by `ccr-skip-next`. The next eligible automatic review consumes it and skips the handoff. |
| terminal state | A loop-ending outcome such as `passed`, `max_rounds`, `same_hash`, `cancelled`, `needs_human`, or `invalid`. Terminal states generate or update a session report. |
| session report | `.cmux/ccr/sessions/<session-id>/report.md`, a Markdown summary of rounds, decisions, touched files, and embedded reviews. |
| support bundle | A zip created by `ccr-support` under `.cmux/ccr/support/`. It excludes request/review/diff payloads unless `--include-diffs` is explicit. |
| `NEEDS_CHANGES` | Reviewer decision for routine defects the worker can address through the normal loop. |
| `NEEDS_HUMAN` | Reviewer decision for policy, security, privacy, or business judgment that should be surfaced to the user instead of auto-applied by an agent. |
| `CCR_ROOT` | Optional environment override for where repository-level CCR runtime state is stored. Default: `<cwd>/.cmux/ccr`. |

## Status Terms

Common values shown by `ccr-status`, reports, or events:

| Status | Meaning |
|---|---|
| `idle` | CCR is enabled but no review is pending. |
| `dirty` | A worker changed files and the next Stop hook may create a review. |
| `waiting_for_review` | A review request was sent and CCR is waiting for the reviewer. |
| `changes_requested` | The reviewer returned `NEEDS_CHANGES`; the worker should apply valid feedback. |
| `passed` | The reviewer returned `PASS`. |
| `manual_intervention` | A human or manual workflow is required, usually for `NEEDS_HUMAN` or an invalid decision. |
| `skipped` | CCR intentionally skipped a review — e.g. `ccr-skip-next`, `CCR_MIN_DIFF_LINES`, or the prompt gate (`CCR_PROMPT_GATE`: a read-only prompt or a developer `CCR_REVIEW: skip` verdict). |

## Artifact Names

| File | Meaning |
|---|---|
| `request.md` | Instructions and diff path sent to the reviewer. |
| `diff.patch` | Review payload for the current round. |
| `delta.patch` | Difference between the previous round's `diff.patch` and the current round's `diff.patch`. |
| `worker-followup.md` | Worker's latest explanation after previous feedback. |
| `review.md` | Reviewer's response with a `REVIEW_DECISION` line. |
| `decision.json` | Parsed decision and round metadata. |
| `events.jsonl` | Repository-level operational event log consumed by `ccr-events` and support bundles. |
