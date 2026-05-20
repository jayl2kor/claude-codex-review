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

## Install

From this directory:

```sh
bash ccr.sh
```

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
ccr-status
```

For Codex, open `/hooks` once and trust the CCR hooks if Codex asks for review.

## Daily Use

Work normally in either Claude or Codex.

When the working agent changes files and finishes a turn, CCR creates a review round under:

```text
<project>/.cmux/ccr/sessions/<session-id>/rounds/<round>/
```

Important files:

- `request.md`: instructions for the reviewer
- `diff.patch`: diff being reviewed
- `review.md`: reviewer response
- `decision.json`: parsed review decision

The reviewer must start with exactly one of:

```text
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES
```

If the reviewer asks for changes, the original worker receives the review file path and can apply the fixes. CCR will run another review round on the next changed diff.

## Commands

```sh
ccr-status
```

Shows whether CCR is enabled, registered Claude/Codex surfaces, current state, review count, and active request.

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

Deletes and recreates the local `.cmux/ccr` state for the current repo.

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

- `--reviewer claude|codex`: explicitly choose the reviewer. Defaults to the opposite registered surface.
- `--file <path>`: add a file to the review scope. Repeatable.
- `--dir <path>`: add a directory to the review scope. Repeatable.
- `--question <text>`: add a concrete review question. Repeatable.
- `--note <text>`: add extra context for the reviewer. Repeatable.
- `--use-diff`: include current git diff as supporting context.

## Configuration

Environment variables:

- `CCR_MAX_ROUNDS`: maximum automatic review rounds. Default: `3`.
- `CCR_ROOT`: override the state root. Default: `<cwd>/.cmux/ccr`.
- `CCR_MAX_UNTRACKED_BYTES`: max untracked text file size included in review diffs. Default: `200000`.

Example:

```sh
CCR_MAX_ROUNDS=5 ccr-enable
```

## Safety Rules

CCR intentionally uses files for payloads and sends only file paths through cmux.

The diff collector excludes common sensitive or noisy paths, including:

- `.cmux/ccr/`
- `.git/`
- `.env*`
- private key/certificate suffixes
- `node_modules/`
- common build output directories

Reviewer-only mode blocks supported mutating tools while an agent is acting as reviewer. This reduces same-worktree conflicts.

## Troubleshooting

If `ccr-status` shows missing surfaces, rerun the setup command in each surface:

```sh
cmux-setup-claude
cmux-setup-codex
```

If no review starts, check:

```sh
ccr-status
```

Common causes:

- CCR is disabled for the workspace.
- Claude and Codex are not in the same cmux workspace.
- The target directory is not a git repository.
- The last turn did not produce a git diff.
- Codex has not trusted the new hooks in `/hooks`.

If the loop stops with `same diff hash`, the worker did not change the diff after receiving review feedback. Make a new change or run `ccr-reset`.

If the loop stops with `max rounds`, inspect the latest `review.md` and continue manually.

## Uninstall

There is no dedicated uninstall command yet.

To disable behavior without removing files:

```sh
ccr-disable
```

To remove the installed hook entries manually, delete CCR hook groups containing `ccr-hook-claude` or `ccr-hook-codex` from:

- `~/.claude/settings.json`
- `~/.codex/hooks.json`

The generated commands live in `~/.local/bin`.
