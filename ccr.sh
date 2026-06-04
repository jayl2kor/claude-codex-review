#!/usr/bin/env bash
set -euo pipefail

CONFIG_ROOT="$HOME/.config/claude-codex-review"
STATE_ROOT="$HOME/.local/state/claude-codex-review"
BIN_ROOT="$HOME/.local/bin"

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"
CLAUDE_COMMANDS="$HOME/.claude/commands"
ZSHRC="$HOME/.zshrc"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "필수 명령어가 없습니다: $1"
    exit 1
  fi
}

need_cmd bun

mkdir -p "$CONFIG_ROOT/workspaces"
mkdir -p "$STATE_ROOT"
mkdir -p "$BIN_ROOT"
mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
mkdir -p "$(dirname "$CODEX_HOOKS")"
mkdir -p "$CLAUDE_COMMANDS"
touch "$CONFIG_ROOT/enabled-workspaces.txt"

touch "$ZSHRC"
if ! grep -Fqx "$PATH_LINE" "$ZSHRC"; then
  {
    echo
    echo '# Added by cmux Claude-Codex review installer'
    echo "$PATH_LINE"
  } >> "$ZSHRC"
  PATH_ADDED="yes"
else
  PATH_ADDED="no"
fi

cat > "$BIN_ROOT/ccr-lib.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

CONFIG_ROOT="$HOME/.config/claude-codex-review"
STATE_ROOT="$HOME/.local/state/claude-codex-review"
ENABLED_FILE="$CONFIG_ROOT/enabled-workspaces.txt"

inside_cmux() {
  [ -n "${CMUX_WORKSPACE_ID:-}" ] && [ -n "${CMUX_SURFACE_ID:-}" ]
}

workspace_enabled() {
  inside_cmux || return 1
  [ -f "$ENABLED_FILE" ] || return 1
  grep -Fxq "$CMUX_WORKSPACE_ID" "$ENABLED_FILE"
}

workspace_config_dir() {
  printf '%s/workspaces/%s\n' "$CONFIG_ROOT" "$CMUX_WORKSPACE_ID"
}

workspace_state_dir() {
  printf '%s/%s\n' "$STATE_ROOT" "$CMUX_WORKSPACE_ID"
}

claude_surface_file() {
  printf '%s/claude-surface\n' "$(workspace_config_dir)"
}

codex_surface_file() {
  printf '%s/codex-surface\n' "$(workspace_config_dir)"
}

registered_claude_surface() {
  [ -f "$(claude_surface_file)" ] && cat "$(claude_surface_file)"
}

registered_codex_surface() {
  [ -f "$(codex_surface_file)" ] && cat "$(codex_surface_file)"
}

has_registered_surfaces() {
  [ -s "$(claude_surface_file)" ] && [ -s "$(codex_surface_file)" ]
}
EOF
chmod +x "$BIN_ROOT/ccr-lib.sh"

# The runtime is the bundled Bun CLI. It ships as templates/bin/ccr-cli.js
# (a generated, dependency-inlined bundle of src/cli.ts) and is installed by
# copying it from this script's own repo checkout — it is intentionally NOT
# embedded inline here, so ccr.sh stays small and reviewable and the bundle is
# not duplicated. Integrity is guarded by bundle-sync.test.ts (bundle == fresh
# src/cli.ts build) and check:sync (the other 43 templates == ccr.sh heredocs).
CCR_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
CCR_RUNTIME_SRC="$CCR_SCRIPT_DIR/templates/bin/ccr-cli.js"
if [ ! -f "$CCR_RUNTIME_SRC" ]; then
  echo "필수 런타임 번들이 없습니다: $CCR_RUNTIME_SRC" >&2
  echo "저장소를 clone 한 뒤 저장소 루트에서 'bash ccr.sh' 를 실행하세요." >&2
  exit 1
fi
cp "$CCR_RUNTIME_SRC" "$BIN_ROOT/ccr-cli.js"
chmod +x "$BIN_ROOT/ccr-cli.js"

cat > "$BIN_ROOT/ccr-hook-claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec bun "$HOME/.local/bin/ccr-cli.js" --agent claude --event "${1:-}"
EOF
chmod +x "$BIN_ROOT/ccr-hook-claude"

cat > "$BIN_ROOT/ccr-hook-codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec bun "$HOME/.local/bin/ccr-cli.js" --agent codex --event "${1:-}"
EOF
chmod +x "$BIN_ROOT/ccr-hook-codex"

cat > "$BIN_ROOT/cmux-setup-claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.local/bin/ccr-lib.sh"

if ! inside_cmux; then
  echo "cmux surface 안에서 실행해야 합니다."
  exit 1
fi

