**English** | [한국어](README.ko.md)

---

# Claude-Codex Review Loop for cmux

`ccr.sh` installs a small hook-based workflow for running Claude Code and Codex side by side inside cmux.

The intended loop is:

1. One agent works on code.
2. Its stop hook writes the current diff and review request into a local session folder.
3. cmux sends the opposite agent a short message containing the request file path.
4. The opposite agent reviews only.
5. The review is written back to the session folder and sent to the original worker.
6. The loop repeats until `PASS`, no meaningful diff remains, the same diff repeats, or the max round limit is reached.

By default, reviewers are not allowed to edit files.

If you are not sure where to begin, start with [`docs/start-here.md`](../start-here.md). For a short first-run path, use [`docs/quickstart.md`](../quickstart.md). For task-oriented command recipes, see [`docs/examples.md`](../examples.md).

## Install

### Via npm (from GitHub)

Install the package (it exposes a single `ccr` command), then run the setup:

```sh
npm i -g github:jayl2kor/cmux
ccr install
```

`ccr install` performs the same machine setup as the script below: it copies the
`ccr-*` command ecosystem into `~/.local/bin`, merges the CCR hooks into
`~/.claude/settings.json` and `~/.codex/hooks.json`, and installs the slash
commands and config templates. After it finishes, `ccr help` lists the commands,
and the individual `ccr-*` wrappers are on your `PATH`.

> The runtime is Bun, so `bun` must be installed (the `ccr` launcher and the
> generated wrappers run under it). `npm` is only used to fetch/update the package.

### Via the script (from a checkout)

From this directory:

```sh
bash ccr.sh
```

Install-time requirement:

- `bun`

Runtime workflow requirements, checked by `ccr-doctor`:

- `cmux`
- `claude`
- `codex`

The installer creates commands in `~/.local/bin` and merges hook entries into:

- `~/.claude/settings.json`
- `~/.codex/hooks.json`

It also adds `~/.local/bin` to `PATH` in `~/.zshrc` if needed.

If the current shell does not see the new commands, run:

```sh
source ~/.zshrc
```

## Start A Pair

Open the target project in cmux, then create two terminal surfaces in the same cmux workspace.

In the Claude terminal:

```sh
cmux-setup-claude
```

In the Codex terminal:

```sh
cmux-setup-codex
```

Then, from the target repository directory in either terminal:

```sh
ccr-enable
ccr-ready
ccr-status
```

For Codex, open `/hooks` once and trust the CCR hooks if Codex asks for review.

## Daily Use

Work normally in either Claude or Codex.

When the working agent changes files and finishes a turn, CCR creates a review round under:

```text
<project>/.cmux/ccr/sessions/<session-id>/rounds/<round>/
```

CCR only marks a turn as reviewable after file-mutating tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `apply_patch`) or Bash commands that look like they modify files. Read-only commands and CCR control commands such as `ccr-status` or `ccr-reset` do not start a review by themselves, even if an older git diff already exists. Read-only output redirects (`2>/dev/null`, `2>&1`, `>/dev/null`) are not treated as mutating, so an investigative turn that only runs such commands will not arm a review.

Important files:

- `request.md`: instructions for the reviewer
- `diff.patch`: diff being reviewed
- `delta.patch`: changes since the previous round, available from round 2 onward when changed
- `worker-followup.md`: worker's latest response after the previous review, available from round 2 onward when present
- `review.md`: reviewer response
- `decision.json`: parsed review decision

The reviewer must include a decision line (own line, near the top of the reply). Exactly one of:

```text
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES
REVIEW_DECISION: NEEDS_HUMAN
```

`NEEDS_HUMAN` is for policy / security / business judgment outside an agent's safe scope. The worker is told to surface the review to the user instead of auto-applying it. Routine code defects should stay as `NEEDS_CHANGES`.

If the reviewer asks for changes, the original worker receives the review file path and can apply the fixes. The worker is asked to briefly state what was applied and why any previous review item was not applied. CCR will run another review round on the next changed diff. From round 2 onward, the request also includes a `delta.patch` (changes since the previous round), a `## Previous Review` section, and a `## Worker Follow-up Since Previous Review` section with the worker's latest response and touched-file summary so the reviewer can focus on new content and verify the worker's claims.

The round counter (`review_count`) resets to `0` on a new user prompt only when no review request is active, so each user request gets a fresh `CCR_MAX_ROUNDS` quota without corrupting in-flight reviews. A previously stopped loop (e.g. hit max rounds) does not block the next request. In-flight reviews are left alone; the reset only affects the counter and the same-diff dedupe hash.

