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

## migration-phase-3-lock-state-git

- [x] Port the I/O layer to `src/lib/io.ts` (`now`, `loadJson`, `writeJson`, `appendJsonl`, `readText`) with byte-stable serialization (`pyJsonCompactSorted` for the sort_keys compact form; `getOrNull` for dict.get None semantics).
- [x] Port path/identity helpers to `src/lib/paths.ts` (`workspaceId`, `surfaceId`, `rootForCwd`, `sessionDir`, ...).
- [x] Port the locked state + status/dirty/session updates to `src/lib/lock.ts`, reimplementing the fcntl.flock advisory lock as an O_EXCL lockfile with stale recovery (semantics preserved; D8/D9).
- [x] Port the git/diff-collection shell to `src/lib/git.ts` (`git`, `insideGit`, `readUntrackedPatch`, `collectDiff` with node:crypto sha256, `computeDeltaPatch`), reusing the Phase 2a pure diff helpers.
- [x] Add `splitlinesKeepends` to `pycompat.ts` for `readUntrackedPatch`.
- [x] Add the oracle integration test (`test/phase3.test.ts` + `test/phase3-probe.py`): byte-parity for state/status/dirty/session.json + events.jsonl, full `collectDiff` tuple incl. sha256 diff_hash, against parallel temp dirs / a shared temp git repo.
- [x] Mark Phase 3 done in `docs/ccr-js-migration-plan.md` and record divergences D7/D8/D9.
- [x] Re-run `bun test`, `bun run typecheck`, `bun run check:sync` (full suite green; templates unchanged).

## reviewer-parallel-8-lens

- [x] Replace the reviewer "Review process" block (6 subagents/6 lenses) with a parallel-code-review-style 8-lens (A1–A8) independent review: root-cause duplicate clustering, local evidence verification, rare-finding preservation.
- [x] Apply identically in `request_markdown` and `scope_request_markdown` across the three byte-synced sources: `ccr.sh` heredoc, `templates/bin/ccr-hook.py`, `src/lib/request.ts`.
- [x] Preserve the decision contract byte-for-byte (`REVIEW_DECISION:` + Must Fix/Should Consider/Verdict) so `parse_decision` / `_count_must_fix_in_text` are unaffected.
- [x] Verify: `check:sync` byte-identical, `typecheck` clean, differential (request/scope vs Python oracle) green, full suite green; rendered request shows A1–A8 + decision line and no "Spawn 6".

## reviewer-parallel-8-lens-r1-fixes

- [x] MF2: remove the severity->bucket mapping from both request builders; defer classification to the existing Must Fix / Should Consider bar (ccr.sh + templates + request.ts).
- [x] MF3: add `test/request-contract.test.ts` content assertions (A1–A8, parallel framing, methodology, unchanged decision sections, no "Spawn 6", no severity mapping).
- [x] MF4: `read_untracked_patch`/`readUntrackedPatch` re-run `safe_rel_path` on the symlink-RESOLVED repo-relative path to block in-tree symlinks to sensitive targets (ccr.sh + templates + git.ts) + regression test.
- [x] MF5: pass `--no-ext-diff --no-textconv` on staged+unstaged `git diff` in `collect_diff`/`collectDiff` (ccr.sh + templates + git.ts) + textconv regression test.
- [x] MF6: per-acquisition `pid:nonce` lock token (precise reclaim/release) + same-PID-prior-stale regression test; document the cross-runtime flock boundary as D10 (push-back: inherently impossible 0-dep, runtimes never coexist).
- [x] MF1: update the session `intent.md` to cover the full diff (Phase 3 + prompt upgrade + these fixes).
- [x] Re-verify: `check:sync`, `typecheck`, differential, full suite all green.

## reviewer-parallel-8-lens-r2-fixes