mkdir -p "$(workspace_config_dir)"
printf '%s\n' "$CMUX_SURFACE_ID" > "$(claude_surface_file)"

echo "현재 surface를 Claude 탭으로 등록했습니다."

CCR_CONFIG_ROOT="$HOME/.config/claude-codex-review"
CCR_PROMPT_ARGS=()
if [ "${CCR_DUAL_MODE:-1}" = "0" ]; then
  echo "CCR_DUAL_MODE=0 이 설정되어 dual-mode dev/reviewer 프롬프트를 건너뜁니다."
else
  if [ -f "$CCR_CONFIG_ROOT/dev-prompt.md" ]; then
    CCR_PROMPT_ARGS+=(--append-system-prompt-file "$CCR_CONFIG_ROOT/dev-prompt.md")
    echo "CCR dual-mode 활성화 (기본): $CCR_CONFIG_ROOT/dev-prompt.md 를 시스템 프롬프트에 append 합니다."
    echo "(끄려면 CCR_DUAL_MODE=0 으로 실행하세요.)"
  else
    echo "경고: $CCR_CONFIG_ROOT/dev-prompt.md 가 없습니다. bash ccr.sh 로 재설치하세요." >&2
  fi
fi

echo "Claude Code를 bypass permissions 모드로 실행합니다."
exec claude --dangerously-skip-permissions ${CCR_PROMPT_ARGS[@]+"${CCR_PROMPT_ARGS[@]}"} "$@"
EOF
chmod +x "$BIN_ROOT/cmux-setup-claude"

cat > "$BIN_ROOT/cmux-setup-codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.local/bin/ccr-lib.sh"

if ! inside_cmux; then
  echo "cmux surface 안에서 실행해야 합니다."
  exit 1
fi

mkdir -p "$(workspace_config_dir)"
printf '%s\n' "$CMUX_SURFACE_ID" > "$(codex_surface_file)"

echo "현재 surface를 Codex 탭으로 등록했습니다."

CCR_CONFIG_ROOT="$HOME/.config/claude-codex-review"
if [ "${CCR_DUAL_MODE:-1}" = "0" ]; then
  echo "CCR_DUAL_MODE=0 이 설정되어 dual-mode dev/reviewer 프롬프트를 건너뜁니다."
else
  if [ -f "$CCR_CONFIG_ROOT/codex-home/AGENTS.md" ]; then
    export CODEX_HOME="$CCR_CONFIG_ROOT/codex-home"
    # Dual-mode launches codex from this CCR-private CODEX_HOME, so codex reads
    # hooks from "$CODEX_HOME/hooks.json" — NOT ~/.codex/hooks.json where the
    # installer wrote them. Mirror the CCR hooks here, otherwise codex's /hooks
    # is empty and the review handoff never fires.
    if [ -f "$HOME/.codex/hooks.json" ]; then
      cp "$HOME/.codex/hooks.json" "$CODEX_HOME/hooks.json"
    fi
    echo "CCR dual-mode 활성화 (기본): CODEX_HOME=$CODEX_HOME (AGENTS.md 로 시스템 프롬프트 주입)."
    echo "CCR hook을 $CODEX_HOME/hooks.json 에 동기화했습니다. 처음이면 codex에서 /hooks 로 한 번 trust 해주세요."
    echo "(끄려면 CCR_DUAL_MODE=0 으로 실행하세요. 이 경우 ~/.codex 의 기존 trust된 hook을 사용합니다.)"
  else
    echo "경고: $CCR_CONFIG_ROOT/codex-home/AGENTS.md 가 없습니다. bash ccr.sh 로 재설치하세요." >&2
  fi
fi

echo "Codex를 workspace-write 자동 승인 모드로 실행합니다."
exec codex --ask-for-approval never --sandbox workspace-write "$@"
EOF
chmod +x "$BIN_ROOT/cmux-setup-codex"

cat > "$BIN_ROOT/ccr-help" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat <<'HELP'
CCR quick help

Install:
  bash ccr.sh
  ccr-help
  ccr-selftest

Start a Claude/Codex pair:
  1. Open the target project in cmux.
  2. Run cmux-setup-claude in the Claude surface.
  3. Run cmux-setup-codex in the Codex surface.
  4. From the target git repository, run ccr-enable.
  5. Run ccr-ready.
  6. Run ccr-preview before expecting the first automatic review.