When the loop reaches a terminal state (`passed`, `max_rounds`, `same_hash`, `cancelled`, `needs_human`, or `invalid`), CCR writes a self-contained Markdown summary to `<project>/.cmux/ccr/sessions/<session-id>/report.md`: a 2-3 line outcome summary, metadata table, per-round decisions, files touched (derived from `diff.patch` headers), and embedded `review.md` bodies. The path and short summary are surfaced through `cmux notify`, `cmux log`, and `status.json.last_report` (visible in `ccr-status`). Use `ccr-report` to regenerate or print the report at any time.

## Commands

For first-time setup, see [`docs/quickstart.md`](../quickstart.md).
For role-based document routing, see [`docs/start-here.md`](../start-here.md).
For task-oriented examples, see [`docs/examples.md`](../examples.md).
For common questions, see [`docs/faq.md`](../faq.md).
For commands grouped by workflow, see [`docs/commands.md`](../commands.md).
For runtime terms used in status and reports, see [`docs/glossary.md`](../glossary.md).
For JSON output and CI/support examples, see [`docs/automation.md`](../automation.md).
For team or multi-repository rollout, see [`docs/rollout.md`](../rollout.md).
For repository-owner adoption checks, see [`docs/adoption-checklist.md`](../adoption-checklist.md).
For security and privacy defaults, see [`docs/security.md`](../security.md).
For validation before sharing or rolling out changes, see [`docs/validation.md`](../validation.md).
For copy-paste rollout and support templates, see [`docs/templates.md`](../templates.md).
For reinstall, upgrade, and rollback steps, see [`docs/upgrade.md`](../upgrade.md).
For a maintainer handoff summary, see [`docs/release-notes.md`](../release-notes.md).
For implementation architecture, see [`docs/architecture.md`](../architecture.md).

```sh
ccr-help
```

Prints a compact quickstart, daily command map, and diagnostics entry points. Use it after installation when you do not want to open the README.
It also points to `docs/start-here.md`, `docs/quickstart.md`, `docs/examples.md`, `docs/adoption-checklist.md`, `docs/faq.md`, `docs/commands.md`, and `docs/troubleshooting.md` in this repository.

```sh
ccr-status
```

Shows whether CCR is enabled, the installer version stamp, registered Claude/Codex surfaces, current state, review count, last round result, active request elapsed time, and any pending skip marker.

```sh
ccr-disable
```

Disables CCR for the current cmux workspace.

```sh
ccr-enable
```

Enables CCR for the current cmux workspace and target repo.

```sh
ccr-reset
```

Deletes and recreates the local `.cmux/ccr` state for the current repo. Destructive; also wipes round history.

```sh
ccr-cancel
```

Soft-cancels any active review request (clears `active_request` and dirty flags) while preserving session history. Use this if a reviewer never replies.

```sh
ccr-history [--limit N] [--session ID]
```

Lists completed review rounds in latest-first order. Default limit: 20.

```sh
ccr-events [--limit N] [--json]
```

Shows recent `.cmux/ccr/events.jsonl` runtime events such as dirty markers, skipped rounds, prompt resets, and report generation. Default limit: 50.

```sh
ccr-show [--session ID] [--round N] [--review]
```

Prints the file paths of the latest (or specified) review round. `--review` prints the `review.md` body to stdout.

```sh
ccr-preview [--json]
```

Explains whether the current git diff would be eligible for automatic CCR review. It checks diff content, changed-line threshold, same-diff dedupe, active requests, and pending `ccr-skip-next` markers without marking the session dirty, consuming markers, creating rounds, or sending handoffs.

```sh
ccr-prune [--keep N] [--days N] [--apply] [--json]
```

Dry-run cleanup for old `.cmux/ccr` sessions and support bundles. Defaults to `--keep 20 --days 30`; paths beyond either retention rule are listed. Add `--apply` only when you want to remove the listed artifacts.

```sh
ccr-config [--json]
```

Prints effective CCR settings: environment values and whether they came from defaults or env overrides, the active `CCR_ROOT`, config paths, generated command names, and diff exclusion rules. Use `--json` for automation or support bundles.

```sh
ccr-check [--json]
```

Runs a consolidated diagnostic summary: installed runtime self-tests, `ccr-doctor` summary, strict readiness, current diff preview, and active env overrides. Use it after install or before filing a support issue.

