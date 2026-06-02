# TODO

## docs-index

- [x] Confirm current project purpose from root README and installer script.
- [x] Create `docs/README.md` to describe the new documentation folder.
- [x] Create `docs/index.md` as the project documentation entry point.
- [x] Review generated documentation for path accuracy.

## review-trigger-filter

- [x] Identify why `ccr-reset` could trigger automatic review.
- [x] Restrict dirty marking to file-mutating tools and mutating-looking Bash commands.
- [x] Add installer self-tests for non-mutating CCR control commands.
- [x] Update README and docs index with the new review trigger rule.

## review-followup-context

- [x] Add worker follow-up context to second and later review requests.
- [x] Persist worker follow-up text as `worker-followup.md`.
- [x] Include touched-file summary and delta path in follow-up requests.
- [x] Update worker instructions after `NEEDS_CHANGES` to explain applied and not-applied items.
- [x] Document the follow-up context in README and docs index.
- [x] Use the full pre-truncation diff to populate follow-up touched-file summaries.

## usability-broader-adoption

- [x] Add `ccr-doctor` to diagnose installation, cmux, hooks, PATH, git, and runtime state.
- [x] Add a Claude slash command for `ccr-doctor`.
- [x] Document the diagnostic workflow in README and docs index.
- [x] Add self-tests for doctor helper behavior.
- [x] Fix installer hook-merge compatibility with Python 3.9-style annotation evaluation.
- [x] Run syntax and installer self-tests in an isolated HOME.

## active-request-reset-safety

- [x] Preserve `review_count` and `last_diff_hash` while a review request is in flight.
- [x] Add installer self-test covering normal user prompt during active review.
- [x] Clarify in README and docs index that active reviews are not reset by new prompts.
- [x] Rerun syntax and isolated installer self-tests.

## doctor-automation-output

- [x] Add `ccr-doctor --json` for scriptable diagnostics.
- [x] Keep text `ccr-doctor` output and exit-code behavior compatible.
- [x] Document JSON diagnostics in README, docs index, and Claude command help.
- [x] Add installer self-test for JSON doctor output.
- [x] Rerun syntax and isolated installer self-tests.

## doctor-action-items

- [x] Add concrete next actions to `ccr-doctor` text output.
- [x] Include action items in `ccr-doctor --json` for automation.
- [x] Document action items in README and docs index.
- [x] Add installer self-test for action item generation.
- [x] Rerun syntax and isolated installer self-tests.

## reduce-install-dependencies

- [x] Remove hard `jq` dependency from installer.
- [x] Replace final `jq empty` validation with Python JSON validation.
- [x] Update `ccr-doctor` required command checks and action items.
- [x] Document runtime prerequisites without `jq`.
- [x] Rerun isolated installer self-tests without `jq` in PATH.

## split-install-runtime-dependencies

- [x] Require only `python3` at install time.
- [x] Keep `cmux`, `claude`, and `codex` as doctor/runtime checks.
- [x] Update doctor action item for missing runtime commands.
- [x] Document install-time vs runtime prerequisites.
- [x] Rerun isolated installer self-tests without `cmux`, `claude`, `codex`, or `jq` in PATH.

## shell-quick-help

- [x] Add `ccr-help` command with quickstart, command map, and diagnostics.
- [x] Include `ccr-help` in uninstall and doctor installed-file checks.
- [x] Document `ccr-help` in README and docs index.
- [x] Verify isolated install creates and runs `ccr-help`.

## support-bundle

- [x] Add `ccr-support` command that creates a portable diagnostic zip.
- [x] Include `ccr-support` in doctor, uninstall, help, and slash commands.
- [x] Document the support bundle workflow in README and docs index.
- [x] Verify isolated install creates and runs `ccr-support`.

## readiness-gate

- [x] Add `ccr-ready` command that exits 0 only when automatic review routing is ready.
- [x] Include `ccr-ready` in doctor, uninstall, help, and slash commands.
- [x] Document readiness checks in README and docs index.
- [x] Verify isolated install creates and runs `ccr-ready`.

## runtime-selftest

- [x] Add `ccr-selftest` command for repeatable installed runtime checks.
- [x] Include `ccr-selftest` in doctor, uninstall, help, and slash commands.
- [x] Document self-test workflow in README and docs index.
- [x] Verify isolated install creates and runs `ccr-selftest`.

## review-preview

- [x] Add `ccr-preview` command that explains whether the current diff is reviewable.
- [x] Include `ccr-preview` in doctor, uninstall, help, and slash commands.
- [x] Document preview workflow in README and docs index.
- [x] Verify isolated install creates and runs `ccr-preview`.

## retention-prune