Daily commands:
  ccr-status                 Show current CCR state.
  ccr-request                Send a scoped manual review.
  ccr-history                List completed review rounds.
  ccr-events                 Show recent runtime events.
  ccr-show                   Show latest round paths or review body.
  ccr-preview                Explain whether current diff is reviewable.
  ccr-prune                  Dry-run cleanup for old CCR artifacts.
  ccr-config                 Show effective CCR settings.
  ccr-check                  Run consolidated diagnostics.
  ccr-report                 Generate or print a session report.
  ccr-ready                  Strict readiness gate for auto review.
  ccr-skip-next              Skip the next automatic review.
  ccr-cancel                 Cancel a stale active request.
  ccr-support                Create a diagnostic support bundle.
  ccr-selftest               Run installed runtime smoke tests.
  ccr-reset                  Wipe local .cmux/ccr state.
  ccr-disable                Disable CCR for this cmux workspace.
  ccr-uninstall              Remove installed CCR files and hooks.

Diagnostics:
  ccr-ready                  Strict yes/no setup gate for auto review.
  ccr-check                  Broad health summary with next actions.
  ccr-preview                Explain why the current diff will/won't review.
  ccr-doctor                 Human-readable checks and next actions.
  ccr-doctor --json          Machine-readable checks and actions.

More detail:
  README.md                  Main guide in the CCR repository.
  docs/start-here.md         Role-based docs and command routing.
  docs/quickstart.md         Short first-run path.
  docs/examples.md           Task-oriented command recipes.
  docs/adoption-checklist.md Repository-owner rollout checklist.
  docs/faq.md                Common setup and routing questions.
  docs/commands.md           Command reference by task.
  docs/troubleshooting.md    Symptom-based recovery.
  docs/validation.md         Checks before sharing or rolling out changes.
  docs/glossary.md           Runtime terms used in status and reports.
  docs/templates.md          Copy-paste rollout and support templates.
  docs/upgrade.md            Reinstall, validation, rollback, and purge guide.
HELP
EOF
chmod +x "$BIN_ROOT/ccr-help"

cat > "$BIN_ROOT/ccr-enable" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-enable        Enable CCR for the current cmux workspace and cwd."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command enable
EOF
chmod +x "$BIN_ROOT/ccr-enable"

cat > "$BIN_ROOT/ccr-disable" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-disable       Disable CCR for the current cmux workspace."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command disable
EOF
chmod +x "$BIN_ROOT/ccr-disable"

cat > "$BIN_ROOT/ccr-status" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-status        Print CCR status for the current cwd."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command status
EOF
chmod +x "$BIN_ROOT/ccr-status"

cat > "$BIN_ROOT/ccr-request" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-request [--reviewer auto|claude|codex] [--type TYPE] [--title T]
                   [--file PATH ...] [--dir PATH ...] [--question Q ...]
                   [--note N ...] [--use-diff|--no-diff]
TYPE: code_review | architecture_review | design_review | test_plan_review |
      security_review | general_review
Send a scoped review request to the opposite agent.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command request "$@"
EOF
chmod +x "$BIN_ROOT/ccr-request"

cat > "$BIN_ROOT/ccr-reset" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-reset         Wipe and recreate .cmux/ccr state for the current cwd."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command reset
EOF
chmod +x "$BIN_ROOT/ccr-reset"

cat > "$BIN_ROOT/ccr-cancel" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-cancel        Soft-cancel any active CCR review (preserves history)."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command cancel
EOF
chmod +x "$BIN_ROOT/ccr-cancel"

cat > "$BIN_ROOT/ccr-history" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-history [--limit N] [--session ID]
Show completed review rounds in latest-first order. Default limit: 20.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command history "$@"
EOF
chmod +x "$BIN_ROOT/ccr-history"

cat > "$BIN_ROOT/ccr-events" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-events [--limit N] [--json]
Show recent .cmux/ccr/events.jsonl runtime events. Default limit: 50.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command events "$@"
EOF
chmod +x "$BIN_ROOT/ccr-events"

cat > "$BIN_ROOT/ccr-show" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-show [--session ID] [--round N] [--review]
Show paths for the latest (or specified) review round. --review prints review.md body.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command show "$@"
EOF
chmod +x "$BIN_ROOT/ccr-show"

cat > "$BIN_ROOT/ccr-preview" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-preview [--json]
Preview whether the current git diff would be eligible for an automatic CCR review.
Does not mark dirty, consume skip markers, create rounds, or send handoffs.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command preview "$@"
EOF
chmod +x "$BIN_ROOT/ccr-preview"

cat > "$BIN_ROOT/ccr-prune" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-prune [--keep N] [--days N] [--apply] [--json]
Dry-run cleanup for old .cmux/ccr sessions and support bundles.
Defaults: --keep 20 --days 30. Add --apply to actually remove candidates.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command prune "$@"
EOF
chmod +x "$BIN_ROOT/ccr-prune"