```sh
ccr-skip-next
```

Places a one-shot marker so the next Stop hook does not send a review. Useful for commit-only or chore turns. Does not consume `CCR_MAX_ROUNDS`.

The marker is **workspace-scoped** (lives at `<cwd>/.cmux/ccr/skip-next.json`). If multiple worker sessions share the same workspace and cwd, the first eligible Stop consumes it regardless of which session created it.

```sh
ccr-report [--session ID] [--outcome OUT] [--print]
```

Generates (or regenerates) the Markdown report for the latest or specified session at `.cmux/ccr/sessions/<sid>/report.md` and prints its path. With `--print`, also streams the body to stdout. CCR auto-generates this report when the loop reaches a terminal state, so this command is mainly for manual regeneration or piping.

```sh
ccr-ready [--json]
```

Checks whether automatic review routing is ready **right now** in the current repository and cmux surface. Unlike `ccr-doctor`, this is a strict gate: it exits `0` only when runtime commands are available, hooks and generated commands are installed, both Claude/Codex surfaces are registered, the workspace is enabled, the cwd is a git repo, and no review request is already active. Use it after first setup or in scripts.

```sh
ccr-selftest [--json]
```

Runs installed runtime smoke tests without reinstalling CCR. It checks decision parsing, dirty-trigger filtering, handoff prompt handling, active-review prompt reset safety, diff truncation helpers, and diagnostic JSON paths. Use this after edits to `ccr.sh`, after upgrading CCR, or before sharing a support bundle.

```sh
ccr-doctor [--json]
```

Diagnoses the local CCR installation and current workspace: required commands, generated command files, Claude/Codex hook entries, `PATH`, cmux workspace/surface registration, `ccr-enable` state, git worktree status, active requests, and pending skip markers. Use it first when setup or handoff behavior is unclear. The output ends with concrete next actions. Add `--json` for machine-readable diagnostics in scripts, CI, or issue reports.

```sh
ccr-support [--session ID] [--include-diffs] [--print]
```

Creates `.cmux/ccr/support/ccr-support-*.zip` with `ccr-doctor --json`, version information, current CCR state, recent events, and latest session metadata. By default it excludes review requests, reviews, and diff payloads; add `--include-diffs` only when sharing code/review content is acceptable. Use `--print` to show the zip contents.

```sh
ccr-uninstall [--apply] [--purge]
```

Dry-run by default. `--apply` strips CCR hook entries from `~/.claude/settings.json` and `~/.codex/hooks.json`, then removes installed binaries and slash commands. `--purge` also deletes `~/.config/claude-codex-review` and `~/.local/state/claude-codex-review`. The `~/.zshrc` PATH line is left untouched.

```sh
ccr-request --type architecture_review --file ccr.sh --question "Is the state protocol robust?"
```

Creates a manual scoped review request and sends it to the opposite registered agent. This is useful for architecture, design, security, or test-plan reviews that are not tied to the latest diff.

Claude also gets a `/ccr-request` command after installation. Example:

```text
/ccr-request --type design_review --file docs/architecture.md --question "Does this design fit the current codebase?"
```

Codex currently exposes built-in slash commands only, so use the shell command form from Codex:

```text
Run: ccr-request --type architecture_review --file ccr.sh --question "Where can this fail?"
```

Supported request types:

- `code_review`
- `architecture_review`
- `design_review`
- `test_plan_review`
- `security_review`
- `general_review`

Useful options:

- `--reviewer claude|codex`: explicitly choose the reviewer. Defaults to the opposite registered surface. A request that would route back to the worker itself (same role, or a reviewer surface equal to the worker surface) is refused, so a mis-registered pair or an explicit self-target fails fast instead of looping a review back to you.
- `--file <path>`: add a file to the review scope. Repeatable.
- `--dir <path>`: add a directory to the review scope. Repeatable.
- `--question <text>`: add a concrete review question. Repeatable.
- `--note <text>`: add extra context for the reviewer. Repeatable.
- `--use-diff`: include current git diff as supporting context.
- `--follow-up`: thread the most recent prior review (its decision, Must Fix count, and review file) into the request, plus an incremental `delta.patch` when combined with `--use-diff`. Put your applied / not-applied account in `--note`; the reviewer is told to verify each claim against the diff rather than trust it.

Manual requests are otherwise stateless across calls — each runs in its own `manual-<timestamp>` session — so use `--follow-up` for an iterative manual loop after a `NEEDS_CHANGES` result. It locates the latest reviewed round anywhere under the CCR root:

