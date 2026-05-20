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

need_cmd jq
need_cmd python3
need_cmd cmux
need_cmd claude
need_cmd codex

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

cat > "$BIN_ROOT/ccr-hook.py" <<'PY'
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

CONFIG_ROOT = Path.home() / ".config" / "claude-codex-review"
ENABLED_FILE = CONFIG_ROOT / "enabled-workspaces.txt"
MAX_ROUNDS = int(os.environ.get("CCR_MAX_ROUNDS", "3"))
MAX_UNTRACKED_BYTES = int(os.environ.get("CCR_MAX_UNTRACKED_BYTES", "200000"))

MUTATING_TOOL_NAMES = {
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
}

SENSITIVE_SUFFIXES = (
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".crt",
    ".cer",
)

SENSITIVE_BASENAMES = {
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "known_hosts",
    "authorized_keys",
}

MUTATING_BASH_PATTERNS = [
    r"(^|[;&|]\s*)rm\s+",
    r"(^|[;&|]\s*)mv\s+",
    r"(^|[;&|]\s*)cp\s+",
    r"(^|[;&|]\s*)chmod\s+",
    r"(^|[;&|]\s*)chown\s+",
    r"(^|[;&|]\s*)git\s+(add|commit|checkout|switch|reset|clean|rebase|merge|pull|push)\b",
    r"(^|[;&|]\s*)sed\s+-i\b",
    r"(^|[;&|]\s*)perl\s+-pi\b",
    r"(^|[;&|]\s*)npm\s+(install|i|update|audit\s+fix)\b",
    r"(^|[;&|]\s*)pnpm\s+(install|add|update)\b",
    r"(^|[;&|]\s*)yarn\s+(add|install|upgrade)\b",
    r"(^|[;&|]\s*)pip(?:3)?\s+install\b",
    r"(^|[;&|]\s*)cargo\s+(add|update)\b",
    r"(^|[;&|]\s*)go\s+get\b",
    r">>",
    r"(^|[^<])>[^&]",
]


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n")


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def sanitize(value: str) -> str:
    value = value.strip() or "unknown"
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value)


def workspace_id() -> str:
    return os.environ.get("CMUX_WORKSPACE_ID", "")


def surface_id() -> str:
    return os.environ.get("CMUX_SURFACE_ID", "")


def workspace_config_dir() -> Path:
    return CONFIG_ROOT / "workspaces" / workspace_id()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def role_for_current_surface() -> str:
    current = surface_id()
    if not current:
        return "unknown"
    if read_text(workspace_config_dir() / "claude-surface") == current:
        return "claude"
    if read_text(workspace_config_dir() / "codex-surface") == current:
        return "codex"
    return "unknown"


def surface_for_role(role: str) -> str:
    return read_text(workspace_config_dir() / f"{role}-surface")


def workspace_enabled() -> bool:
    wid = workspace_id()
    if not wid or not ENABLED_FILE.exists():
        return False
    return wid in ENABLED_FILE.read_text(encoding="utf-8").splitlines()


def root_for_cwd(cwd: str) -> Path:
    override = os.environ.get("CCR_ROOT", "").strip()
    if override:
        path = Path(override)
        return path if path.is_absolute() else Path(cwd) / path
    return Path(cwd) / ".cmux" / "ccr"


def session_dir(root: Path, session_id: str) -> Path:
    return root / "sessions" / sanitize(session_id)