cat > "$BIN_ROOT/ccr-config" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-config [--json]
Show effective CCR environment variables, paths, generated command names, and diff exclusions.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command config "$@"
EOF
chmod +x "$BIN_ROOT/ccr-config"

cat > "$BIN_ROOT/ccr-check" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-check [--json]
Run consolidated CCR diagnostics: selftest, doctor summary, readiness, preview, and config overrides.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command check "$@"
EOF
chmod +x "$BIN_ROOT/ccr-check"

cat > "$BIN_ROOT/ccr-skip-next" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help) echo "Usage: ccr-skip-next     Skip the next automatic review round (one-shot marker)."; exit 0 ;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command skip-next
EOF
chmod +x "$BIN_ROOT/ccr-skip-next"

cat > "$BIN_ROOT/ccr-report" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-report [--session ID] [--outcome OUT] [--print]
Generate (or regenerate) a Markdown report for the latest or given session.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command report "$@"
EOF
chmod +x "$BIN_ROOT/ccr-report"

cat > "$BIN_ROOT/ccr-ready" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-ready [--json]
Exit 0 only when automatic CCR review routing is ready in the current cwd.
Use this after setup or in scripts that need a strict ready/not-ready gate.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command ready "$@"
EOF
chmod +x "$BIN_ROOT/ccr-ready"

cat > "$BIN_ROOT/ccr-doctor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-doctor [--json]
Diagnose CCR installation, hooks, cmux, git, and runtime state.
--json prints machine-readable diagnostics for scripts and CI.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command doctor "$@"
EOF
chmod +x "$BIN_ROOT/ccr-doctor"

cat > "$BIN_ROOT/ccr-support" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-support [--session ID] [--include-diffs] [--print]
Create .cmux/ccr/support/ccr-support-*.zip with doctor output and session metadata.
By default, request/review/diff payloads are excluded. Use --include-diffs only when sharing code payloads is acceptable.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command support "$@"
EOF
chmod +x "$BIN_ROOT/ccr-support"

cat > "$BIN_ROOT/ccr-selftest" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-selftest [--json]
Run installed CCR runtime smoke tests without reinstalling.
Checks parser behavior, dirty filtering, prompt reset safety, diff helpers, and diagnostic JSON paths.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command selftest "$@"
EOF
chmod +x "$BIN_ROOT/ccr-selftest"

cat > "$BIN_ROOT/ccr-uninstall" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in -h|--help)
  cat <<USAGE
Usage: ccr-uninstall [--apply] [--purge]
Dry-run by default. --apply removes installed binaries, slash commands, and hook entries.
--purge also deletes ~/.config/claude-codex-review and ~/.local/state/claude-codex-review.
USAGE
  exit 0
;; esac
exec bun "$HOME/.local/bin/ccr-cli.js" --command uninstall "$@"
EOF
chmod +x "$BIN_ROOT/ccr-uninstall"

bun run - <<'JS'
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const home = homedir();
const claudeSettings = join(home, ".claude", "settings.json");
const codexHooks = join(home, ".codex", "hooks.json");
const claudeBackup = join(dirname(claudeSettings), "settings.json.ccr-backup");
const codexBackup = join(dirname(codexHooks), "hooks.json.ccr-backup");
const binRoot = join(home, ".local", "bin");
const claudeHook = join(binRoot, "ccr-hook-claude");
const codexHook = join(binRoot, "ccr-hook-codex");

function loadJson(path) {
  if (!existsSync(path)) return {};
  const v = JSON.parse(readFileSync(path, "utf-8"));
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`Expected ${path} to be a JSON object`);
  }
  return v;
}
function asPlainObject(v, label) {
  // Guard before mutating .hooks: a valid-JSON-but-wrong-shape value (e.g.
  // "hooks": []) must throw so the catch restores backups, instead of letting
  // JSON.stringify silently drop hook entries attached to a non-object/array.
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`Expected ${label} to be a JSON object`);
  }
  return v;
}
function asArray(v, label) {
  if (!Array.isArray(v)) {
    throw new Error(`Expected ${label} to be a JSON array`);
  }
  return v;
}
function backup(path, b) { if (existsSync(path)) copyFileSync(path, b); }
function restore(path, b) { if (existsSync(b)) copyFileSync(b, path); }
function removeBackup(b) { if (existsSync(b)) unlinkSync(b); }
function containsCcrHook(obj) {
  const t = JSON.stringify(obj);
  return t.includes("ccr-hook-") || t.includes("claude-codex-review-");
}
function command(path, event) { return `${path} ${event}`; }
function hookGroup(event, path, matcher = null, timeout = 30, status = null) {
  const entry = { type: "command", command: command(path, event), timeout };
  if (status) entry.statusMessage = status;
  const group = { hooks: [entry] };
  if (matcher !== null) group.matcher = matcher;
  return group;
}
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