```sh
ccr-request --type code_review --use-diff --follow-up \
  --note "Applied the null-check at parser.ts:42; skipped the rename (out of scope)."
```

The automatic Stop-triggered loop already threads this context every round; `--follow-up` brings the same behavior to the manual path.

## Configuration

Environment variables:

- `CCR_MAX_ROUNDS`: maximum automatic review rounds. Default: `3`.
- `CCR_ROOT`: override the state root. Default: `<cwd>/.cmux/ccr`.
- `CCR_MAX_UNTRACKED_BYTES`: max untracked text file size included in review diffs. Default: `200000`.
- `CCR_MAX_DIFF_BYTES`: max combined diff size sent to the reviewer. Sections are truncated from the end (untracked first) when over budget. Default: `300000`.
- `CCR_MIN_DIFF_LINES`: if `>0`, skip the automatic review when the diff has fewer than this many `+/-` lines. `0` (default) disables the threshold. Skipped rounds do not consume `CCR_MAX_ROUNDS`.
- `CCR_PROMPT_GATE`: prompt-based gating of automatic reviews. `on` (default) suppresses a review when the user prompt looks read-only (a question/explanation, in English or Korean) or the developer emitted `CCR_REVIEW: skip`; `advisory` only logs what it would do (to `ccr-events`); `off` disables it. It is **suppress-only** — it never starts a review on its own (a real diff is still required), and an explicit `CCR_REVIEW: request` line (or a change/implement request in the prompt) overrides a read-only classification.

The developer agent can end a turn with one plain-text line — `CCR_REVIEW: request` or `CCR_REVIEW: skip` — to tell CCR whether the turn warrants an automatic review; omitting it falls back to the file-change heuristic. This is separate from the reviewer's `REVIEW_DECISION:` line.

Example:

```sh
CCR_MAX_ROUNDS=5 ccr-enable
```

## Safety Rules

CCR intentionally uses files for payloads and sends only file paths through cmux.
For the full security and privacy policy guide, see [`docs/security.md`](../security.md).

The diff collector excludes common sensitive or noisy paths, including:

- `.cmux/ccr/`
- `.git/`
- `.env*`
- private key/certificate suffixes
- `node_modules/`
- common build output directories
- `.open-research/logs/` (generated session logs from the open-research plugin)

Reviewer-only mode blocks supported mutating tools while an agent is acting as reviewer. This reduces same-worktree conflicts.

## Troubleshooting

For scenario-based recovery steps, see [`docs/troubleshooting.md`](../troubleshooting.md).
For short answers to common setup and routing questions, see [`docs/faq.md`](../faq.md).

If `ccr-status` shows missing surfaces, rerun the setup command in each surface:

```sh
cmux-setup-claude
cmux-setup-codex
```

If no review starts, check:

```sh
ccr-status
ccr-doctor
```

Common causes:

- CCR is disabled for the workspace.
- Claude and Codex are not in the same cmux workspace.
- The target directory is not a git repository.
- The last turn did not produce a git diff.
- The last turn only ran non-mutating commands such as `ccr-status`, `ccr-reset`, or tests.
- Codex has not trusted the new hooks in `/hooks`.

`ccr-doctor` prints `[FAIL]` rows for broken installation pieces that usually require rerunning `bash ccr.sh`, `[WARN]` rows for workflow state such as missing cmux registration or a workspace that has not run `ccr-enable` yet, and a numbered `Next actions` section with the commands or checks to perform.

For automation or support bundles, use `ccr-doctor --json`. It returns the same exit-code behavior as text mode: nonzero only when one or more checks fail. JSON output includes `checks`, `summary`, `next`, and `actions`.

If the loop stops with `same diff hash`, the worker did not change the diff after receiving review feedback. Make a new change or run `ccr-reset`.

If the loop stops with `max rounds`, inspect the latest `review.md` and continue manually.

## Uninstall

To disable behavior without removing files:

```sh
ccr-disable
```

To remove the installed hook entries and binaries, run:

```sh
ccr-uninstall          # dry-run: print what would be removed
ccr-uninstall --apply  # actually remove
ccr-uninstall --apply --purge   # also remove ~/.config and ~/.local/state caches
```

The uninstaller strips CCR hook groups from `~/.claude/settings.json` and `~/.codex/hooks.json`, deletes generated commands in `~/.local/bin`, and removes the slash commands under `~/.claude/commands`. The `~/.zshrc` PATH line is left untouched.