- [x] MF1: `lock.ts` tracks in-process held tokens (`HELD_TOKENS`); reentrant `lockedState` on the same root throws instead of reclaiming the live outer lock; reclaim skips a held token; release clears it. Added nested-lock + sequential-not-reentrant regression tests (D9 updated).
- [x] MF2: `test/request-contract.test.ts` parameterizes the FULL prompt contract (A1–A8, methodology, decision sections, negatives) across BOTH `requestMarkdown` and `scopeRequestMarkdown`.
- [x] MF3: diff-helper hardening tests now cover `--no-textconv` AND `--no-ext-diff` for BOTH staged and unstaged paths (helper scripts kept outside the repo).
- [x] Should-Consider: confirmed the user chose the CCR-native (skill-style, not skill-invoking) implementation; non-goal stands.
- [x] Re-verify: `typecheck`, `check:sync`, lock stability (3x), full suite green.

## reviewer-parallel-8-lens-r3-fixes

- [x] MF1: `lockedState` canonicalizes the root via `realpathSync` after `mkdirSync` and uses that single canonical lock/state path for acquire/reclaim/release + `HELD_TOKENS`, closing the symlink/alias bypass of the reentrancy guard (D9 updated). Added a nested-via-symlink-alias regression test.
- [x] Re-verify: `typecheck`, lock stability (3x), full suite, `check:sync` all green.

## reviewer-parallel-8-lens-r4-fixes

- [x] MF1: reaper sentinel is owner-tokenized + reclaimed only when its owner PID is dead (removed the mtime-based steal); state.lock unlink re-verifies both reaper-token ownership and `cur === observed`; reaper released only if still ours.
- [x] MF2: `sanitize` remaps all-dots segments (`.`/`..`/…) to underscores in `text.ts` + `ccr.sh` + `templates/bin/ccr-hook.py`, preventing `sessionDir` path traversal; added differential cases + a `sessionDir` containment test.
- [x] MF3: `writeJson` (io.ts) and `publishLock` (lock.ts) use a random temp name + `O_EXCL` no-follow create; Python `write_json` mirrors via `tempfile.mkstemp` + `os.replace` (ccr.sh + templates); added hostile-symlink regression tests.
- [x] Should-Consider (PID reuse): documented accepted caveat (errs safe — blocks, never steals; lease/heartbeat out of scope for a same-runtime advisory lock).
- [x] Re-verify: `typecheck`, `check:sync`, lock stability (3x), full suite (811 pass / 0 fail) all green.

## reviewer-parallel-8-lens-r5-fixes

- [x] MF1: actually land the Python `write_json` hardening (it was claimed but missing) — `tempfile.mkstemp` + `os.replace` + cleanup-on-failure in `ccr.sh` + `templates/bin/ccr-hook.py`; added a Python-oracle hostile-symlink regression test.
- [x] MF2: replace the read-then-unlink reaper cleanup (TOCTOU) with an atomic rename-claim (`detachReaper`) + `restoreReaper` for dead-reaper cleanup and release; added a concurrent-dead-reaper-sentinel regression test.
- [x] Should-Consider: `writeJson` (io.ts) + `publishLock` (lock.ts) clean the random temp on ANY failure (write/close/rename/link), not just on success.
- [x] Re-verify: `typecheck`, `check:sync`, lock stability (3x), full suite (813 pass / 0 fail) all green.

## reviewer-parallel-8-lens-r6-fixes

- [x] MF1: replace the file+reaper lock (which had a recurring reaper race) with a DIRECTORY lock at `<root>/state.lock.d` — atomic `mkdir` acquire + `O_EXCL` owner-file write; dead-holder reclaim via atomic `rename` of the dir (race-free because the dir blocks all new acquirers). Removed the reaper entirely; rewrote lock regression tests; added owner-less-init reclaim + a no-pre-existing-lock pure-contention test (D8/D9 updated).
- [x] Should-Consider: update the `io.ts` `writeJson` docblock to the randomized-exclusive-temp behavior; add a `writeJson` serialization-failure temp-cleanup test.
- [x] Re-verify: `typecheck`, `check:sync`, lock stability (3x), full suite (815 pass / 0 fail) all green.