try {
  backup(claudeSettings, claudeBackup);
  backup(codexHooks, codexBackup);

  const claude = loadJson(claudeSettings);
  if (claude.hooks === undefined) claude.hooks = {};
  claude.hooks = asPlainObject(claude.hooks, `${claudeSettings} -> .hooks`);
  for (const event of EVENTS) {
    if (claude.hooks[event] === undefined) claude.hooks[event] = [];
    claude.hooks[event] = asArray(claude.hooks[event], `${claudeSettings} -> .hooks.${event}`).filter((i) => !containsCcrHook(i));
  }
  claude.hooks.SessionStart.push(hookGroup("SessionStart", claudeHook, "startup|resume|clear", 30));
  claude.hooks.UserPromptSubmit.push(hookGroup("UserPromptSubmit", claudeHook, null, 10));
  claude.hooks.PreToolUse.push(hookGroup("PreToolUse", claudeHook, "Bash|Edit|Write|MultiEdit|NotebookEdit", 30));
  claude.hooks.PostToolUse.push(hookGroup("PostToolUse", claudeHook, "Bash|Edit|Write|MultiEdit|NotebookEdit", 30));
  claude.hooks.Stop.push(hookGroup("Stop", claudeHook, null, 30));
  mkdirSync(dirname(claudeSettings), { recursive: true });
  writeFileSync(claudeSettings, JSON.stringify(claude, null, 2) + "\n", "utf-8");

  const codex = loadJson(codexHooks);
  if (codex.hooks === undefined) codex.hooks = {};
  codex.hooks = asPlainObject(codex.hooks, `${codexHooks} -> .hooks`);
  for (const event of EVENTS) {
    if (codex.hooks[event] === undefined) codex.hooks[event] = [];
    codex.hooks[event] = asArray(codex.hooks[event], `${codexHooks} -> .hooks.${event}`).filter((i) => !containsCcrHook(i));
  }
  codex.hooks.SessionStart.push(hookGroup("SessionStart", codexHook, "startup|resume|clear", 30, "Starting CCR session"));
  codex.hooks.UserPromptSubmit.push(hookGroup("UserPromptSubmit", codexHook, null, 10, "Resetting CCR round counter"));
  codex.hooks.PreToolUse.push(hookGroup("PreToolUse", codexHook, "Bash|apply_patch|Edit|Write", 30, "Checking CCR reviewer mode"));
  codex.hooks.PostToolUse.push(hookGroup("PostToolUse", codexHook, "Bash|apply_patch|Edit|Write", 30, "Recording CCR activity"));
  codex.hooks.Stop.push(hookGroup("Stop", codexHook, null, 30, "Running CCR handoff"));
  mkdirSync(dirname(codexHooks), { recursive: true });
  writeFileSync(codexHooks, JSON.stringify(codex, null, 2) + "\n", "utf-8");

  JSON.parse(readFileSync(claudeSettings, "utf-8"));
  JSON.parse(readFileSync(codexHooks, "utf-8"));

  removeBackup(claudeBackup);
  removeBackup(codexBackup);
} catch (e) {
  restore(claudeSettings, claudeBackup);
  restore(codexHooks, codexBackup);
  console.log(`설정 병합 중 오류가 발생해 원본을 복구했습니다: ${e}`);
  throw e;
}
JS

cat > "$CLAUDE_COMMANDS/ccr-request.md" <<'EOF'
---
description: Send a scoped CCR review request to the opposite cmux agent.
allowed-tools: Bash(ccr-request:*), Bash(ccr-status:*)
---

# CCR Request

Create a scoped review request for the opposite cmux agent.

Usage examples:

```sh
ccr-request --type architecture_review --file ccr.sh --file README.md --question "Is the protocol robust?"
ccr-request --reviewer codex --type code_review --file src/app.ts --use-diff
ccr-request --reviewer claude --type design_review --dir docs --question "Does this design fit the codebase?"
```

Run this shell command with the user's arguments:

```sh
ccr-request $ARGUMENTS
```

Then summarize the request file path and current CCR status. Do not perform the requested review yourself.
EOF

cat > "$CLAUDE_COMMANDS/ccr-status.md" <<'EOF'
---
description: Print CCR status for the current cwd.
allowed-tools: Bash(ccr-status:*)
---

# CCR Status

Show whether CCR is enabled for the current cmux workspace, registered Claude/Codex surfaces, current state, review count, last round, active request elapsed time, and pending skip marker.

```sh
ccr-status
```

Summarize the output briefly. Do not run other commands.
EOF