def cmux(*args: str) -> None:
    try:
        subprocess.run(["cmux", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except FileNotFoundError:
        pass


def cmux_log(level: str, message: str) -> None:
    cmux("log", "--source", "ccr", "--level", level, "--", message)


def cmux_status(value: str, color: str = "#0A84FF") -> None:
    cmux("set-status", "ccr", value, "--icon", "git-pull-request", "--color", color, "--priority", "80")


def cmux_notify(title: str, body: str, surface: str = "") -> None:
    args = ["notify", "--title", title, "--body", body]
    if surface:
        args.extend(["--surface", surface])
    cmux(*args)


def send_to_surface(surface: str, message: str) -> bool:
    if not surface:
        return False
    try:
        subprocess.run(["cmux", "send", "--surface", surface, message], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        subprocess.run(["cmux", "send-key", "--surface", surface, "enter"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def git(cwd: str, args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", "-C", cwd, *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return proc.returncode, proc.stdout


def inside_git(cwd: str) -> bool:
    code, out = git(cwd, ["rev-parse", "--is-inside-work-tree"])
    return code == 0 and out.strip() == "true"


def safe_rel_path(rel: str) -> bool:
    rel = rel.strip()
    if not rel or rel.startswith("/") or ".." in Path(rel).parts:
        return False
    parts = Path(rel).parts
    if parts[:2] == (".cmux", "ccr"):
        return False
    if ".git" in parts or "node_modules" in parts:
        return False
    if any(part in {"dist", "build", ".next", ".venv", "DerivedData"} for part in parts):
        return False
    base = Path(rel).name
    if base in SENSITIVE_BASENAMES or base.startswith(".env"):
        return False
    return not rel.endswith(SENSITIVE_SUFFIXES)


def diff_pathspecs() -> list[str]:
    return [
        ".",
        ":(exclude).cmux/ccr/**",
        ":(exclude).git/**",
        ":(exclude).env*",
        ":(exclude)**/*.pem",
        ":(exclude)**/*.key",
        ":(exclude)**/*.p12",
        ":(exclude)**/*.pfx",
        ":(exclude)node_modules/**",
        ":(exclude)dist/**",
        ":(exclude)build/**",
        ":(exclude).next/**",
        ":(exclude).venv/**",
        ":(exclude)DerivedData/**",
    ]


def read_untracked_patch(cwd: str) -> str:
    code, out = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", "."])
    if code != 0:
        return ""
    chunks: list[str] = []
    cwd_path = Path(cwd).resolve()
    for rel in out.splitlines():
        if not safe_rel_path(rel):
            continue
        path = (cwd_path / rel).resolve()
        if not str(path).startswith(str(cwd_path) + os.sep):
            continue
        if not path.is_file():
            continue
        try:
            size = path.stat().st_size
            if size > MAX_UNTRACKED_BYTES:
                chunks.append(f"diff --git a/{rel} b/{rel}\n# Untracked file omitted: {size} bytes exceeds CCR_MAX_UNTRACKED_BYTES\n")
                continue
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\0" in raw:
            chunks.append(f"diff --git a/{rel} b/{rel}\n# Untracked binary file omitted\n")
            continue
        text = raw.decode("utf-8", errors="replace")
        chunks.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n")
        chunks.extend("+" + line for line in text.splitlines(keepends=True))
        if text and not text.endswith("\n"):
            chunks.append("\n\\ No newline at end of file\n")
    return "".join(chunks)


def collect_diff(cwd: str) -> tuple[str, str, str]:
    if not inside_git(cwd):
        return "", "", ""
    _, head = git(cwd, ["rev-parse", "--short", "HEAD"])
    pathspecs = diff_pathspecs()
    _, staged = git(cwd, ["diff", "--cached", "--", *pathspecs])
    _, unstaged = git(cwd, ["diff", "--", *pathspecs])
    untracked = read_untracked_patch(cwd)
    combined = (
        f"# Git HEAD\n{head.strip() or 'unknown'}\n\n"
        f"# Staged Diff\n{staged}\n\n"
        f"# Unstaged Diff\n{unstaged}\n\n"
        f"# Untracked Files\n{untracked}\n"
    )
    diff_hash = hashlib.sha256(combined.encode("utf-8")).hexdigest()
    return combined, diff_hash, head.strip()


def bash_looks_mutating(command: str) -> bool:
    return any(re.search(pattern, command, flags=re.IGNORECASE) for pattern in MUTATING_BASH_PATTERNS)


def tool_name(input_data: dict[str, Any]) -> str:
    return str(input_data.get("tool_name") or input_data.get("tool", {}).get("name") or "")


def tool_command(input_data: dict[str, Any]) -> str:
    tool_input = input_data.get("tool_input")
    if isinstance(tool_input, dict):
        return str(tool_input.get("command") or "")
    tool = input_data.get("tool")
    if isinstance(tool, dict):
        return str(tool.get("input", {}).get("command") or "")
    return ""


def ensure_session(root: Path, agent: str, role: str, input_data: dict[str, Any]) -> None:
    sid = str(input_data.get("session_id") or "")
    cwd = str(input_data.get("cwd") or os.getcwd())
    if not sid:
        return
    sdir = session_dir(root, sid)
    existing = load_json(sdir / "session.json", {})
    created_at = existing.get("created_at") or now()
    data = {
        **existing,
        "version": 1,
        "agent": agent,
        "role": role,
        "session_id": sid,
        "cwd": cwd,
        "workspace_id": workspace_id(),
        "surface_id": surface_id(),
        "transcript_path": input_data.get("transcript_path"),
        "model": input_data.get("model"),
        "created_at": created_at,
        "updated_at": now(),
    }
    write_json(sdir / "session.json", data)
    append_jsonl(root / "events.jsonl", {
        "at": now(),
        "type": "hook",
        "agent": agent,
        "role": role,
        "session_id": sid,
        "event": input_data.get("hook_event_name"),
    })


def default_state() -> dict[str, Any]:
    return {
        "version": 1,
        "review_count": 0,
        "last_diff_hash": "",
        "active_request": None,
        "last_completed": None,
    }


@contextlib.contextmanager
def locked_state(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "state.lock"
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state = load_json(root / "state.json", default_state())
        if not isinstance(state, dict):
            state = default_state()
        yield state
        write_json(root / "state.json", state)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def write_status(root: Path, state: dict[str, Any], status: str, reason: str = "") -> None:
    data = {
        "status": status,
        "reason": reason,
        "updated_at": now(),
        "review_count": state.get("review_count", 0),
        "active_request": state.get("active_request"),
        "last_completed": state.get("last_completed"),
    }
    write_json(root / "status.json", data)


def mark_dirty(root: Path, input_data: dict[str, Any], agent: str, role: str) -> None:
    sid = str(input_data.get("session_id") or "")
    if not sid:
        return
    dirty = {
        "at": now(),
        "agent": agent,
        "role": role,
        "event": input_data.get("hook_event_name"),
        "tool_name": tool_name(input_data),
        "turn_id": input_data.get("turn_id"),
    }
    write_json(session_dir(root, sid) / "dirty.json", dirty)
    append_jsonl(root / "events.jsonl", {"type": "dirty", **dirty})


def clear_dirty(root: Path, session_id: str) -> None:
    with contextlib.suppress(FileNotFoundError):
        (session_dir(root, session_id) / "dirty.json").unlink()


def has_dirty(root: Path, session_id: str) -> bool:
    return (session_dir(root, session_id) / "dirty.json").exists()


def request_markdown(worker: str, reviewer: str, round_no: int, diff_hash: str, head: str, diff_file: Path) -> str:
    return f"""# CCR Review Request

Worker: {worker}
Reviewer: {reviewer}
Round: {round_no}
Git HEAD: {head or "unknown"}
Diff hash: {diff_hash}
Diff file: {diff_file}

You are the reviewer in a two-agent cmux review loop.

Rules:
- Do not edit files.
- Review only the changes represented by the diff file above.
- Prioritize real bugs, regressions, requirement gaps, missing tests, and unnecessary complexity.
- Avoid minor style comments unless they hide a real maintainability issue.

Your first non-empty line must be exactly one of:
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES

Then use this Markdown structure:

# Review

## Must Fix
- ...

## Should Consider
- ...

## Looks Good
- ...

## Verdict
- ...
"""


def scope_request_markdown(scope: dict[str, Any]) -> str:
    review_type = scope.get("type") or "general_review"
    title = scope.get("title") or review_type
    files = scope.get("files") or []
    directories = scope.get("directories") or []
    questions = scope.get("questions") or []
    notes = scope.get("notes") or []
    scope_file = scope.get("scope_file")
    diff_file = scope.get("diff_file")
    focus = {
        "code_review": [
            "actual bugs and regressions",
            "requirements gaps",
            "missing or weak tests",
            "unnecessary complexity",
        ],
        "architecture_review": [
            "boundaries and responsibilities",
            "state flow and failure modes",
            "concurrency and recovery risks",
            "observability and extensibility",
        ],
        "design_review": [
            "fit with the current codebase",
            "API and data-flow clarity",
            "edge cases and constraints",
            "implementation risks",
        ],
        "test_plan_review": [
            "coverage gaps",
            "high-risk scenarios",
            "testability and maintainability",
            "acceptance criteria",
        ],
        "security_review": [
            "secrets and sensitive data exposure",
            "input validation and injection risks",
            "permission boundaries",
            "unsafe defaults",
        ],
        "general_review": [
            "correctness",
            "maintainability",
            "risks and missing context",
            "next practical improvements",
        ],
    }.get(str(review_type), ["correctness", "risks", "missing context", "practical improvements"])
    def bullets(items: list[Any]) -> str:
        return "\n".join(f"- {item}" for item in items) if items else "- None"

    return f"""# CCR Manual Review Request

Title: {title}
Review type: {review_type}
Worker: {scope.get("worker")}
Reviewer: {scope.get("reviewer")}
Scope file: {scope_file}
Diff file: {diff_file or "not included"}

## Scope Files
{bullets(files)}

## Scope Directories
{bullets(directories)}

## Questions
{bullets(questions)}

## Notes
{bullets(notes)}

## Review Focus
{bullets(focus)}

Rules:
- Do not edit files.
- Review only the files, directories, and questions listed in scope.json.
- If a diff file is included, use it as supporting context, not as the only review source.
- Prefer concrete risks and actionable recommendations.

Your first non-empty line must be exactly one of:
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES

Then use this Markdown structure:

# Review

## Must Fix
- ...

## Should Consider
- ...

## Looks Good
- ...

## Verdict
- ...
"""


def opposite(role: str) -> str:
    return "codex" if role == "claude" else "claude"


def start_review(root: Path, state: dict[str, Any], input_data: dict[str, Any], role: str) -> None:
    sid = str(input_data.get("session_id") or "")
    cwd = str(input_data.get("cwd") or "")
    if not sid or not cwd or not has_dirty(root, sid):
        return
    if state.get("active_request"):
        cmux_log("progress", "review already active; worker stop ignored")
        return
    if state.get("review_count", 0) >= MAX_ROUNDS:
        clear_dirty(root, sid)
        write_status(root, state, "stopped", f"max rounds reached ({MAX_ROUNDS})")
        cmux_status("CCR max rounds", "#FF9500")
        cmux_notify("CCR stopped", f"Maximum review rounds reached: {MAX_ROUNDS}")
        return
    diff_text, diff_hash, head = collect_diff(cwd)
    if not diff_text.strip() or diff_text.strip() == f"# Git HEAD\n{head or 'unknown'}\n\n# Staged Diff\n\n\n# Unstaged Diff\n\n\n# Untracked Files":
        clear_dirty(root, sid)
        write_status(root, state, "idle", "no diff")
        cmux_status("CCR idle", "#34C759")
        return
    if diff_hash == state.get("last_diff_hash"):
        clear_dirty(root, sid)
        write_status(root, state, "stopped", "same diff hash")
        cmux_status("CCR same diff", "#FF9500")
        cmux_notify("CCR stopped", "Same diff hash detected; automatic loop stopped.")
        return

    round_no = int(state.get("review_count", 0)) + 1
    reviewer = opposite(role)
    reviewer_surface = surface_for_role(reviewer)
    worker_surface = surface_for_role(role)
    round_dir = session_dir(root, sid) / "rounds" / f"{round_no:04d}"
    round_dir.mkdir(parents=True, exist_ok=True)
    diff_file = round_dir / "diff.patch"
    request_file = round_dir / "request.md"
    diff_file.write_text(diff_text, encoding="utf-8")
    request_file.write_text(request_markdown(role, reviewer, round_no, diff_hash, head, diff_file), encoding="utf-8")

    message = (
        "자동 리뷰 요청입니다. 아래 파일을 읽고 지시대로 리뷰만 수행해줘. "
        "파일을 수정하지 마세요.\n\n"
        f"{request_file}"
    )
    if not send_to_surface(reviewer_surface, message):
        clear_dirty(root, sid)
        write_status(root, state, "error", f"failed to send to {reviewer}")
        cmux_status("CCR send failed", "#FF3B30")
        cmux_notify("CCR send failed", f"Could not send review request to {reviewer}.")
        return

    state["review_count"] = round_no
    state["last_diff_hash"] = diff_hash
    state["active_request"] = {
        "round": round_no,
        "worker": role,
        "reviewer": reviewer,
        "worker_session_id": sid,
        "worker_surface": worker_surface,
        "reviewer_surface": reviewer_surface,
        "request_file": str(request_file),
        "diff_file": str(diff_file),
        "diff_hash": diff_hash,
        "created_at": now(),
    }
    clear_dirty(root, sid)
    write_status(root, state, "waiting_for_review", f"round {round_no} sent to {reviewer}")
    cmux_status(f"CCR r{round_no} review", "#0A84FF")
    cmux_log("progress", f"round {round_no} sent from {role} to {reviewer}")


def parse_decision(message: str) -> str:
    for line in message.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == "REVIEW_DECISION: PASS":
            return "PASS"
        if stripped == "REVIEW_DECISION: NEEDS_CHANGES":
            return "NEEDS_CHANGES"
        return "INVALID"
    return "INVALID"


def finish_review(root: Path, state: dict[str, Any], input_data: dict[str, Any], role: str) -> None:
    active = state.get("active_request")
    if not isinstance(active, dict) or active.get("reviewer") != role:
        return
    last_message = str(input_data.get("last_assistant_message") or "")
    if not last_message.strip():
        return
    worker_session_id = str(active.get("worker_session_id") or "")
    round_no = int(active.get("round") or 0)
    round_dir = session_dir(root, worker_session_id) / "rounds" / f"{round_no:04d}"
    review_file = round_dir / "review.md"
    decision_file = round_dir / "decision.json"
    review_file.write_text(last_message + "\n", encoding="utf-8")
    decision = parse_decision(last_message)
    write_json(decision_file, {
        "decision": decision,
        "reviewer": role,
        "worker": active.get("worker"),
        "round": round_no,
        "review_file": str(review_file),
        "updated_at": now(),
    })

    worker_surface = str(active.get("worker_surface") or "")
    if decision == "PASS":
        message = f"상대 agent 리뷰 결과 PASS입니다. 아래 리뷰 파일을 참고해 마무리해 주세요.\n\n{review_file}"
        send_to_surface(worker_surface, message)
        state["last_completed"] = {"round": round_no, "decision": decision, "at": now()}
        state["active_request"] = None
        write_status(root, state, "passed", f"round {round_no}")
        cmux_status("CCR pass", "#34C759")
        cmux_log("success", f"round {round_no} review passed")
        return

    if decision == "NEEDS_CHANGES":
        message = (
            "상대 agent 리뷰가 도착했습니다. 아래 파일을 읽고 타당한 지적만 반영해 주세요. "
            "반영하지 않는 지적은 짧게 이유를 설명하세요.\n\n"
            f"{review_file}"
        )
        send_to_surface(worker_surface, message)
        state["active_request"] = None
        write_status(root, state, "changes_requested", f"round {round_no}")
        cmux_status(f"CCR r{round_no} changes", "#FF9500")
        cmux_log("warning", f"round {round_no} changes requested")
        return

    state["active_request"] = None
    write_status(root, state, "manual_intervention", f"invalid decision in round {round_no}")
    cmux_status("CCR manual", "#FF3B30")
    cmux_notify("CCR needs manual review", f"Invalid review decision in {review_file}")


def reviewer_block_response(agent: str, reason: str) -> dict[str, Any]:
    if agent == "codex":
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
    return {"decision": "block", "reason": reason}


def handle_pre_tool(root: Path, state: dict[str, Any], input_data: dict[str, Any], agent: str, role: str) -> dict[str, Any] | None:
    active = state.get("active_request")
    if not isinstance(active, dict) or active.get("reviewer") != role:
        return None
    name = tool_name(input_data)
    command = tool_command(input_data)
    should_block = name in MUTATING_TOOL_NAMES or (name == "Bash" and bash_looks_mutating(command))
    if not should_block:
        return None
    cmux_log("warning", f"blocked mutating reviewer tool: {role}/{name}")
    return reviewer_block_response(agent, "CCR reviewer-only mode is active. Review the request file without modifying files.")


def handle_hook(agent: str, event: str, input_data: dict[str, Any]) -> dict[str, Any] | None:
    cwd = str(input_data.get("cwd") or os.getcwd())
    role = role_for_current_surface()
    if not workspace_enabled() or role == "unknown":
        return {} if agent == "codex" and event == "Stop" else None

    root = root_for_cwd(cwd)
    with locked_state(root) as state:
        ensure_session(root, agent, role, input_data)
        if event == "SessionStart":
            write_status(root, state, "idle", "session started")
            cmux_status("CCR idle", "#34C759")
            return None
        if event == "PreToolUse":
            return handle_pre_tool(root, state, input_data, agent, role)
        if event == "PostToolUse":
            active = state.get("active_request")
            if isinstance(active, dict) and active.get("reviewer") == role:
                return None
            mark_dirty(root, input_data, agent, role)
            write_status(root, state, "dirty", f"{role} changed files")
            cmux_status("CCR dirty", "#FF9500")
            return None
        if event == "Stop":
            if str(input_data.get("stop_hook_active", "false")).lower() == "true":
                return {} if agent == "codex" else None
            finish_review(root, state, input_data, role)
            start_review(root, state, input_data, role)
            return {} if agent == "codex" else None
    return {} if agent == "codex" and event == "Stop" else None


def ensure_info_exclude(cwd: str) -> None:
    if not inside_git(cwd):
        return
    code, git_dir = git(cwd, ["rev-parse", "--git-dir"])
    if code != 0:
        return
    path = Path(git_dir.strip())
    if not path.is_absolute():
        path = Path(cwd) / path
    exclude = path / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if ".cmux/ccr/" not in existing:
        with exclude.open("a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n# Added by claude-codex-review\n.cmux/ccr/\n")


def command_enable() -> int:
    wid = workspace_id()
    if not wid:
        print("cmux workspace 안에서 실행해야 합니다.")
        return 1
    CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    ENABLED_FILE.touch()
    lines = ENABLED_FILE.read_text(encoding="utf-8").splitlines()
    if wid not in lines:
        with ENABLED_FILE.open("a", encoding="utf-8") as f:
            f.write(wid + "\n")
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    root.mkdir(parents=True, exist_ok=True)
    ensure_info_exclude(cwd)
    with locked_state(root) as state:
        state.setdefault("version", 1)
        state.setdefault("review_count", 0)
        state["active_request"] = None
        write_status(root, state, "idle", "enabled")
    cmux_status("CCR enabled", "#34C759")
    print(f"자동 리뷰를 활성화했습니다: {wid}")
    print(f"CCR root: {root}")
    return 0


def command_disable() -> int:
    wid = workspace_id()
    if not wid:
        print("cmux workspace 안에서 실행해야 합니다.")
        return 1
    if ENABLED_FILE.exists():
        lines = [line for line in ENABLED_FILE.read_text(encoding="utf-8").splitlines() if line != wid]
        ENABLED_FILE.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    root = root_for_cwd(os.getcwd())
    if root.exists():
        with locked_state(root) as state:
            state["active_request"] = None
            write_status(root, state, "disabled", "workspace disabled")
    cmux_status("CCR disabled", "#8E8E93")
    print(f"자동 리뷰를 비활성화했습니다: {wid}")
    return 0


def command_reset() -> int:
    root = root_for_cwd(os.getcwd())
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    with locked_state(root) as state:
        state.clear()
        state.update(default_state())
        write_status(root, state, "idle", "reset")
    cmux_status("CCR reset", "#8E8E93")
    print(f"CCR state reset: {root}")
    return 0


def command_status() -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    state = load_json(root / "state.json", default_state())
    status = load_json(root / "status.json", {})
    print(f"Workspace: {workspace_id() or '-'}")
    print(f"Enabled: {'yes' if workspace_enabled() else 'no'}")
    print(f"Claude surface: {surface_for_role('claude') or '-'}")
    print(f"Codex surface: {surface_for_role('codex') or '-'}")
    print(f"CCR root: {root}")
    print(f"Status: {status.get('status', '-')}")
    print(f"Reason: {status.get('reason', '-')}")
    print(f"Review count: {state.get('review_count', 0)}")
    active = state.get("active_request")
    print(f"Active request: {json.dumps(active, ensure_ascii=False) if active else '-'}")
    return 0


def command_request(args: argparse.Namespace) -> int:
    wid = workspace_id()
    if not wid:
        print("cmux workspace 안에서 실행해야 합니다.", file=sys.stderr)
        return 1
    if not workspace_enabled():
        print("CCR is not enabled for this cmux workspace. Run ccr-enable first.", file=sys.stderr)
        return 1
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    role = role_for_current_surface()
    reviewer = args.reviewer
    if reviewer == "auto":
        if role in {"claude", "codex"}:
            reviewer = opposite(role)
        else:
            print("--reviewer is required when the current surface is not registered as Claude or Codex.", file=sys.stderr)
            return 1
    worker = role if role in {"claude", "codex"} else "manual"
    worker_surface = surface_for_role(worker) if worker in {"claude", "codex"} else surface_id()
    reviewer_surface = surface_for_role(reviewer)
    if not reviewer_surface:
        print(f"No registered {reviewer} surface. Run cmux-setup-{reviewer} in that terminal.", file=sys.stderr)
        return 1

    root.mkdir(parents=True, exist_ok=True)
    with locked_state(root) as state:
        if state.get("active_request"):
            print("A CCR request is already active. Wait for it to finish or run ccr-reset.", file=sys.stderr)
            return 1
        round_no = int(state.get("review_count", 0)) + 1
        session_id = f"manual-{int(time.time())}-{sanitize(worker)}"
        round_dir = session_dir(root, session_id) / "rounds" / f"{round_no:04d}"
        round_dir.mkdir(parents=True, exist_ok=True)
        scope_file = round_dir / "scope.json"
        request_file = round_dir / "request.md"
        diff_file = round_dir / "diff.patch"

        diff_hash = ""
        head = ""
        diff_path: str | None = None
        if args.use_diff:
            diff_text, diff_hash, head = collect_diff(cwd)
            if diff_text.strip():
                diff_file.write_text(diff_text, encoding="utf-8")
                diff_path = str(diff_file)

        scope = {
            "version": 1,
            "type": args.type,
            "title": args.title or args.type,
            "worker": worker,
            "reviewer": reviewer,
            "cwd": cwd,
            "workspace_id": wid,
            "worker_surface": worker_surface,
            "reviewer_surface": reviewer_surface,
            "files": args.file or [],
            "directories": args.dir or [],
            "questions": args.question or [],
            "notes": args.note or [],
            "use_diff": bool(args.use_diff),
            "diff_hash": diff_hash,
            "git_head": head,
            "scope_file": str(scope_file),
            "diff_file": diff_path,
            "created_at": now(),
        }
        write_json(scope_file, scope)
        request_file.write_text(scope_request_markdown(scope), encoding="utf-8")

        message = (
            "CCR 수동 리뷰 요청입니다. 아래 request.md와 scope.json을 읽고 리뷰만 수행해줘. "
            "파일은 수정하지 마세요.\n\n"
            f"{request_file}"
        )
        if not send_to_surface(reviewer_surface, message):
            print(f"Failed to send request to {reviewer}.", file=sys.stderr)
            write_status(root, state, "error", f"failed to send manual request to {reviewer}")
            return 1

        state["review_count"] = round_no
        if diff_hash:
            state["last_diff_hash"] = diff_hash
        state["active_request"] = {
            "round": round_no,
            "worker": worker,
            "reviewer": reviewer,
            "worker_session_id": session_id,
            "worker_surface": worker_surface,
            "reviewer_surface": reviewer_surface,
            "request_file": str(request_file),
            "scope_file": str(scope_file),
            "diff_file": diff_path,
            "diff_hash": diff_hash,
            "manual": True,
            "created_at": now(),
        }
        write_status(root, state, "waiting_for_review", f"manual {args.type} sent to {reviewer}")
        cmux_status(f"CCR manual r{round_no}", "#0A84FF")
        cmux_log("progress", f"manual {args.type} request round {round_no} sent to {reviewer}")
        print(f"Sent CCR {args.type} request to {reviewer}: {request_file}")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", choices=["claude", "codex"])
    parser.add_argument("--event")
    parser.add_argument("--command", choices=["enable", "disable", "reset", "status", "request"])
    parser.add_argument("--reviewer", choices=["auto", "claude", "codex"], default="auto")
    parser.add_argument("--type", default="general_review", choices=[
        "code_review",
        "architecture_review",
        "design_review",
        "test_plan_review",
        "security_review",
        "general_review",
    ])
    parser.add_argument("--title")
    parser.add_argument("--file", action="append")
    parser.add_argument("--dir", action="append")
    parser.add_argument("--question", action="append")
    parser.add_argument("--note", action="append")
    parser.add_argument("--use-diff", action="store_true")
    parser.add_argument("--no-diff", action="store_false", dest="use_diff")
    parser.set_defaults(use_diff=False)
    args = parser.parse_args()

    if args.command == "enable":
        return command_enable()
    if args.command == "disable":
        return command_disable()
    if args.command == "reset":
        return command_reset()
    if args.command == "status":
        return command_status()
    if args.command == "request":
        return command_request(args)

    input_data = read_stdin_json()
    event = args.event or str(input_data.get("hook_event_name") or "")
    if not args.agent or not event:
        return 0
    result = handle_hook(args.agent, event, input_data)
    if result is not None:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
chmod +x "$BIN_ROOT/ccr-hook.py"

cat > "$BIN_ROOT/ccr-hook-claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --agent claude --event "${1:-}"
EOF
chmod +x "$BIN_ROOT/ccr-hook-claude"

cat > "$BIN_ROOT/ccr-hook-codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --agent codex --event "${1:-}"
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
echo "Claude Code를 bypass permissions 모드로 실행합니다."
exec claude --dangerously-skip-permissions "$@"
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
echo "Codex를 workspace-write 자동 승인 모드로 실행합니다."
exec codex --ask-for-approval never --sandbox workspace-write "$@"
EOF
chmod +x "$BIN_ROOT/cmux-setup-codex"

cat > "$BIN_ROOT/ccr-enable" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --command enable
EOF
chmod +x "$BIN_ROOT/ccr-enable"

cat > "$BIN_ROOT/ccr-disable" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --command disable
EOF
chmod +x "$BIN_ROOT/ccr-disable"

cat > "$BIN_ROOT/ccr-status" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --command status
EOF
chmod +x "$BIN_ROOT/ccr-status"

cat > "$BIN_ROOT/ccr-request" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --command request "$@"
EOF
chmod +x "$BIN_ROOT/ccr-request"

cat > "$BIN_ROOT/ccr-reset" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 "$HOME/.local/bin/ccr-hook.py" --command reset
EOF
chmod +x "$BIN_ROOT/ccr-reset"

python3 <<'PY'
import json
import shutil
from pathlib import Path

home = Path.home()
claude_settings = home / ".claude" / "settings.json"
codex_hooks = home / ".codex" / "hooks.json"

claude_backup = claude_settings.with_name("settings.json.ccr-backup")
codex_backup = codex_hooks.with_name("hooks.json.ccr-backup")

bin_root = home / ".local" / "bin"
claude_hook = str(bin_root / "ccr-hook-claude")
codex_hook = str(bin_root / "ccr-hook-codex")


def load_json(path: Path):
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def backup(path: Path, backup_path: Path):
    if path.exists():
        shutil.copy2(path, backup_path)


def restore(path: Path, backup_path: Path):
    if backup_path.exists():
        shutil.copy2(backup_path, path)


def remove_backup(backup_path: Path):
    if backup_path.exists():
        backup_path.unlink()


def contains_ccr_hook(obj) -> bool:
    text = json.dumps(obj, ensure_ascii=False)
    return "ccr-hook-" in text or "claude-codex-review-" in text


def command(path: str, event: str) -> str:
    return f'{path} {event}'


def hook_group(event: str, path: str, matcher: str | None = None, timeout: int = 30, status: str | None = None):
    group = {"hooks": [{"type": "command", "command": command(path, event), "timeout": timeout}]}
    if matcher is not None:
        group["matcher"] = matcher
    if status:
        group["hooks"][0]["statusMessage"] = status
    return group


try:
    backup(claude_settings, claude_backup)
    backup(codex_hooks, codex_backup)

    claude = load_json(claude_settings)
    claude.setdefault("hooks", {})
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]:
        claude["hooks"].setdefault(event, [])
        claude["hooks"][event] = [item for item in claude["hooks"][event] if not contains_ccr_hook(item)]

    claude["hooks"]["SessionStart"].append(
        hook_group("SessionStart", claude_hook, matcher="startup|resume|clear", timeout=30)
    )
    claude["hooks"]["PreToolUse"].append(
        hook_group("PreToolUse", claude_hook, matcher="Bash|Edit|Write|MultiEdit|NotebookEdit", timeout=30)
    )
    claude["hooks"]["PostToolUse"].append(
        hook_group("PostToolUse", claude_hook, matcher="Bash|Edit|Write|MultiEdit|NotebookEdit", timeout=30)
    )
    claude["hooks"]["Stop"].append(hook_group("Stop", claude_hook, timeout=30))

    claude_settings.parent.mkdir(parents=True, exist_ok=True)
    claude_settings.write_text(json.dumps(claude, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    codex = load_json(codex_hooks)
    codex.setdefault("hooks", {})
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]:
        codex["hooks"].setdefault(event, [])
        codex["hooks"][event] = [item for item in codex["hooks"][event] if not contains_ccr_hook(item)]

    codex["hooks"]["SessionStart"].append(
        hook_group("SessionStart", codex_hook, matcher="startup|resume|clear", timeout=30, status="Starting CCR session")
    )
    codex["hooks"]["PreToolUse"].append(
        hook_group("PreToolUse", codex_hook, matcher="Bash|apply_patch|Edit|Write", timeout=30, status="Checking CCR reviewer mode")
    )
    codex["hooks"]["PostToolUse"].append(
        hook_group("PostToolUse", codex_hook, matcher="Bash|apply_patch|Edit|Write", timeout=30, status="Recording CCR activity")
    )
    codex["hooks"]["Stop"].append(
        hook_group("Stop", codex_hook, timeout=30, status="Running CCR handoff")
    )

    codex_hooks.parent.mkdir(parents=True, exist_ok=True)
    codex_hooks.write_text(json.dumps(codex, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    json.load(open(claude_settings, encoding="utf-8"))
    json.load(open(codex_hooks, encoding="utf-8"))

    remove_backup(claude_backup)
    remove_backup(codex_backup)

except Exception as e:
    restore(claude_settings, claude_backup)
    restore(codex_hooks, codex_backup)
    print(f"설정 병합 중 오류가 발생해 원본을 복구했습니다: {e}")
    raise
PY

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

jq empty "$CLAUDE_SETTINGS"
jq empty "$CODEX_HOOKS"

echo
echo "설치가 완료되었습니다."
echo
echo "생성된 주요 명령어:"
echo "  cmux-setup-claude"
echo "  cmux-setup-codex"
echo "  ccr-enable"
echo "  ccr-disable"
echo "  ccr-status"
echo "  ccr-request"
echo "  ccr-reset"
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