## reviewer-parallel-8-lens-r7-fixes

- [x] MF1: dir-lock owner publication does a FULL write (`writeAllSync`) then verifies `readOwner(ownerPath) === myToken` before returning (no stolen-lock proceed), with `removeOwnedDir` cleanup on publish failure; added corrupt/empty/owner-less reclaim tests.
- [x] MF2: `appendJsonl` opens `O_NOFOLLOW` (TS + Python `os.open`) so a hostile `events.jsonl` symlink is refused; symlink regression added.
- [x] MF3: `computeDeltaPatch` writes via shared `writeFileAtomic` (random temp + `O_EXCL` + rename; Python `tempfile.mkstemp` + `os.replace`); hostile-dest-symlink regression added.
- [x] Factored `writeFileAtomic`/`writeAllSync` in `io.ts` (reused by `writeJson` + `computeDeltaPatch`).
- [x] Should-Consider: `writeJson` rename-failure (dest is a dir) temp-cleanup test; fixed the stale `publishLock` doc reference (D8 / hardening summary).
- [x] Re-verify: `typecheck`, `check:sync`, Python syntax, lock stability (3x), full suite (821 pass / 0 fail) all green.

## reviewer-parallel-8-lens-r8-fixes

- [x] MF1: drop the path-based `removeOwnedDir` cleanup on publish failure (it could unlink a NEW live holder's dir at the same path); just rethrow and leave the owner-less dir for the grace-reclaim path. Added an owner-less-leftover-under-contention regression.
- [x] MF2: add Python-oracle symlink negative tests via the probe (new `compute-delta-patch` op): symlinked `events.jsonl` makes Python `append_jsonl` raise (O_NOFOLLOW); symlinked `delta.patch` is replaced not clobbered by Python `compute_delta_patch`.
- [x] Re-verify: `typecheck`, `check:sync`, Python syntax, lock stability (3x), full suite (824 pass / 0 fail) all green.

## reviewer-parallel-8-lens-r9-fixes

- [x] MF1: publish the lock owner ATOMICALLY (private temp inside dir + `linkSync` to `owner`; record `HELD` on link success), so a write/close failure before the link leaves an owner-less (self-healing) dir and never a partial/live owner that's never released. Identity-safe temp cleanup.
- [x] Fix the reclaim race the new test exposed: serialize reclaim via an atomic `mkdir` reclaim-lock and re-read the owner under it before renaming (no live dir can be renamed); `reclaimDeadLock` uses `rmSync` recursive; reclaim-lock is age-stealable (microsecond hold).
- [x] Added deterministic crashed-mid-publish reclaim test; previously-flaky contention test now stable (0/8, lock describe 14-pass ×5).
- [x] Re-verify: `typecheck`, `check:sync`, lock stability (5x), full suite (825 pass / 0 fail) all green.

## migration-phase-4a-session-review-report-helpers

- [x] Port FS session/intent/ledger helpers to `src/lib/session.ts`: `captureSessionContext`, `loadSessionContext`, `loadSessionIntent`, `appendLedger`, `buildIterationTable`, `loadReviewInstructions` (kept `intent.ts` pure; reuse its `extractIntentFromMessage`).
- [x] Port review-flow FS helpers to `src/lib/review.ts`: `findPreviousRoundDir`, `parsePreviousReview`, `buildWorkerFollowup`.
- [x] Port report FS helpers to `src/lib/report.ts`: `latestSessionId`, `roundMustFixCount`, `roundFilesTouched`.
- [x] Add `CONFIG_ROOT` + `sessionIntentPath` to `paths.ts`.
- [x] Extend `test/phase3-probe.py` with Phase 4a oracle ops; add `test/phase4.test.ts` (byte/return parity vs Python on shared/parallel temp dirs).
- [x] Verify: `typecheck`, `check:sync` (ccr.sh/templates untouched), full suite (847 pass / 0 fail).
## migration-phase-4b1-cmux

- [x] Port the cmux surface/role layer to `src/lib/cmux.ts`: `cmux`, `cmuxLog`, `cmuxStatus`, `cmuxNotify`, `sendToSurface`, `roleForCurrentSurface`, `surfaceForRole`, `workspaceEnabled`.
- [x] Add `ENABLED_FILE` + `workspaceConfigDir` to `paths.ts`.
- [x] Tests (`test/phase4b.test.ts` + probe ops): role/surface oracle parity via an isolated unique workspace under CONFIG_ROOT; workspace_enabled safe false-paths; sendToSurface empty-surface guard. (Subprocess success/exit branches not unit-tested — Bun spawnSync ignores runtime PATH overrides so a fake cmux can't be substituted; faithful port verified by review.)
- [x] Verify: `typecheck`, `check:sync`, full suite (853 pass / 0 fail).
## migration-phase-4b2a-report-reaper

- [x] Port `generate_session_report` + `_try_generate_report` to `report.ts` (reuses latestSessionId/roundMustFixCount/roundFilesTouched/countChangedLines/formatDuration/fencedMarkdownBlock).
- [x] Port `consume_skip_marker`, `_active_request_age_seconds`, `reap_stale_active` to `review.ts`; add `skipMarkerPath` to `paths.ts`.
- [x] `cmux.ts`: resolve the `cmux` binary against the live PATH (`resolveCmuxBin`) so a fake cmux can be substituted in tests (Bun spawnSync's bare-command lookup doesn't honor a runtime PATH override; explicit lookup matches Python's execvp).
- [x] Oracle test `test/phase4b2.test.ts` (probe ops generate-report/reap-stale/consume-skip): report.md + status.json + events.jsonl byte-parity, reaper (age/mismatch/no-op + status/events), skip marker. Full suite 861 pass / 0 fail.
## migration-phase-4b2b-orchestration-dispatch

- [x] Port `start_review` + `finish_review` to `review.ts` (mutate state in place; reuse collectDiff/computeDeltaPatch/requestMarkdown/session+report helpers/cmux/lock; match `{n:04d}` paths, exact handoff message strings, and active_request/last_completed key order).
- [x] New `hooks.ts`: `handlePreTool`, `handleUserPromptSubmit`, `handleHook` (lockedState callback captures the result via a closure var, returning the Python-key-order result dict), `ensureInfoExclude`.
- [x] Probe ops (`test/phase3-probe.py`): start-review / finish-review / handle-pre-tool / handle-user-prompt / handle-hook / ensure-info-exclude.
- [x] Oracle test `test/phase4b2b.test.ts`: end-to-end (UserPromptSubmit→dirty→Stop[start_review]→reviewer Stop[finish_review]) byte-parity over round files/review/decision/ledger/context/report/status/events + state & active_request key order; handle_pre_tool 5 cases; handle_user_prompt_submit reset/handoff; handle_hook safe gate paths (ENABLED_FILE untouched); ensure_info_exclude idempotency. Fake cmux on PATH + isolated workspace under CONFIG_ROOT + shared temp git repo.
- [x] JSON contract (risk 7): handleHook returns the result dict with Python key order; the byte-exact hook stdout serialization is deferred to the Phase 5 CLI. Regex (risk 4): parse_decision / mutating-tool classification reused from already-validated decision.ts/tool.ts.
- [x] Verify: `typecheck`, `check:sync` (44 files), full suite (874 pass / 1 skip / 0 fail).
- [ ] **Phase 4 complete.** Remaining: Phase 5 — TS CLI (`cli.ts`/`commands/*.ts`) + exact hook-stdout serialization, parity verification, then remove `templates/bin/ccr-hook.py` and `ccr.sh`.