cat > "$CLAUDE_COMMANDS/ccr-history.md" <<'EOF'
---
description: List recent CCR review rounds (latest-first).
allowed-tools: Bash(ccr-history:*)
---

# CCR History

Show completed review rounds in the current cwd. Default limit is 20.

```sh
ccr-history $ARGUMENTS
```

Summarize the table briefly. Do not run other commands.
EOF

cat > "$CLAUDE_COMMANDS/ccr-events.md" <<'EOF'
---
description: Show recent CCR runtime events.
allowed-tools: Bash(ccr-events:*), Bash(ccr-status:*)
---

# CCR Events

Show recent CCR runtime events:

```sh
ccr-events $ARGUMENTS
```

Summarize the latest event types and any warning/error-looking reasons. Use `--json` only when the user asks for machine-readable logs.
EOF

cat > "$CLAUDE_COMMANDS/ccr-skip-next.md" <<'EOF'
---
description: Skip the next automatic CCR review round (one-shot marker).
allowed-tools: Bash(ccr-skip-next:*), Bash(ccr-status:*)
---

# CCR Skip Next

Place a one-shot marker so the next Stop hook does NOT send a review request. Use for commit-only or chore turns.

```sh
ccr-skip-next
```

Confirm the marker path and run `ccr-status` to show it as `Skip-next: pending`.
EOF

cat > "$CLAUDE_COMMANDS/ccr-report.md" <<'EOF'
---
description: Generate (or regenerate) the Markdown report for the latest CCR session.
allowed-tools: Bash(ccr-report:*), Bash(ccr-status:*)
---

# CCR Report

Render a single-file Markdown summary of the latest (or specified) CCR session: outcome, round-by-round decisions, files touched, and embedded review.md bodies. Use after the loop terminates (PASS / max_rounds / same_hash / cancelled / needs_human). Terminal states also auto-generate this report, so this command is mainly for regeneration or printing.

```sh
ccr-report $ARGUMENTS
```

Print the resulting file path. With `--print`, also stream the report body to stdout. Do not run additional commands.
EOF

cat > "$CLAUDE_COMMANDS/ccr-doctor.md" <<'EOF'
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
EOF

cat > "$CLAUDE_COMMANDS/ccr-support.md" <<'EOF'
---
description: Create a CCR diagnostic support bundle zip.
allowed-tools: Bash(ccr-support:*), Bash(ccr-status:*)
---

# CCR Support

Create a portable diagnostic zip with `ccr-doctor --json`, current CCR state, event tail, and latest session metadata.

```sh
ccr-support $ARGUMENTS
```

Summarize the bundle path and whether payload files were included. Do not add `--include-diffs` unless the user explicitly agrees to include review requests, reviews, and diff contents.
EOF

cat > "$CLAUDE_COMMANDS/ccr-ready.md" <<'EOF'
---
description: Check whether automatic CCR review routing is ready now.
allowed-tools: Bash(ccr-ready:*), Bash(ccr-doctor:*)
---

# CCR Ready

Run the strict readiness gate:

```sh
ccr-ready $ARGUMENTS
```

Report `Ready: yes` or `Ready: no`. If it is not ready, summarize the numbered next actions. Use `ccr-doctor` only when the user asks for deeper diagnostics.
EOF

cat > "$CLAUDE_COMMANDS/ccr-selftest.md" <<'EOF'
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
EOF

cat > "$CLAUDE_COMMANDS/ccr-preview.md" <<'EOF'
---
description: Preview whether the current diff is eligible for automatic CCR review.
allowed-tools: Bash(ccr-preview:*), Bash(ccr-status:*)
---

# CCR Preview

Preview the current git diff and automatic review blockers:

```sh
ccr-preview $ARGUMENTS
```

Summarize whether auto-review would run, then list blockers and notes. This command must not create review rounds or consume skip markers.
EOF

cat > "$CLAUDE_COMMANDS/ccr-prune.md" <<'EOF'
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
EOF

cat > "$CLAUDE_COMMANDS/ccr-config.md" <<'EOF'
---
description: Show effective CCR configuration and path settings.
allowed-tools: Bash(ccr-config:*), Bash(ccr-status:*)
---

# CCR Config

Show effective CCR settings:

```sh
ccr-config $ARGUMENTS
```

Summarize environment values, which ones came from env overrides, and the active CCR root. Use `--json` when the user asks for machine-readable config.
EOF

cat > "$CLAUDE_COMMANDS/ccr-check.md" <<'EOF'
---
description: Run consolidated CCR diagnostics.
allowed-tools: Bash(ccr-check:*), Bash(ccr-doctor:*), Bash(ccr-ready:*)
---

# CCR Check

Run the consolidated CCR diagnostic summary:

```sh
ccr-check $ARGUMENTS
```