- [x] Add dry-run-first `ccr-prune` command for old sessions/support bundles.
- [x] Include `ccr-prune` in doctor, uninstall, help, and slash commands.
- [x] Document retention cleanup in README and docs index.
- [x] Verify isolated install creates and runs `ccr-prune`.

## effective-config

- [x] Add `ccr-config` command showing effective environment and path settings.
- [x] Include `ccr-config` in doctor, uninstall, help, and slash commands.
- [x] Document config inspection in README and docs index.
- [x] Verify isolated install creates and runs `ccr-config`.

## event-log-viewer

- [x] Add `ccr-events` command for recent runtime event logs.
- [x] Include `ccr-events` in doctor, uninstall, help, and slash commands.
- [x] Document event log inspection in README and docs index.
- [x] Verify isolated install creates and runs `ccr-events`.

## consolidated-check

- [x] Add `ccr-check` command that summarizes selftest, doctor, ready, preview, and config state.
- [x] Include `ccr-check` in doctor, uninstall, help, and slash commands.
- [x] Document consolidated check workflow in README and docs index.
- [x] Verify isolated install creates and runs `ccr-check`.

## command-reference-doc

- [x] Create `docs/commands.md` with commands grouped by workflow.
- [x] Link command reference from README and docs index.
- [x] Verify every generated user command appears in the command reference.

## troubleshooting-doc

- [x] Create `docs/troubleshooting.md` with scenario-based recovery steps.
- [x] Link troubleshooting guide from README, docs index, and command reference.
- [x] Verify troubleshooting guide mentions the main diagnostic commands.

## automation-doc

- [x] Create `docs/automation.md` for JSON outputs, CI checks, and support bundle workflows.
- [x] Link automation guide from README, docs index, command reference, and troubleshooting.
- [x] Verify automation guide covers the main script-friendly commands.

## rollout-doc

- [x] Create `docs/rollout.md` for team and multi-repository adoption.
- [x] Link rollout guide from README, docs index, docs README, and automation guide.
- [x] Verify rollout guide covers pilot, readiness gates, support, retention, and rollback.

## release-notes-doc

- [x] Create `docs/release-notes.md` summarizing the usability/broader-adoption work.
- [x] Link release notes from README, docs index, and docs README.
- [x] Verify release notes cover commands, docs, safety, diagnostics, and validation.

## architecture-doc

- [x] Create `docs/architecture.md` explaining installer, generated runtime, hooks, state, and reports.
- [x] Link architecture guide from README, docs index, docs README, and release notes.
- [x] Verify architecture guide covers state machine, generated commands, selftests, and extension checklist.

## security-doc

- [x] Create `docs/security.md` covering local payload handling, exclusions, support bundles, retention, and human-review policy.
- [x] Link the security guide from README, docs index, docs README, rollout, automation, troubleshooting, and release notes.
- [x] Verify the guide covers `ccr-support`, `--include-diffs`, `ccr-prune`, `NEEDS_HUMAN`, `CCR_MAX_DIFF_BYTES`, and sensitive path exclusions.

## quickstart-doc

- [x] Create `docs/quickstart.md` as a 10-minute install, setup, first-review, and recovery path.
- [x] Link the quickstart from README, docs index, docs README, commands, troubleshooting, rollout, and release notes.
- [x] Verify the guide covers `bash ccr.sh`, `cmux-setup-claude`, `cmux-setup-codex`, `ccr-enable`, `ccr-ready`, `ccr-check`, `ccr-preview`, `ccr-status`, and `ccr-doctor`.

## faq-doc

- [x] Create `docs/faq.md` answering common setup, routing, review, diagnostics, support, and retention questions.
- [x] Link the FAQ from README, docs index, docs README, quickstart, commands, troubleshooting, rollout, and release notes.
- [x] Verify the FAQ covers `ccr-ready`, `ccr-check`, `ccr-doctor`, `ccr-preview`, `ccr-skip-next`, `ccr-support`, `NEEDS_HUMAN`, and `ccr-prune`.

## help-discovery

- [x] Update `ccr-help` to point users to `ccr-ready`, `ccr-check`, `ccr-preview`, and the new docs entry points.
- [x] Update command documentation so `ccr-help` reflects the quickstart and FAQ flow.
- [x] Verify isolated install creates a `ccr-help` output that mentions quickstart, FAQ, readiness, and first-review commands.

## validation-doc

- [x] Create `docs/validation.md` with standard checks for docs-only, script, generated command, rollout, support, and release changes.
- [x] Link validation guidance from README, docs index, docs README, architecture, release notes, rollout, and ccr-help.
- [x] Verify the guide covers `bash -n ccr.sh`, isolated `bash ccr.sh`, `ccr-selftest --json`, `ccr-help`, `ccr-check --json`, `ccr-ready --json`, `ccr-preview --json`, and support-bundle checks.