Summarize the overall result first, then selftest, doctor, ready, preview, env overrides, and next actions. Use `--json` only when the user asks for machine-readable output.
EOF

mkdir -p "$CONFIG_ROOT"
mkdir -p "$CONFIG_ROOT/codex-home"

# Dual-mode system prompts — opt-in via CCR_DUAL_MODE=1 in the surface env.
# Always overwritten on reinstall so prompt fixes propagate.
cat > "$CONFIG_ROOT/dev-prompt.md" <<'CCR_DEV_PROMPT_EOF'
You are running inside cmux with the Claude-Codex Review (CCR) loop active.
By default you are the **main developer** in this surface. Stay in dev mode
until you receive an explicit handoff message.

CCR handoff messages start with one of these prefixes and tell you a review
file path:
  - `CCR review result: PASS …`
  - `CCR review: NEEDS_CHANGES …`
  - `CCR review: NEEDS_HUMAN …`
  - `CCR automatic review request. …`

When a handoff arrives, follow the instructions in that message exactly. Do
not pre-empt them with your own workflow.

Before each round, write a short Purpose / Non-goal / Invariant (PNI) block
into `.cmux/ccr/sessions/<session-id>/intent.md` so the reviewer can judge
whether the diff actually serves the user's intent. Keep it to 1–3 lines per
field. Skip a field only when there is genuinely nothing to say — never
fabricate filler.

Example `intent.md`:

    PURPOSE: <one-line goal of this change>
    NON_GOAL: <what is deliberately out of scope, if any>
    INVARIANT: <a single must-not-break property, if any>

If you cannot or will not write `intent.md`, instead end your final assistant
turn with a labelled block so CCR can auto-extract it:

    PURPOSE: …
    NON_GOAL: …
    INVARIANT: …

When the same handoff message also includes a `Ledger:` line, read that ledger
once to see whether Must-fix counts are decreasing across rounds. If they are
flat or rising, course-correct your approach instead of just patching symptoms.

At the end of each turn you may tell CCR whether this turn's work warrants an
automatic review. Emit one line, on its own line and NOT inside a code fence:

    CCR_REVIEW: request   — a substantive code change that should be reviewed
    CCR_REVIEW: skip      — a question/answer, exploration, a trivial or no-op
                            change, or the user explicitly said not to review

A short parenthesized reason is fine, e.g. `CCR_REVIEW: skip (answered a
question, no code changed)`. Omitting the line lets CCR fall back to its own
file-change heuristic. This line only gates the AUTOMATIC review and is separate
from the reviewer's `REVIEW_DECISION:` line; emitting it is NOT invoking a
review, so it does not violate the rule below.

Never invoke another CCR review yourself (no `ccr-request`, no
`[ccr-handoff]` sentinels). CCR drives review timing — you only respond.
CCR_DEV_PROMPT_EOF

cat > "$CONFIG_ROOT/reviewer-prompt.md" <<'CCR_REVIEWER_PROMPT_EOF'
You are running inside cmux with the Claude-Codex Review (CCR) loop active.
Most of the time you are the main developer in your own surface. But when the
human or CCR hands you a path to a CCR `request.md` file, switch immediately
to **reviewer mode** with these constraints:

Reviewer constraints (strict):
- Do not edit, create, or delete files.
- Do not run any git mutation: `git add` / `commit` / `checkout` / `restore` /
  `stash` / `reset` / `push`. Read-only git commands (`git diff`, `git log`,
  `git show`) are fine.
- Do not request another CCR review (no recursive `ccr-request`, no
  `[ccr-handoff]` sentinels). This avoids review loops.
- Read the `request.md` you were handed. Follow its sections in order:
  Task Context → Purpose/Non-goal/Invariant → Iteration So Far →
  Project Instructions → Previous Review → Worker Follow-up → diff.

Output exactly one decision line near the top of your reply:
  REVIEW_DECISION: PASS
  REVIEW_DECISION: NEEDS_CHANGES
  REVIEW_DECISION: NEEDS_HUMAN

Use NEEDS_HUMAN only for policy / security / business calls outside an agent's
safe scope. Use NEEDS_CHANGES for routine defects — including a missing or
inconsistent `intent.md` (raise that as the first Must Fix item).

Stop the reply after the Verdict line. Do not start any new dev work in the
same turn.
CCR_REVIEWER_PROMPT_EOF