## glossary-doc

- [x] Create `docs/glossary.md` defining common CCR runtime and workflow terms.
- [x] Link the glossary from README, docs index, docs README, quickstart, FAQ, troubleshooting, architecture, and ccr-help.
- [x] Verify the guide covers workspace, surface, worker, reviewer, dirty marker, active request, review round, diff hash, skip marker, terminal state, support bundle, and `NEEDS_HUMAN`.

## templates-doc

- [x] Create `docs/templates.md` with copy-paste team announcement, repository enablement, support request, policy, and validation handoff templates.
- [x] Link templates from README, docs index, docs README, rollout, automation, validation, and ccr-help.
- [x] Verify the guide covers `ccr-ready`, `ccr-check`, `ccr-preview`, `ccr-support --print`, `ccr-prune`, `NEEDS_HUMAN`, and support payload policy.

## template-rendering

- [x] Fix nested Markdown fences in `docs/templates.md` so support request snippets render correctly.
- [x] Add a lightweight documentation fence-balance verification.
- [x] Rerun syntax and isolated installer self-tests.

## docs-quality-check

- [x] Add Markdown fence-balance checks to `docs/validation.md`.
- [x] Mention documentation rendering checks in the architecture extension checklist.
- [x] Verify the documented check passes for `README.md`, `TODO.md`, and `docs/*.md`.

## upgrade-doc

- [x] Create `docs/upgrade.md` covering reinstall, preserved state, post-upgrade validation, rollback, and purge behavior.
- [x] Link upgrade guidance from README, docs index, docs README, rollout, troubleshooting, validation, release notes, and ccr-help.
- [x] Verify the guide covers `bash ccr.sh`, `ccr-selftest --json`, `ccr-check --json`, `ccr-ready --json`, `ccr-uninstall --apply`, `ccr-uninstall --apply --purge`, `ccr-disable`, and `ccr-reset`.

## examples-doc

- [x] Create `docs/examples.md` with task-oriented CCR workflows.
- [x] Link examples from the main README, docs index, docs README, quickstart, FAQ, commands, rollout, templates, release notes, and `ccr-help`.
- [x] Verify examples cover first automatic review, manual reviews, skip, stale-review recovery, support bundles, CI/onboarding preflight, and post-upgrade checks.

## validation-entrypoint-refresh

- [x] Update validation checks so new docs entry points such as `docs/examples.md` are included.
- [x] Update maintainer/release checklists to keep help text and docs entry points in sync.
- [x] Verify the refreshed checks pass for the current documentation set.

## adoption-checklist-doc

- [x] Create `docs/adoption-checklist.md` as a repository-owner checklist for broader rollout.
- [x] Link the adoption checklist from README, docs index, docs README, rollout, templates, release notes, validation, and `ccr-help`.
- [x] Verify the checklist covers owner, prerequisites, setup, first review, policy, support, retention, rollback, and acceptance evidence.

## start-here-doc

- [x] Create `docs/start-here.md` as a role-based documentation entry point.
- [x] Link start-here from README, docs index, docs README, release notes, validation, and `ccr-help`.
- [x] Verify start-here routes new users, repository owners, support/debugging, automation, security/privacy, upgraders, and maintainers.

## folder-readme-compliance

- [x] Audit non-generated project folders for missing README files.
- [x] Add README files for existing `.omc/`, `.omc/state/`, and `.omc/sessions/` folders.
- [x] Re-run the folder README audit excluding generated/runtime-heavy `.git`, `.cmux`, and `.open-research` trees.

## migration-phase-2b-request-builders

- [x] Port `request_markdown`/`scope_request_markdown` from `templates/bin/ccr-hook.py` to `src/lib/request.ts` (verbatim instruction blocks, reuse text/intent/pycompat helpers).
- [x] Register both functions in `test/golden-probe.py` ALLOWED_FUNCTIONS as the Python oracle.
- [x] Add oracle differential cases for both builders (`request_markdown` 24, `scope_request_markdown` 22) covering optional-arg tails, multibyte/emoji, backtick fence escalation, long-message truncation, and empty-dict edges.
- [x] Fix the empty-dict truthiness divergence the oracle caught (`pyTruthyObj` mirrors Python `if d:`).
- [x] Mark Phase 2b done in `docs/ccr-js-migration-plan.md` and record the Path-stringification modeling caveat (D7).
- [x] Re-run `bun test`, `bun run typecheck`, and `bun run check:sync` (736 pass / 0 fail; templates unchanged).