# Codex equivalent of an appendable system prompt: a CCR-private CODEX_HOME
# with its own AGENTS.md. The CODEX_HOME is only used when the cmux-setup-codex
# wrapper sees CCR_DUAL_MODE=1; otherwise codex starts with the user's normal
# home and config.
cat > "$CONFIG_ROOT/codex-home/AGENTS.md" <<'CCR_CODEX_AGENTS_EOF'
You are running inside cmux with the Claude-Codex Review (CCR) loop active.
This AGENTS.md is the CCR-managed system prompt for codex when the
cmux-setup-codex wrapper is invoked with CCR_DUAL_MODE=1.

You play two roles depending on context.

1. Main developer (default in this surface).
   Follow the dev-prompt rules: write a Purpose / Non-goal / Invariant block
   into `.cmux/ccr/sessions/<session-id>/intent.md` before each review round,
   or include a labelled `PURPOSE: / NON_GOAL: / INVARIANT:` block in your
   final assistant turn so CCR can auto-extract it. Never invoke another CCR
   review yourself.
   At the end of a dev turn you may also emit one plain-text line
   `CCR_REVIEW: request` or `CCR_REVIEW: skip` (never inside a code fence) to
   tell CCR whether this turn warrants an automatic review; omitting it falls
   back to CCR's file-change heuristic. This is separate from the reviewer's
   `REVIEW_DECISION:` line and is not itself a review invocation.

2. Reviewer (when CCR hands you a request.md path).
   Strict constraints:
   - Do not edit, create, or delete files.
   - Do not run any git mutation (`git add` / `commit` / `checkout` /
     `restore` / `stash` / `reset` / `push`). Read-only git commands are fine.
   - Do not start another CCR review.
   - Read the request.md sections in order, then output exactly one
     `REVIEW_DECISION: PASS|NEEDS_CHANGES|NEEDS_HUMAN` line near the top of
     your reply, followed by the Must Fix / Should Consider / Verdict sections.
   - Stop after the Verdict. Do not pivot back to dev work in the same turn.

A missing or inconsistent `intent.md` is a NEEDS_CHANGES finding (first Must
Fix item), not NEEDS_HUMAN.
CCR_CODEX_AGENTS_EOF

{
  if command -v git >/dev/null 2>&1 && SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)" && [ -d "$SCRIPT_DIR/.git" ]; then
    git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || true
  else
    echo "unknown-sha"
  fi
  date -u "+installed=%Y-%m-%dT%H:%M:%SZ"
} | tr '\n' ' ' > "$CONFIG_ROOT/VERSION"
echo >> "$CONFIG_ROOT/VERSION"

bun "$BIN_ROOT/ccr-cli.js" --command selftest

bun run - "$CLAUDE_SETTINGS" "$CODEX_HOOKS" <<'JS'
import { readFileSync } from "node:fs";
for (const raw of process.argv.slice(2)) {
  try {
    JSON.parse(readFileSync(raw, "utf-8"));
  } catch (exc) {
    console.error(`Invalid JSON in ${raw}: ${exc}`);
    process.exit(1);
  }
}
JS

echo
echo "설치가 완료되었습니다."
echo
echo "생성된 주요 명령어:"
echo "  cmux-setup-claude"
echo "  cmux-setup-codex"
echo "  ccr-help"
echo "  ccr-enable"
echo "  ccr-disable"
echo "  ccr-status"
echo "  ccr-request"
echo "  ccr-reset"
echo "  ccr-cancel"
echo "  ccr-history"
echo "  ccr-events"
echo "  ccr-show"
echo "  ccr-preview"
echo "  ccr-prune"
echo "  ccr-config"
echo "  ccr-check"
echo "  ccr-skip-next"
echo "  ccr-report"
echo "  ccr-ready"
echo "  ccr-doctor"
echo "  ccr-support"
echo "  ccr-selftest"
echo "  ccr-uninstall"
echo

if [ "$PATH_ADDED" = "yes" ]; then
  echo "~/.local/bin PATH 설정을 ~/.zshrc에 추가했습니다."
  echo "이미 열려 있던 일반 쉘에서는 아래 중 하나를 해주세요."
  echo "  1) source ~/.zshrc"
  echo "  2) 탭을 닫고 새로 열기"
else
  echo "~/.local/bin PATH 설정은 이미 ~/.zshrc에 있습니다."
fi

echo
echo "사용 순서:"
echo "  1) Claude surface에서 cmux-setup-claude"
echo "  2) Codex surface에서 cmux-setup-codex"
echo "  3) 작업 repo cwd에서 ccr-enable"
echo "  4) Codex에서 /hooks 를 열어 CCR hook을 trust"
echo
echo "동작:"
echo "  - 세션 데이터는 현재 cwd의 .cmux/ccr/sessions/<session-id>/ 아래에 저장됩니다."
echo "  - 최대 자동 리뷰 라운드는 CCR_MAX_ROUNDS 환경 변수로 조정할 수 있으며 기본값은 3입니다."
