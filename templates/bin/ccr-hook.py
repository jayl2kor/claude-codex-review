#!/usr/bin/env python3
from __future__ import annotations

import argparse
import calendar
import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

CONFIG_ROOT = Path.home() / ".config" / "claude-codex-review"
ENABLED_FILE = CONFIG_ROOT / "enabled-workspaces.txt"
MAX_ROUNDS = int(os.environ.get("CCR_MAX_ROUNDS", "3"))
MAX_UNTRACKED_BYTES = int(os.environ.get("CCR_MAX_UNTRACKED_BYTES", "200000"))
MAX_DIFF_BYTES = int(os.environ.get("CCR_MAX_DIFF_BYTES", "300000"))
MIN_DIFF_LINES = int(os.environ.get("CCR_MIN_DIFF_LINES", "0"))
STALE_ACTIVE_SECONDS = int(os.environ.get("CCR_STALE_ACTIVE_SECONDS", "1800"))

CCR_DEFAULTS = {
    "CCR_MAX_ROUNDS": "3",
    "CCR_MAX_UNTRACKED_BYTES": "200000",
    "CCR_MAX_DIFF_BYTES": "300000",
    "CCR_MIN_DIFF_LINES": "0",
    "CCR_STALE_ACTIVE_SECONDS": "1800",
    "CCR_ROOT": "<cwd>/.cmux/ccr",
}

RUNTIME_COMMANDS = ["cmux", "claude", "codex"]
GENERATED_BIN_NAMES = [
    "ccr-lib.sh", "ccr-hook.py", "ccr-hook-claude", "ccr-hook-codex",
    "cmux-setup-claude", "cmux-setup-codex",
    "ccr-help", "ccr-enable", "ccr-disable", "ccr-status", "ccr-request", "ccr-reset",
    "ccr-cancel", "ccr-history", "ccr-show", "ccr-skip-next", "ccr-report",
    "ccr-doctor", "ccr-support", "ccr-ready", "ccr-selftest", "ccr-preview", "ccr-prune", "ccr-config", "ccr-events", "ccr-check", "ccr-uninstall",
]
GENERATED_CLAUDE_COMMAND_FILES = [
    "ccr-request.md", "ccr-status.md", "ccr-history.md", "ccr-skip-next.md",
    "ccr-report.md", "ccr-doctor.md", "ccr-support.md", "ccr-ready.md", "ccr-selftest.md", "ccr-preview.md", "ccr-prune.md", "ccr-config.md", "ccr-events.md", "ccr-check.md",
]

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
    # Unpredictable temp name + O_EXCL (no-follow) via mkstemp so a hostile
    # pre-existing symlink at the temp path cannot be followed/clobbered; clean
    # up the temp on any failure.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.replace(tmp, str(path))
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_NOFOLLOW: refuse to append THROUGH a hostile symlink planted at `path`
    # (os.open raises) rather than redirecting the append to an arbitrary target.
    fd = os.open(str(path), os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
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
    value = re.sub(r"[^A-Za-z0-9_.-]", "_", value)
    # "." / ".." (any all-dots) are path-control segments that would let a
    # sanitized id escape its parent dir; remap dots so the result is always a
    # safe single path component.
    if re.fullmatch(r"\.+", value):
        value = value.replace(".", "_")
    return value


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


def session_context_path(root: Path, session_id: str) -> Path:
    return session_dir(root, session_id) / "context.md"


def session_ledger_path(root: Path, session_id: str) -> Path:
    return session_dir(root, session_id) / "ledger.md"


def capture_session_context(root: Path, session_id: str, prompt: str) -> None:
    """Snapshot the worker's task/intent for this session.

    Overwrites context.md (called when the round counter resets, i.e. a fresh
    task starts). Truncated to keep prompt overhead bounded.
    """
    text = (prompt or "").strip()
    if not text:
        return
    path = session_context_path(root, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join([
        f"<!-- captured: {now()} -->",
        "# Task Context",
        "",
        "Auto-captured from the worker's first user prompt of this CCR session.",
        "Edit this file freely; it is read on every review request.",
        "",
        "## Original Prompt",
        "",
        _truncate_text(text),
        "",
    ])
    path.write_text(body, encoding="utf-8")


def load_session_context(root: Path, session_id: str) -> str:
    path = session_context_path(root, session_id)
    if not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def session_intent_path(root: Path, session_id: str) -> Path:
    return session_dir(root, session_id) / "intent.md"


_INTENT_FIELDS = ("purpose", "non_goal", "invariant")
_INTENT_LABELS = {
    "purpose": ("purpose", "purposes"),
    "non_goal": ("non-goal", "non_goal", "nongoal", "non goal", "non-goals", "non_goals"),
    "invariant": ("invariant", "invariants"),
}


def extract_intent_from_message(text: str) -> dict[str, str]:
    """Pull PURPOSE / NON_GOAL / INVARIANT lines from an assistant message.

    Accepts either `KEY: value` on its own line (single-line form) or a
    `KEY:` header followed by indented / blank-separated lines until the next
    recognized key or a blank line. Returns dict with all three fields,
    empty strings when absent. Matching is case-insensitive on the key.
    """
    result: dict[str, str] = {field: "" for field in _INTENT_FIELDS}
    if not text:
        return result

    canon_map: dict[str, str] = {}
    for field, aliases in _INTENT_LABELS.items():
        for alias in aliases:
            canon_map[alias.lower()] = field

    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        m = re.match(r"^\s*(?:[-*]\s+)?\*?\*?([A-Za-z][A-Za-z _-]*?)\*?\*?\s*:\s*(.*?)\s*$", stripped)
        if not m:
            i += 1
            continue
        key_raw = m.group(1).strip().lower().replace("_", " ").replace("-", " ")
        key_compact = key_raw.replace(" ", "")
        field = canon_map.get(key_raw) or canon_map.get(key_compact)
        if not field:
            i += 1
            continue
        value = m.group(2).strip()
        # Multi-line continuation: collect until next recognized key or blank gap.
        j = i + 1
        cont: list[str] = []
        while j < n:
            nxt = lines[j].strip()
            if not nxt:
                # blank line: peek ahead; if next non-blank is a new key, stop.
                k = j + 1
                while k < n and not lines[k].strip():
                    k += 1
                if k >= n:
                    break
                head = re.match(r"^\s*(?:[-*]\s+)?\*?\*?([A-Za-z][A-Za-z _-]*?)\*?\*?\s*:\s*", lines[k].strip())
                if head:
                    nxt_raw = head.group(1).strip().lower().replace("_", " ").replace("-", " ")
                    if canon_map.get(nxt_raw) or canon_map.get(nxt_raw.replace(" ", "")):
                        break
                cont.append("")
                j += 1
                continue
            head = re.match(r"^\s*(?:[-*]\s+)?\*?\*?([A-Za-z][A-Za-z _-]*?)\*?\*?\s*:\s*", nxt)
            if head:
                nxt_raw = head.group(1).strip().lower().replace("_", " ").replace("-", " ")
                if canon_map.get(nxt_raw) or canon_map.get(nxt_raw.replace(" ", "")):
                    break
            cont.append(nxt)
            j += 1
        if cont:
            tail = "\n".join(cont).strip()
            value = (value + ("\n" if value and tail else "") + tail).strip()
        if value and not result[field]:
            result[field] = value
        i = j
    return result


def load_session_intent(root: Path, session_id: str, fallback_message: str = "") -> dict[str, str]:
    """Return PNI dict: file-based intent.md wins; else heuristic-extract from fallback_message."""
    path = session_intent_path(root, session_id)
    if path.is_file():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        parsed = extract_intent_from_message(text)
        if any(parsed[field] for field in _INTENT_FIELDS):
            return parsed
    return extract_intent_from_message(fallback_message)


def render_intent_section(intent: dict[str, str]) -> list[str]:
    """Markdown block for `## Purpose / Non-goal / Invariant`. Empty list when intent has no content."""
    if not intent or not any(intent.get(f) for f in _INTENT_FIELDS):
        return []
    rows: list[tuple[str, str]] = [
        ("Purpose", intent.get("purpose", "").strip()),
        ("Non-goal", intent.get("non_goal", "").strip()),
        ("Invariant", intent.get("invariant", "").strip()),
    ]
    body: list[str] = [
        "## Purpose / Non-goal / Invariant",
        "",
        "What this change is for and what is deliberately out of scope. Use this to judge whether the diff serves the intent and to flag scope drift. If any field is empty, treat the missing entry as a worker omission — surface it as the first Must Fix item (\"intent.md is missing/incomplete\"), do not return NEEDS_HUMAN for it.",
        "",
    ]
    for label, value in rows:
        if not value:
            body.append(f"- **{label}**: _(missing)_")
        elif "\n" in value:
            body.append(f"- **{label}**:")
            for ln in value.splitlines():
                body.append(f"    {ln}")
        else:
            body.append(f"- **{label}**: {value}")
    body.append("")
    return body


def append_ledger(root: Path, session_id: str, round_no: int, decision: str, must_fix: int, review_file: Path) -> None:
    path = session_ledger_path(root, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    header_needed = not path.is_file()
    lines: list[str] = []
    if header_needed:
        lines.extend([
            "# CCR Iteration Ledger",
            "",
            f"Session: {session_id}",
            "",
            "| Round | Decision | Must-fix | Review |",
            "| ----- | -------- | -------- | ------ |",
        ])
    lines.append(f"| {round_no:04d} | {decision or 'INVALID'} | {must_fix} | {review_file} |")
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def build_iteration_table(root: Path, session_id: str, current_round: int) -> str:
    """Compact markdown table of all prior rounds for this session.

    Returns '' when there is no history (first round).
    """
    if current_round <= 1:
        return ""
    rounds_dir = session_dir(root, session_id) / "rounds"
    if not rounds_dir.is_dir():
        return ""
    rows: list[tuple[int, str, int, str]] = []
    for child in sorted(rounds_dir.iterdir()):
        if not child.is_dir():
            continue
        try:
            n = int(child.name)
        except ValueError:
            continue
        if n >= current_round:
            continue
        decision_path = child / "decision.json"
        review_path = child / "review.md"
        decision = ""
        must_fix = 0
        if decision_path.is_file():
            data = load_json(decision_path, {}) or {}
            decision = str(data.get("decision") or "")
        if review_path.is_file():
            try:
                must_fix = _count_must_fix_in_text(review_path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                pass
        rows.append((n, decision or "INVALID", must_fix, str(review_path) if review_path.is_file() else ""))
    if not rows:
        return ""
    parts = [
        "| Round | Decision | Must-fix | Review |",
        "| ----- | -------- | -------- | ------ |",
    ]
    for n, decision, must_fix, review_path in rows:
        parts.append(f"| {n:04d} | {decision} | {must_fix} | {review_path or '-'} |")
    return "\n".join(parts)


def load_review_instructions(root: Path) -> str:
    """Concatenate global + project review instructions.

    Sources, in order (project text appears last so it can override by restating):
      - Global:  $CONFIG_ROOT/instructions.md
      - Project: <root>/instructions.md   (i.e. <repo>/.cmux/ccr/instructions.md)

    Returns '' if neither file exists or both are empty.
    """
    sections: list[str] = []
    for label, path in (("global", CONFIG_ROOT / "instructions.md"), ("project", root / "instructions.md")):
        try:
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace").strip()
                if text:
                    sections.append(f"<!-- {label}: {path} -->\n{text}")
        except OSError:
            continue
    return "\n\n".join(sections)


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


CCR_HANDOFF_SENTINEL = "[ccr-handoff]"


def send_to_surface(surface: str, message: str) -> bool:
    if not surface:
        return False
    wrapped = f"{CCR_HANDOFF_SENTINEL}\n{message}"
    try:
        subprocess.run(["cmux", "send", "--surface", surface, wrapped], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        subprocess.run(["cmux", "send-key", "--surface", surface, "enter"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


_CCR_HANDOFF_HEADER_RE = re.compile(
    r"^CCR\s+(?:review(?:\s+result)?\s*:|automatic\s+review\s+request\b|manual\s+review\s+request\b)",
    re.IGNORECASE,
)


def is_ccr_handoff_prompt(prompt: str) -> bool:
    if not prompt:
        return False
    first_line = prompt.lstrip().split("\n", 1)[0]
    if first_line.startswith(CCR_HANDOFF_SENTINEL):
        return True
    # Defensive: recognize CCR's own outgoing messages by their first-line header
    # even if the `[ccr-handoff]` sentinel ever gets stripped by the transport.
    if _CCR_HANDOFF_HEADER_RE.match(first_line):
        return True
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
    if parts[:2] == (".open-research", "logs"):
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
        ":(exclude).open-research/logs/**",
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
        # Re-validate the symlink-RESOLVED repo-relative path: an in-tree symlink
        # (e.g. alias.txt -> .env.local) passes safe_rel_path on the link NAME
        # but would read an excluded-sensitive target. Re-check the resolved path.
        if not safe_rel_path(str(path.relative_to(cwd_path))):
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


def _join_sections(sections: list[tuple[str, str]]) -> str:
    return "\n".join(f"{label}\n{body}\n" for label, body in sections)


def _truncate_sections(sections: list[tuple[str, str]], max_bytes: int) -> str:
    secs = [list(s) for s in sections]
    omitted: list[str] = []
    while len(secs) > 2:
        candidate = _join_sections([tuple(s) for s in secs])
        if len(candidate.encode("utf-8")) <= max_bytes:
            break
        dropped = secs.pop()
        omitted.append(dropped[0].lstrip("# "))
    if omitted:
        secs.append(["# Notice", f"Omitted sections to fit CCR_MAX_DIFF_BYTES: {', '.join(omitted)}"])
    candidate = _join_sections([tuple(s) for s in secs])
    if len(candidate.encode("utf-8")) <= max_bytes:
        return candidate
    body_idx = None
    for i in range(len(secs) - 1, -1, -1):
        if secs[i][0] != "# Notice" and secs[i][0] != "# Git HEAD":
            body_idx = i
            break
    if body_idx is None:
        return candidate
    label_name = secs[body_idx][0].lstrip("# ")
    body = secs[body_idx][1]
    while body:
        body = body[: max(1, len(body) // 2)]
        secs[body_idx][1] = body + f"\n# ... {label_name} truncated to fit CCR_MAX_DIFF_BYTES\n"
        candidate = _join_sections([tuple(s) for s in secs])
        if len(candidate.encode("utf-8")) <= max_bytes:
            return candidate
        if len(body) <= 1:
            break
    if len(candidate.encode("utf-8")) > max_bytes:
        stub = f"# Diff omitted: combined size exceeded CCR_MAX_DIFF_BYTES ({max_bytes} bytes) even after truncation.\n"
        if len(stub.encode("utf-8")) <= max_bytes:
            return stub
        return ""
    return candidate


def collect_diff(cwd: str) -> tuple[str, str, str, bool, int, list[str]]:
    if not inside_git(cwd):
        return "", "", "", False, 0, []
    _, head = git(cwd, ["rev-parse", "--short", "HEAD"])
    pathspecs = diff_pathspecs()
    _, staged = git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", *pathspecs])
    _, unstaged = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--", *pathspecs])
    untracked = read_untracked_patch(cwd)
    sections = [
        ("# Git HEAD", head.strip() or "unknown"),
        ("# Staged Diff", staged or ""),
        ("# Unstaged Diff", unstaged or ""),
        ("# Untracked Files", untracked or ""),
    ]
    full = _join_sections(sections)
    has_content = _diff_has_content(full)
    full_changed_lines = count_changed_lines(full)
    files_touched = _files_touched_from_diff_text(full)
    diff_hash = hashlib.sha256(full.encode("utf-8")).hexdigest()
    if MAX_DIFF_BYTES > 0 and len(full.encode("utf-8")) > MAX_DIFF_BYTES:
        combined = _truncate_sections(sections, MAX_DIFF_BYTES)
    else:
        combined = full
    return combined, diff_hash, head.strip(), has_content, full_changed_lines, files_touched


def _diff_has_content(text: str) -> bool:
    for line in text.splitlines():
        if line.startswith("diff --git") or line.startswith("@@"):
            return True
        if line.startswith("+") and not line.startswith("+++"):
            return True
        if line.startswith("-") and not line.startswith("---"):
            return True
    return False


def count_changed_lines(text: str) -> int:
    count = 0
    for line in text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+") or line.startswith("-"):
            count += 1
    return count


def bash_looks_mutating(command: str) -> bool:
    return any(re.search(pattern, command, flags=re.IGNORECASE) for pattern in MUTATING_BASH_PATTERNS)


def should_mark_dirty_for_tool(input_data: dict[str, Any]) -> bool:
    name = tool_name(input_data)
    if name in MUTATING_TOOL_NAMES:
        return True
    if name == "Bash":
        return bash_looks_mutating(tool_command(input_data))
    return False


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
    existing = load_json(root / "status.json", {})
    data = {
        "status": status,
        "reason": reason,
        "updated_at": now(),
        "review_count": state.get("review_count", 0),
        "active_request": state.get("active_request"),
        "last_completed": state.get("last_completed"),
    }
    if isinstance(existing, dict) and isinstance(existing.get("last_report"), dict):
        data["last_report"] = existing["last_report"]
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


def find_previous_round_dir(root: Path, sid: str, round_no: int) -> Path | None:
    if round_no <= 1:
        return None
    prev = session_dir(root, sid) / "rounds" / f"{round_no - 1:04d}"
    return prev if prev.is_dir() else None


def compute_delta_patch(prev_diff: Path, current_diff: Path, dest: Path) -> bool:
    if not prev_diff.is_file() or not current_diff.is_file():
        return False
    proc = subprocess.run(
        ["diff", "-u", str(prev_diff), str(current_diff)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode > 1:
        return False
    if not proc.stdout.strip():
        return False
    # Atomic no-follow write (random temp + os.replace) so a hostile pre-existing
    # `dest` symlink is replaced rather than followed and clobbered.
    fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix=dest.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(proc.stdout)
        os.replace(tmp, str(dest))
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise
    return True


def _truncate_text(text: str, max_chars: int = 12000) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n[truncated to {max_chars} chars]"


def _files_touched_from_diff_text(text: str) -> list[str]:
    files: set[str] = set()
    for line in text.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 3 and parts[2].startswith("a/"):
                files.add(parts[2][2:])
    return sorted(files)


def _fenced_markdown_block(text: str, language: str = "markdown") -> list[str]:
    longest_run = 0
    cur = 0
    for ch in text:
        if ch == "`":
            cur += 1
            longest_run = max(longest_run, cur)
        else:
            cur = 0
    fence = "`" * max(3, longest_run + 1)
    return [f"{fence}{language}", text.rstrip(), fence]


_MUST_FIX_SENTINELS = {"none", "n/a", "na", "-", "(none)", "없음"}


def _is_sentinel_must_fix(text: str) -> bool:
    normalized = text.strip().lower().rstrip(".!?").strip()
    return (not normalized) or normalized in _MUST_FIX_SENTINELS


def _count_must_fix_in_text(text: str) -> int:
    count = 0
    in_section = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.lower().startswith("## must fix"):
            in_section = True
            continue
        if in_section and stripped.startswith("## "):
            break
        if in_section and stripped.startswith("- "):
            body = stripped[2:]
            if _is_sentinel_must_fix(body):
                continue
            count += 1
    return count


def parse_previous_review(prev_dir: Path) -> dict[str, Any] | None:
    if prev_dir is None:
        return None
    decision_path = prev_dir / "decision.json"
    review_path = prev_dir / "review.md"
    if not decision_path.is_file():
        return None
    decision = load_json(decision_path, {}) or {}
    must_fix = 0
    if review_path.is_file():
        must_fix = _count_must_fix_in_text(
            review_path.read_text(encoding="utf-8", errors="replace")
        )
    return {
        "review_file": str(review_path) if review_path.is_file() else "",
        "decision": str(decision.get("decision") or ""),
        "must_fix_count": must_fix,
    }


def build_worker_followup(round_dir: Path, files_touched: list[str], input_data: dict[str, Any]) -> dict[str, Any] | None:
    message = str(input_data.get("last_assistant_message") or "").strip()
    files = sorted(set(files_touched))
    if not message and not files:
        return None
    followup_path = round_dir / "worker-followup.md"
    if message:
        followup_path.write_text(message + "\n", encoding="utf-8")
    return {
        "file": str(followup_path) if message else "",
        "message": message,
        "files": files,
    }


def request_markdown(
    worker: str,
    reviewer: str,
    round_no: int,
    diff_hash: str,
    head: str,
    diff_file: Path,
    delta_file: Path | None = None,
    previous_review: dict[str, Any] | None = None,
    worker_followup: dict[str, Any] | None = None,
    instructions: str = "",
    task_context: str = "",
    iteration_table: str = "",
    intent: dict[str, str] | None = None,
) -> str:
    parts = [
        "# CCR Review Request",
        "",
        f"Worker: {worker}",
        f"Reviewer: {reviewer}",
        f"Round: {round_no}",
        f"Git HEAD: {head or 'unknown'}",
        f"Diff hash: {diff_hash}",
        f"Diff file: {diff_file}",
    ]
    if delta_file is not None:
        parts.append(f"Delta file (changes since previous round): {delta_file}")
    parts.append("")
    intent_block = render_intent_section(intent or {})
    if intent_block:
        parts.extend(intent_block)
    if task_context.strip():
        parts.extend([
            "## Task Context",
            "",
            "What the worker is trying to accomplish in this CCR session. Use this to judge whether the diff actually serves the intent; flag scope drift.",
            "",
            task_context.strip(),
            "",
        ])
    if iteration_table.strip():
        parts.extend([
            "## Iteration So Far",
            "",
            f"This is round {round_no}. Prior rounds in this session:",
            "",
            iteration_table.strip(),
            "",
            "Check whether Must-fix counts are trending toward 0. If they are flat or rising, the worker may be circling — say so in the Verdict.",
            "",
        ])
    if instructions.strip():
        parts.extend([
            "## Project Instructions",
            "",
            "Project-specific conventions and constraints. Treat as authoritative; the rules below take precedence over generic best-practice guesses.",
            "",
            instructions.strip(),
            "",
        ])
    if previous_review:
        parts.extend([
            "## Previous Review",
            "",
            f"- File: {previous_review.get('review_file', '')}",
            f"- Decision: {previous_review.get('decision', '')}",
            f"- Must Fix items in previous round: {previous_review.get('must_fix_count', 0)}",
            "",
            "Focus on whether the previous Must Fix items have been addressed; do not repeat the same comments verbatim if they are now resolved.",
            "",
        ])
    if worker_followup:
        files = worker_followup.get("files") or []
        message = str(worker_followup.get("message") or "")
        parts.extend([
            "## Worker Follow-up Since Previous Review",
            "",
            "Use this section to understand what the worker says was applied and why any previous review items were not applied. Verify the claims against the diff; do not assume they are correct.",
            "",
        ])
        if worker_followup.get("file"):
            parts.append(f"- Worker response file: {worker_followup.get('file')}")
        if files:
            parts.append(f"- Files touched in current diff: {', '.join(files)}")
        if delta_file is not None:
            parts.append(f"- Incremental delta file: {delta_file}")
        if not message:
            parts.extend([
                "- Worker did not provide an explicit applied/not-applied explanation in the last assistant message.",
                "",
            ])
        else:
            parts.extend([
                "",
                "Worker's latest response:",
                "",
                *_fenced_markdown_block(_truncate_text(message)),
                "",
            ])
    parts.extend([
        "You are the reviewer in a two-agent cmux review loop. Do not edit files.",
        "",
        "What to review:",
        "- The diff above. If a delta file is listed, review only the incremental changes since the previous round.",
        "- If Worker Follow-up is listed, verify each claimed \"applied\" change against the diff. Do not trust the claim.",
        "",
        "Review process (multi-agent — required):",
        "- Run a parallel independent code review: spawn 8 read-only reviewer subagents in parallel, each given the same diff/context but a distinct lens, with no shared findings between them. One lens per subagent:",
        "  A1. Baseline correctness & regressions — logic bugs, broken behavior, off-by-one, error handling.",
        "  A2. User-visible regressions & requirements/intent fit — does the diff serve the stated Purpose/intent and Task Context? Flag scope drift and missing requirements.",
        "  A3. Edge cases & invalid states — boundary inputs, empty/null, unexpected ordering, partial failures.",
        "  A4. Security, auth, privacy & data safety — secrets, injection, unsafe defaults, permission boundaries, data loss/corruption.",
        "  A5. Data invariants & API/contract stability — schema/format guarantees, backward compatibility, serialization.",
        "  A6. Concurrency, lifecycle, async ordering, resources & error handling — race conditions, locks, leaks, blocking I/O.",
        "  A7. Tests, CI, deploy & migrations — missing or weak tests for changed behavior, untested edge cases, flaky or wrong assertions, migration/rollout risk.",
        "  A8. Architecture, integration impact & maintainability — boundaries, duplication, naming, readability, API clarity, needless complexity.",
        "- Each subagent must be read-only (no file edits, no git mutations, no recursive CCR review). It returns findings as `file:line` + concrete fix + trigger/impact; if its lens is clean it reports nothing.",
        "- If your runtime cannot spawn subagents, instead perform the 8 lenses as 8 separate sequential review passes and keep their findings distinct.",
        "- Aggregate the results yourself: cluster duplicates by ROOT CAUSE (not by title or line number); duplicate count is a confidence signal, not the primary ranking. Verify each finding's evidence locally before reporting and drop speculative ones. Preserve rare but verified single-agent findings — never bury a critical single-agent find under obvious medium ones.",
        "- Then YOU consolidate into ONE review and decide a single overall REVIEW_DECISION, classifying each kept finding by the Must Fix / Should Consider bar below. Emit only the consolidated review; do not paste the raw per-subagent reports.",
        "",
        "Reviewer constraints (strict):",
        "- Do not edit, create, or delete files.",
        "- Do not run any git mutation: `git add` / `commit` / `checkout` / `restore` / `stash` / `reset` / `push`. Read-only git commands (`git diff`, `git log`, `git show`) are fine.",
        "- Do not request another CCR review (no recursive `ccr-request`, no `[ccr-handoff]` sentinels).",
        "- Stay in reviewer mode until you have emitted the `REVIEW_DECISION:` line, then stop. Do not switch back to dev work in the same reply.",
        "",
        "Bar for findings (skip anything below the bar — do not pad):",
        "- Must Fix: bug, regression, broken requirement, missing critical test, security/data issue. Cite `file:line` and propose a concrete fix.",
        "- Should Consider: real maintainability or design risk worth raising. No pure style nits.",
        "- If nothing meets the bar, return PASS. Do not invent issues to justify NEEDS_CHANGES.",
        "",
        "Output exactly one decision line near the top:",
        "REVIEW_DECISION: PASS",
        "REVIEW_DECISION: NEEDS_CHANGES",
        "REVIEW_DECISION: NEEDS_HUMAN",
        "",
        "NEEDS_HUMAN is only for policy / security / business calls outside an agent's safe scope. Routine defects are NEEDS_CHANGES.",
        "",
        "Then use this Markdown structure (omit empty sections):",
        "",
        "# Review",
        "",
        "## Must Fix",
        "- `path/to/file.go:42` — what is wrong — proposed fix",
        "",
        "## Should Consider",
        "- `path/to/file.go:99` — observation",
        "",
        "## Verdict",
        "- One sentence.",
        "",
    ])
    return "\n".join(parts)


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

    instructions = str(scope.get("instructions") or "").strip()
    instructions_block = (
        f"\n## Project Instructions\n\n"
        f"Project-specific conventions and constraints. Treat as authoritative; the rules below take precedence over generic best-practice guesses.\n\n"
        f"{instructions}\n"
    ) if instructions else ""

    intent_dict = scope.get("intent") if isinstance(scope.get("intent"), dict) else {}
    intent_lines = render_intent_section({str(k): str(v or "") for k, v in (intent_dict or {}).items()})
    intent_block = ("\n" + "\n".join(intent_lines)) if intent_lines else ""

    return f"""# CCR Manual Review Request

Title: {title}
Review type: {review_type}
Worker: {scope.get("worker")}
Reviewer: {scope.get("reviewer")}
Scope file: {scope_file}
Diff file: {diff_file or "not included"}
{intent_block}
## Scope Files
{bullets(files)}

## Scope Directories
{bullets(directories)}

## Questions
{bullets(questions)}

## Notes
{bullets(notes)}
{instructions_block}
## Review Focus
{bullets(focus)}

Review process (multi-agent — required):
- Run a parallel independent code review: spawn 8 read-only reviewer subagents in parallel, each given the same scope/context but a distinct lens, with no shared findings between them. Cover the Review Focus items above first, then fill the remaining slots until you have 8 distinct lenses: A1 baseline correctness & regressions, A2 user-visible regressions & requirements/intent fit, A3 edge cases & invalid states, A4 security/auth/privacy & data safety, A5 data invariants & API/contract stability, A6 concurrency/lifecycle/async ordering/resources & error handling, A7 tests/CI/deploy/migrations & coverage, A8 architecture/integration impact & maintainability.
- Each subagent must be read-only (no file edits, no git mutations, no recursive CCR review). It returns findings as `file:line` + concrete fix + trigger/impact; if its lens is clean it reports nothing.
- If your runtime cannot spawn subagents, instead perform the 8 lenses as 8 separate sequential review passes and keep their findings distinct.
- Aggregate the results yourself: cluster duplicates by ROOT CAUSE (not by title or line number); duplicate count is a confidence signal, not the primary ranking. Verify each finding's evidence locally before reporting and drop speculative ones. Preserve rare but verified single-agent findings — never bury a critical single-agent find under obvious medium ones.
- Then YOU consolidate into ONE review and decide a single overall REVIEW_DECISION, classifying each kept finding by the Must Fix / Should Consider bar below. Emit only the consolidated review; do not paste the raw per-subagent reports.

Reviewer constraints (strict):
- Do not edit, create, or delete files.
- Do not run any git mutation: `git add` / `commit` / `checkout` / `restore` / `stash` / `reset` / `push`. Read-only git commands (`git diff`, `git log`, `git show`) are fine.
- Do not request another CCR review (no recursive `ccr-request`, no `[ccr-handoff]` sentinels).
- Stay in reviewer mode until you have emitted the `REVIEW_DECISION:` line, then stop.

Bar for findings:
- Review only the files, directories, and questions listed in scope.json. The diff (if any) is supporting context, not the source of truth.
- For each finding, cite `file:line` and propose a concrete fix.
- If nothing meets the Must Fix / Should Consider bar, return PASS without padding.

Output exactly one decision line near the top:
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES
REVIEW_DECISION: NEEDS_HUMAN

NEEDS_HUMAN is only for policy / security / business calls outside an agent's safe scope. Routine defects are NEEDS_CHANGES.

Then use this Markdown structure (omit empty sections):

# Review

## Must Fix
- `path/to/file.go:42` — what is wrong — proposed fix

## Should Consider
- `path/to/file.go:99` — observation

## Verdict
- One sentence.
"""


def _latest_session_id(root: Path) -> str | None:
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        return None
    candidates = [d for d in sessions_dir.iterdir() if d.is_dir() and (d / "rounds").is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d.stat().st_mtime).name


def _format_duration(seconds: int) -> str:
    if seconds < 0:
        return "-"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60}m"


def _round_must_fix_count(rdir: Path) -> int:
    review_path = rdir / "review.md"
    if not review_path.is_file():
        return 0
    return _count_must_fix_in_text(review_path.read_text(encoding="utf-8", errors="replace"))


def _round_files_touched(rdir: Path) -> set[str]:
    files: set[str] = set()
    diff_path = rdir / "diff.patch"
    if not diff_path.is_file():
        return files
    try:
        text = diff_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return files
    for line in text.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 3 and parts[2].startswith("a/"):
                files.add(parts[2][2:])
    return files


def generate_session_report(root: Path, sid: str, outcome: str, *, trigger: str = "auto") -> Path | None:
    if not sid:
        sid = _latest_session_id(root) or ""
    if not sid:
        return None
    sdir = session_dir(root, sid)
    rounds_dir = sdir / "rounds"
    if not sdir.is_dir():
        return None
    session_meta = load_json(sdir / "session.json", {})
    if not isinstance(session_meta, dict):
        session_meta = {}
    round_dirs = sorted([d for d in rounds_dir.iterdir() if d.is_dir()]) if rounds_dir.is_dir() else []

    digests: list[dict[str, Any]] = []
    files_all: set[str] = set()
    total_changed_lines = 0
    for rdir in round_dirs:
        dec = load_json(rdir / "decision.json", {}) or {}
        if not isinstance(dec, dict):
            dec = {}
        digests.append({
            "round": int(dec.get("round") or int(rdir.name) if rdir.name.isdigit() else 0),
            "at": str(dec.get("updated_at") or ""),
            "decision": str(dec.get("decision") or "(none)"),
            "must_fix": _round_must_fix_count(rdir),
            "review_path": str(rdir / "review.md") if (rdir / "review.md").is_file() else "",
            "request_path": str(rdir / "request.md") if (rdir / "request.md").is_file() else "",
            "diff_path": str(rdir / "diff.patch") if (rdir / "diff.patch").is_file() else "",
            "delta_path": str(rdir / "delta.patch") if (rdir / "delta.patch").is_file() else "",
            "worker": str(dec.get("worker") or ""),
            "reviewer": str(dec.get("reviewer") or ""),
        })
        files_all |= _round_files_touched(rdir)
        diff_path = rdir / "diff.patch"
        if diff_path.is_file():
            try:
                total_changed_lines += count_changed_lines(diff_path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                pass

    started_at = str(session_meta.get("created_at") or (digests[0]["at"] if digests else ""))
    ended_at = now()
    duration = "-"
    try:
        if started_at:
            t_start = time.strptime(started_at, "%Y-%m-%dT%H:%M:%SZ")
            t_end = time.strptime(ended_at, "%Y-%m-%dT%H:%M:%SZ")
            duration = _format_duration(int(calendar.timegm(t_end) - calendar.timegm(t_start)))
    except ValueError:
        pass

    skip_count = 0
    prompt_count = 0
    events_path = root / "events.jsonl"
    interventions: list[dict[str, Any]] = []
    if events_path.is_file():
        try:
            for raw in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not raw.strip():
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(ev, dict):
                    continue
                ev_sid = ev.get("session_id")
                if ev_sid and str(ev_sid) != sid:
                    continue
                etype = str(ev.get("type") or "")
                if etype == "skipped":
                    skip_count += 1
                    interventions.append(ev)
                elif etype == "user_prompt":
                    prompt_count += 1
                    interventions.append(ev)
        except OSError:
            pass

    worker_role = (digests[-1]["worker"] if digests else "") or str(session_meta.get("role") or "")
    reviewer_role = (digests[-1]["reviewer"] if digests else "")
    if not reviewer_role and worker_role:
        reviewer_role = "codex" if worker_role == "claude" else "claude" if worker_role == "codex" else ""
    rounds_count = len(digests)
    last_decision = digests[-1]["decision"] if digests else "(none)"

    summary_lines = [
        f"Outcome: {outcome} after {rounds_count} round(s). Last decision: {last_decision}.",
        f"Worker: {worker_role or '?'} -> Reviewer: {reviewer_role or '?'}. Total changed lines across rounds: {total_changed_lines}.",
    ]
    if skip_count or prompt_count:
        summary_lines.append(f"Manual interventions: {skip_count} skip(s), {prompt_count} user-prompt reset(s).")
    summary_text = "\n".join(summary_lines)

    md = [
        "# CCR Session Report",
        "",
        "## Summary",
        "",
        summary_text,
        "",
        "## Metadata",
        "",
        "| Key | Value |",
        "|---|---|",
        f"| session_id | `{sid}` |",
        f"| workspace_id | `{session_meta.get('workspace_id', '-')}` |",
        f"| cwd | `{session_meta.get('cwd', '-')}` |",
        f"| worker | {worker_role or '-'} |",
        f"| reviewer | {reviewer_role or '-'} |",
        f"| started_at | {started_at or '-'} |",
        f"| ended_at | {ended_at} |",
        f"| duration | {duration} |",
        f"| outcome | **{outcome}** |",
        f"| total_rounds | {rounds_count} |",
        f"| manual_skips | {skip_count} |",
        f"| user_prompt_resets | {prompt_count} |",
        f"| trigger | {trigger} |",
        "",
        "## Rounds",
        "",
        "| round | time | decision | must-fix | delta? | review |",
        "|---:|---|---|---:|:---:|---|",
    ]
    for d in digests:
        delta_mark = "✓" if d["delta_path"] else ""
        md.append(
            f"| {d['round']} | {d['at']} | {d['decision']} | {d['must_fix']} | {delta_mark} | `{d['review_path'] or '-'}` |"
        )
    if not digests:
        md.append("| – | – | – | – | – | – |")
    md.append("")
    md.append("## Files Touched")
    md.append("")
    if files_all:
        for fname in sorted(files_all):
            md.append(f"- `{fname}`")
    else:
        md.append("(none detected from diff.patch headers)")
    md.append("")
    md.append("Note: paths derived from per-round diff.patch headers; may not match the current working tree.")
    md.append("")

    if digests:
        md.append("## Round details")
        md.append("")
        for d in digests:
            md.append(f"### Round {d['round']} - {d['decision']}")
            md.append("")
            md.append(f"- request: `{d['request_path'] or '-'}`")
            md.append(f"- diff: `{d['diff_path'] or '-'}`")
            if d['delta_path']:
                md.append(f"- delta: `{d['delta_path']}`")
            md.append(f"- review: `{d['review_path'] or '-'}`")
            md.append("")
            review_text = ""
            if d['review_path']:
                try:
                    review_text = Path(d['review_path']).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    review_text = ""
            if review_text.strip():
                longest_run = 0
                cur = 0
                for ch in review_text:
                    if ch == "`":
                        cur += 1
                        if cur > longest_run:
                            longest_run = cur
                    else:
                        cur = 0
                fence = "`" * max(3, longest_run + 1)
                md.append("<details><summary>review.md</summary>")
                md.append("")
                md.append(f"{fence}markdown")
                md.append(review_text.rstrip())
                md.append(fence)
                md.append("")
                md.append("</details>")
                md.append("")

    md.append("## Manual interventions")
    md.append("")
    if interventions:
        for ev in interventions:
            md.append(
                f"- {ev.get('at','?')} `{ev.get('type','?')}` reason=`{ev.get('reason','-')}`"
            )
    else:
        md.append("(none)")
    md.append("")

    report_path = sdir / "report.md"
    report_path.write_text("\n".join(md), encoding="utf-8")

    status_path = root / "status.json"
    status_data = load_json(status_path, {})
    if not isinstance(status_data, dict):
        status_data = {}
    status_data["last_report"] = {
        "path": str(report_path),
        "outcome": outcome,
        "at": ended_at,
        "summary": summary_text,
    }
    write_json(status_path, status_data)

    level = "success" if outcome in {"passed", "cancelled"} else "warning"
    cmux_log(level, f"report ({outcome}): {summary_lines[0]}")
    cmux_notify(f"CCR {outcome}", f"{summary_lines[0]}\n{report_path}")
    append_jsonl(root / "events.jsonl", {
        "at": ended_at,
        "type": "report",
        "outcome": outcome,
        "trigger": trigger,
        "path": str(report_path),
        "session_id": sid,
    })
    return report_path


def _try_generate_report(root: Path, sid: str | None, outcome: str, trigger: str = "auto") -> None:
    try:
        generate_session_report(root, sid or "", outcome, trigger=trigger)
    except Exception as exc:
        cmux_log("warning", f"report generation failed ({outcome}): {exc}")


def opposite(role: str) -> str:
    return "codex" if role == "claude" else "claude"


def skip_marker_path(root: Path) -> Path:
    return root / "skip-next.json"


def consume_skip_marker(root: Path) -> dict[str, Any] | None:
    path = skip_marker_path(root)
    if not path.is_file():
        return None
    data = load_json(path, {})
    if not isinstance(data, dict):
        data = {}
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return data


def _active_request_age_seconds(active: dict[str, Any]) -> float | None:
    raw = str(active.get("created_at") or "").strip()
    if not raw:
        return None
    try:
        from datetime import datetime, timezone
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except (ValueError, TypeError):
        return None


def reap_stale_active(root: Path, state: dict[str, Any], event: str, input_data: dict[str, Any], role: str) -> bool:
    """Clear `state["active_request"]` if it is stale or orphaned.

    Triggers (any one suffices):
      - Age-based: ONLY on `SessionStart`, when `age >= STALE_ACTIVE_SECONDS`
        (env-tunable; 0 disables). Routine mid-session events (UserPromptSubmit
        / PostToolUse / Stop) never age-reap, so a slow or large review in
        flight is not cancelled by the worker's own activity while it waits.
      - Session-mismatch: ONLY on `SessionStart` fired by the WORKER surface
        (``role == active["worker"]``) when the incoming session_id differs
        from the active's `worker_session_id` — the worker started a fresh
        session, orphaning the old request. Reviewer-side events and the
        worker's mid-review `UserPromptSubmit` never reap on mismatch, so a
        reviewer handoff (whose session_id naturally differs) cannot clear the
        active request before `finish_review` finalizes it.

    Returns True when the active_request was cleared.
    """
    active = state.get("active_request")
    if not isinstance(active, dict):
        return False

    age = _active_request_age_seconds(active)
    sid = str(input_data.get("session_id") or "").strip()
    active_sid = str(active.get("worker_session_id") or "").strip()

    reason: str | None = None
    if (
        event == "SessionStart"
        and STALE_ACTIVE_SECONDS > 0
        and age is not None
        and age >= STALE_ACTIVE_SECONDS
    ):
        reason = f"age={int(age)}s >= {STALE_ACTIVE_SECONDS}s"
    elif (
        event == "SessionStart"
        and role == active.get("worker")
        and sid
        and active_sid
        and sid != active_sid
    ):
        age_label = f"age={int(age)}s" if age is not None else "age=unknown"
        reason = f"session mismatch (incoming={sid} active={active_sid}, {age_label})"

    if reason is None:
        return False

    cmux_log("warning", f"discarding stale active_request: {reason}")
    append_jsonl(root / "events.jsonl", {
        "at": now(),
        "type": "stale_active_discarded",
        "trigger_event": event,
        "reason": reason,
        "age_seconds": int(age) if age is not None else None,
        "threshold": STALE_ACTIVE_SECONDS,
        "round": int(active.get("round") or 0),
        "worker": active.get("worker"),
        "reviewer": active.get("reviewer"),
        "session_id": sid,
        "active_session_id": active_sid,
    })
    state["active_request"] = None
    write_status(root, state, "ready", f"stale active discarded ({reason})")
    cmux_status("CCR ready", "#34C759")
    return True


def start_review(root: Path, state: dict[str, Any], input_data: dict[str, Any], role: str) -> None:
    sid = str(input_data.get("session_id") or "")
    cwd = str(input_data.get("cwd") or "")
    if not sid or not cwd or not has_dirty(root, sid):
        return
    if isinstance(state.get("active_request"), dict):
        cmux_log("progress", "review already active; worker stop ignored")
        return
    if state.get("review_count", 0) >= MAX_ROUNDS:
        clear_dirty(root, sid)
        write_status(root, state, "stopped", f"max rounds reached ({MAX_ROUNDS})")
        cmux_status("CCR max rounds", "#FF9500")
        cmux_notify("CCR stopped", f"Maximum review rounds reached: {MAX_ROUNDS}")
        _try_generate_report(root, sid, "max_rounds")
        return
    diff_text, diff_hash, head, has_content, full_changed, files_touched = collect_diff(cwd)
    if not has_content:
        clear_dirty(root, sid)
        write_status(root, state, "idle", "no diff")
        cmux_status("CCR idle", "#34C759")
        return
    if MIN_DIFF_LINES > 0:
        changed = full_changed
        if changed < MIN_DIFF_LINES:
            clear_dirty(root, sid)
            reason = f"diff has {changed} changed lines (< CCR_MIN_DIFF_LINES={MIN_DIFF_LINES})"
            write_status(root, state, "skipped", reason)
            cmux_status("CCR skipped", "#8E8E93")
            cmux_log("progress", f"diff below threshold ({changed} < {MIN_DIFF_LINES})")
            append_jsonl(root / "events.jsonl", {
                "at": now(),
                "type": "skipped",
                "reason": "below_min_diff_lines",
                "changed_lines": changed,
                "threshold": MIN_DIFF_LINES,
                "session_id": sid,
            })
            return
    if diff_hash == state.get("last_diff_hash"):
        clear_dirty(root, sid)
        write_status(root, state, "stopped", "same diff hash")
        cmux_status("CCR same diff", "#FF9500")
        cmux_notify("CCR stopped", "Same diff hash detected; automatic loop stopped.")
        _try_generate_report(root, sid, "same_hash")
        return

    marker = consume_skip_marker(root)
    if marker is not None:
        clear_dirty(root, sid)
        write_status(root, state, "skipped", "ccr-skip-next consumed")
        cmux_status("CCR skipped", "#8E8E93")
        cmux_log("progress", "ccr-skip-next consumed; outgoing review skipped")
        append_jsonl(root / "events.jsonl", {
            "at": now(),
            "type": "skipped",
            "reason": "ccr-skip-next",
            "session_id": sid,
            "by_surface": marker.get("by_surface", ""),
        })
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

    prev_dir = find_previous_round_dir(root, sid, round_no)
    delta_file: Path | None = None
    previous_review: dict[str, Any] | None = None
    if prev_dir is not None:
        previous_review = parse_previous_review(prev_dir)
        candidate = round_dir / "delta.patch"
        if compute_delta_patch(prev_dir / "diff.patch", diff_file, candidate):
            delta_file = candidate
    worker_followup = build_worker_followup(round_dir, files_touched, input_data) if prev_dir is not None else None

    instructions = load_review_instructions(root)
    task_context = load_session_context(root, sid)
    iteration_table = build_iteration_table(root, sid, round_no)
    last_message_for_intent = str(input_data.get("last_assistant_message") or "")
    intent = load_session_intent(root, sid, last_message_for_intent)
    request_file.write_text(
        request_markdown(role, reviewer, round_no, diff_hash, head, diff_file, delta_file, previous_review, worker_followup, instructions, task_context, iteration_table, intent),
        encoding="utf-8",
    )

    message = (
        "CCR automatic review request. Read the request file and perform the review only — do not edit files.\n\n"
        f"Request: {request_file}"
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


DECISION_RE = re.compile(
    r"^\s*REVIEW_DECISION:\s*(PASS|NEEDS_CHANGES|NEEDS_HUMAN)\b",
    re.IGNORECASE,
)


def parse_decision(message: str) -> str:
    in_fence = False
    for raw in (message or "").splitlines():
        stripped = raw.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if stripped.startswith(">"):
            continue
        m = DECISION_RE.match(raw)
        if m:
            return m.group(1).upper()
    return "INVALID"


def finish_review(root: Path, state: dict[str, Any], input_data: dict[str, Any], role: str) -> bool:
    """Finalize a review reply on the reviewer's Stop event.

    Returns True when an active_request was finalized in this call (PASS /
    NEEDS_CHANGES / NEEDS_HUMAN / invalid). The Stop dispatcher uses that to
    suppress an immediately-following `start_review` from the same hook firing
    — otherwise the reviewer's surface would both send the review reply AND
    open a brand-new outgoing round (if its session happens to be dirty), and
    the worker would receive both back-to-back.

    Returns False when there is nothing to finalize (no active, wrong role,
    empty assistant message).
    """
    active = state.get("active_request")
    if not isinstance(active, dict) or active.get("reviewer") != role:
        return False
    last_message = str(input_data.get("last_assistant_message") or "")
    if not last_message.strip():
        return False
    reviewer_sid = str(input_data.get("session_id") or "")
    worker_session_id = str(active.get("worker_session_id") or "")
    round_no = int(active.get("round") or 0)
    round_dir = session_dir(root, worker_session_id) / "rounds" / f"{round_no:04d}"
    review_file = round_dir / "review.md"
    decision_file = round_dir / "decision.json"
    review_file.write_text(last_message + "\n", encoding="utf-8")
    decision = parse_decision(last_message)
    must_fix_count = _count_must_fix_in_text(last_message)
    write_json(decision_file, {
        "decision": decision,
        "reviewer": role,
        "worker": active.get("worker"),
        "round": round_no,
        "review_file": str(review_file),
        "must_fix_count": must_fix_count,
        "updated_at": now(),
    })
    append_ledger(root, worker_session_id, round_no, decision, must_fix_count, review_file)
    ledger_file = session_ledger_path(root, worker_session_id)

    worker_surface = str(active.get("worker_surface") or "")
    if decision == "PASS":
        message = (
            "CCR review result: PASS. "
            "Skim the review for any \"Should Consider\" notes, then finish the task "
            "(commit, push, or hand back to the user as appropriate). "
            "Do not start unrelated changes.\n\n"
            f"Review: {review_file}\n"
            f"Ledger (full session arc): {ledger_file}"
        )
        send_to_surface(worker_surface, message)
        state["last_completed"] = {"round": round_no, "decision": decision, "at": now()}
        state["active_request"] = None
        if reviewer_sid:
            clear_dirty(root, reviewer_sid)
        write_status(root, state, "passed", f"round {round_no}")
        cmux_status("CCR pass", "#34C759")
        cmux_log("success", f"round {round_no} review passed")
        _try_generate_report(root, worker_session_id, "passed")
        return True

    if decision == "NEEDS_CHANGES":
        message = (
            f"CCR review: NEEDS_CHANGES (round {round_no}, {must_fix_count} must-fix). Read the review, then:\n"
            "1) Apply the Must Fix items you agree with. If you disagree with an item, push back explicitly — do not silently skip it.\n"
            "2) Touch only what the review calls out. No unrelated cleanup or refactors this round.\n"
            "3) End your reply with an \"Applied / Not applied (reason)\" list, one bullet per review item. "
            "This list is forwarded to the reviewer next round, so cite `file:line` and be specific.\n\n"
            f"Review: {review_file}\n"
            f"Ledger (full session arc): {ledger_file}"
        )
        send_to_surface(worker_surface, message)
        state["active_request"] = None
        if reviewer_sid:
            clear_dirty(root, reviewer_sid)
        write_status(root, state, "changes_requested", f"round {round_no}")
        cmux_status(f"CCR r{round_no} changes", "#FF9500")
        cmux_log("warning", f"round {round_no} changes requested")
        return True

    if decision == "NEEDS_HUMAN":
        message = (
            "CCR review: NEEDS_HUMAN. The reviewer flagged a policy / security / business decision "
            "outside an agent's safe scope. Do not auto-apply any changes. "
            "Surface the review to the user, summarize the decision they need to make, and wait for their call.\n\n"
            f"Review: {review_file}\n"
            f"Ledger (full session arc): {ledger_file}"
        )
        send_to_surface(worker_surface, message)
        state["last_completed"] = {"round": round_no, "decision": decision, "at": now()}
        state["active_request"] = None
        if reviewer_sid:
            clear_dirty(root, reviewer_sid)
        write_status(root, state, "manual_intervention", f"round {round_no} needs human")
        cmux_status(f"CCR r{round_no} needs human", "#FF9500")
        cmux_log("warning", f"round {round_no} needs human review")
        cmux_notify("CCR needs human", f"Round {round_no} review requires human decision: {review_file}")
        _try_generate_report(root, worker_session_id, "needs_human")
        return True

    state["active_request"] = None
    if reviewer_sid:
        clear_dirty(root, reviewer_sid)
    write_status(root, state, "manual_intervention", f"invalid decision in round {round_no}")
    cmux_status("CCR manual", "#FF3B30")
    cmux_notify("CCR needs manual review", f"Invalid review decision in {review_file}")
    _try_generate_report(root, worker_session_id, "invalid")
    return True


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


def handle_user_prompt_submit(root: Path, state: dict[str, Any], input_data: dict[str, Any], agent: str, role: str) -> None:
    sid = str(input_data.get("session_id") or "")
    prompt = str(input_data.get("prompt") or "")
    if is_ccr_handoff_prompt(prompt):
        # Receiver of a CCR handoff (review request OR review result). Clear any
        # stale dirty marker on the receiver's session so that, when this surface
        # later hits Stop after producing the review reply, `start_review` does
        # not spuriously spawn a new outgoing round from leftover worker-mode
        # state. The receiver's own subsequent edits will re-mark dirty as
        # needed via PostToolUse.
        if sid:
            clear_dirty(root, sid)
        cmux_log("progress", "UserPromptSubmit: CCR handoff received; cleared receiver dirty marker")
        return
    if isinstance(state.get("active_request"), dict):
        cmux_log("progress", "UserPromptSubmit ignored while review is active")
        return
    prev_count = int(state.get("review_count", 0) or 0)
    if prev_count == 0 and not state.get("last_diff_hash"):
        if sid and prompt and not session_context_path(root, sid).is_file():
            capture_session_context(root, sid, prompt)
        return
    state["review_count"] = 0
    state["last_diff_hash"] = ""
    if sid and prompt:
        capture_session_context(root, sid, prompt)
    write_status(root, state, "ready", f"new {role} request (round counter reset)")
    cmux_status("CCR ready", "#34C759")
    cmux_log("progress", f"user prompt: review_count reset (was {prev_count})")
    append_jsonl(root / "events.jsonl", {
        "at": now(),
        "type": "user_prompt",
        "agent": agent,
        "role": role,
        "session_id": sid,
        "prev_review_count": prev_count,
    })


def handle_hook(agent: str, event: str, input_data: dict[str, Any]) -> dict[str, Any] | None:
    cwd = str(input_data.get("cwd") or os.getcwd())
    role = role_for_current_surface()
    if not workspace_enabled() or role == "unknown":
        return {} if agent == "codex" and event == "Stop" else None

    root = root_for_cwd(cwd)
    with locked_state(root) as state:
        ensure_session(root, agent, role, input_data)
        reap_stale_active(root, state, event, input_data, role)
        if event == "SessionStart":
            write_status(root, state, "idle", "session started")
            cmux_status("CCR idle", "#34C759")
            return None
        if event == "UserPromptSubmit":
            handle_user_prompt_submit(root, state, input_data, agent, role)
            return None
        if event == "PreToolUse":
            return handle_pre_tool(root, state, input_data, agent, role)
        if event == "PostToolUse":
            active = state.get("active_request")
            if isinstance(active, dict) and active.get("reviewer") == role:
                return None
            if not should_mark_dirty_for_tool(input_data):
                cmux_log("progress", f"PostToolUse ignored (non-mutating): {role}/{tool_name(input_data)}")
                return None
            mark_dirty(root, input_data, agent, role)
            write_status(root, state, "dirty", f"{role} changed files")
            cmux_status("CCR dirty", "#FF9500")
            return None
        if event == "Stop":
            if str(input_data.get("stop_hook_active", "false")).lower() == "true":
                return {} if agent == "codex" else None
            finished_review = finish_review(root, state, input_data, role)
            if finished_review:
                # The current surface just produced a review reply. Do NOT
                # immediately open a new outgoing round from this same surface
                # — that would race with the handoff message the worker is
                # about to receive and cause the worker to re-review instead
                # of apply. The next genuine worker edit will trigger
                # start_review on a subsequent Stop.
                cmux_log("progress", "Stop: skipped start_review (reviewer just finalized a reply)")
            else:
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
    version = read_text(CONFIG_ROOT / "VERSION") or "unknown"
    print(f"Workspace: {workspace_id() or '-'}")
    print(f"Enabled: {'yes' if workspace_enabled() else 'no'}")
    print(f"Version: {version}")
    print(f"Claude surface: {surface_for_role('claude') or '-'}")
    print(f"Codex surface: {surface_for_role('codex') or '-'}")
    print(f"CCR root: {root}")
    print(f"Status: {status.get('status', '-')}")
    print(f"Reason: {status.get('reason', '-')}")
    print(f"Review count: {state.get('review_count', 0)}")
    last_completed = state.get("last_completed")
    if isinstance(last_completed, dict):
        print(f"Last round: r{last_completed.get('round', '?')} {last_completed.get('decision', '?')} @ {last_completed.get('at', '?')}")
    else:
        print("Last round: -")
    active = state.get("active_request")
    if isinstance(active, dict):
        elapsed = ""
        elapsed_secs = -1
        created = active.get("created_at")
        if created:
            try:
                t_created = time.strptime(str(created), "%Y-%m-%dT%H:%M:%SZ")
                elapsed_secs = max(0, int(time.time() - calendar.timegm(t_created)))
                elapsed = f" elapsed={elapsed_secs}s"
            except ValueError:
                pass
        print(f"Active request: r{active.get('round','?')} {active.get('worker','?')}->{active.get('reviewer','?')}{elapsed}")
        print(f"Active request details: {json.dumps(active, ensure_ascii=False)}")
        if STALE_ACTIVE_SECONDS > 0 and elapsed_secs >= STALE_ACTIVE_SECONDS:
            print(f"Hint: active request is {elapsed_secs}s old (>= CCR_STALE_ACTIVE_SECONDS={STALE_ACTIVE_SECONDS}s). It will be auto-discarded on the next hook event from this workspace, or run `ccr-cancel` to recover immediately.")
    else:
        print("Active request: -")
    skip = skip_marker_path(root)
    if skip.is_file():
        print(f"Skip-next: pending ({skip})")
    last_report = status.get("last_report") if isinstance(status, dict) else None
    if isinstance(last_report, dict) and last_report.get("path"):
        print(f"Last report: {last_report.get('outcome','?')} @ {last_report.get('at','?')} -> {last_report.get('path')}")
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
            diff_text, diff_hash, head, _has_content, _changed, _files_touched = collect_diff(cwd)
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
            "instructions": load_review_instructions(root),
            "intent": {
                "purpose": str(getattr(args, "purpose", "") or "").strip(),
                "non_goal": str(getattr(args, "non_goal", "") or "").strip(),
                "invariant": str(getattr(args, "invariant", "") or "").strip(),
            },
            "created_at": now(),
        }
        write_json(scope_file, scope)
        request_file.write_text(scope_request_markdown(scope), encoding="utf-8")

        message = (
            "CCR manual review request. Read request.md and scope.json, then perform the review only — do not edit files.\n\n"
            f"Request: {request_file}"
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


def command_cancel() -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    if not root.exists():
        print("CCR root not found for this cwd.", file=sys.stderr)
        return 1
    cancelled_active: dict[str, Any] | None = None
    with locked_state(root) as state:
        active = state.get("active_request")
        if isinstance(active, dict):
            cancelled_active = dict(active)
        state["active_request"] = None
        write_status(root, state, "cancelled", "ccr-cancel")
    sessions_dir = root / "sessions"
    if sessions_dir.is_dir():
        for sdir in sessions_dir.iterdir():
            dirty = sdir / "dirty.json"
            if dirty.is_file():
                with contextlib.suppress(FileNotFoundError):
                    dirty.unlink()
    cmux_status("CCR cancelled", "#8E8E93")
    cmux_log("warning", "ccr-cancel executed")
    if cancelled_active:
        cancel_sid = str(cancelled_active.get("worker_session_id") or "")
        _try_generate_report(root, cancel_sid, "cancelled", trigger="cancel")
    if cancelled_active:
        print(
            f"Cancelled active request: round {cancelled_active.get('round','?')} "
            f"({cancelled_active.get('worker','?')}->{cancelled_active.get('reviewer','?')})"
        )
    else:
        print("No active request; status set to cancelled and dirty flags cleared.")
    return 0


def command_history(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        print("No sessions yet.")
        return 0
    entries: list[dict[str, Any]] = []
    for sdir in sorted(sessions_dir.iterdir()):
        if not sdir.is_dir():
            continue
        if args.session and sdir.name != args.session:
            continue
        rounds_dir = sdir / "rounds"
        if not rounds_dir.is_dir():
            continue
        for rdir in sorted(rounds_dir.iterdir()):
            if not rdir.is_dir():
                continue
            decision_path = rdir / "decision.json"
            if not decision_path.is_file():
                continue
            d = load_json(decision_path, {})
            if not isinstance(d, dict):
                continue
            entries.append({
                "at": str(d.get("updated_at") or ""),
                "session": sdir.name,
                "round": int(d.get("round") or 0),
                "worker": str(d.get("worker") or ""),
                "reviewer": str(d.get("reviewer") or ""),
                "decision": str(d.get("decision") or ""),
                "review_file": str(d.get("review_file") or ""),
            })
    entries.sort(key=lambda e: e["at"], reverse=True)
    limit = args.limit if args.limit and args.limit > 0 else 20
    entries = entries[:limit]
    if not entries:
        print("No completed rounds.")
        return 0
    print(f"{'time':<22} {'r':>3} {'worker':>7} {'reviewer':>8} {'decision':<14} review")
    for e in entries:
        print(f"{e['at']:<22} {e['round']:>3} {e['worker']:>7} {e['reviewer']:>8} {e['decision']:<14} {e['review_file']}")
    return 0


def _read_events(root: Path, limit: int) -> list[dict[str, Any]]:
    events_path = root / "events.jsonl"
    if not events_path.is_file():
        return []
    try:
        lines = events_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    if limit and limit > 0:
        lines = lines[-limit:]
    events: list[dict[str, Any]] = []
    for raw in lines:
        if not raw.strip():
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            events.append({"type": "invalid_json", "raw": raw})
            continue
        if isinstance(ev, dict):
            events.append(ev)
        else:
            events.append({"type": "invalid_event", "raw": raw})
    return events


def command_events(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    limit = args.limit if args.limit and args.limit > 0 else 50
    events = _read_events(root, limit)
    if getattr(args, "json_output", False):
        print(json.dumps({
            "version": 1,
            "cwd": cwd,
            "ccr_root": str(root),
            "limit": limit,
            "events": events,
        }, ensure_ascii=False, indent=2))
        return 0
    print("CCR Events")
    print(f"CCR root: {root}")
    print(f"Limit: {limit}")
    print()
    if not events:
        print("No events found.")
        return 0
    print(f"{'time':<22} {'type':<18} detail")
    for ev in events:
        when = str(ev.get("at") or "")
        etype = str(ev.get("type") or "")
        detail_parts = []
        for key in ["agent", "role", "session_id", "reason", "decision", "round", "path", "outcome"]:
            if key in ev and ev.get(key) not in ("", None):
                detail_parts.append(f"{key}={ev.get(key)}")
        if not detail_parts and "raw" in ev:
            detail_parts.append(f"raw={ev.get('raw')}")
        print(f"{when:<22} {etype:<18} {' '.join(detail_parts)}")
    return 0


def command_show(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    sessions_dir = root / "sessions"
    if not sessions_dir.is_dir():
        print("No sessions yet.", file=sys.stderr)
        return 1
    if args.session:
        sdir = sessions_dir / sanitize(args.session)
        if not sdir.is_dir():
            print(f"Session not found: {args.session}", file=sys.stderr)
            return 1
    else:
        candidates = [d for d in sessions_dir.iterdir() if d.is_dir() and (d / "rounds").is_dir()]
        if not candidates:
            print("No sessions with rounds.", file=sys.stderr)
            return 1
        sdir = max(candidates, key=lambda d: d.stat().st_mtime)
    rounds_dir = sdir / "rounds"
    rounds = sorted([d for d in rounds_dir.iterdir() if d.is_dir()])
    if not rounds:
        print(f"No rounds in {sdir}.", file=sys.stderr)
        return 1
    if args.round:
        rdir = rounds_dir / f"{int(args.round):04d}"
        if not rdir.is_dir():
            print(f"Round {args.round} not found in {sdir}.", file=sys.stderr)
            return 1
    else:
        rdir = rounds[-1]
    review_path = rdir / "review.md"
    request_path = rdir / "request.md"
    diff_path = rdir / "diff.patch"
    delta_path = rdir / "delta.patch"
    decision_path = rdir / "decision.json"
    if args.review:
        if not review_path.is_file():
            print(f"No review.md in {rdir}.", file=sys.stderr)
            return 1
        sys.stdout.write(review_path.read_text(encoding="utf-8"))
        return 0
    print(f"Session: {sdir.name}")
    print(f"Round dir: {rdir}")
    print(f"Request: {request_path if request_path.is_file() else '-'}")
    print(f"Diff: {diff_path if diff_path.is_file() else '-'}")
    if delta_path.is_file():
        print(f"Delta: {delta_path}")
    print(f"Review: {review_path if review_path.is_file() else '-'}")
    if decision_path.is_file():
        d = load_json(decision_path, {})
        if isinstance(d, dict):
            print(f"Decision: {d.get('decision','-')} (round {d.get('round','?')}) @ {d.get('updated_at','-')}")
    return 0


def command_skip_next() -> int:
    wid = workspace_id()
    if not wid:
        print("cmux workspace 안에서 실행해야 합니다.", file=sys.stderr)
        return 1
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    root.mkdir(parents=True, exist_ok=True)
    path = skip_marker_path(root)
    write_json(path, {
        "at": now(),
        "by_surface": surface_id(),
        "cwd": cwd,
    })
    cmux_status("CCR skip pending", "#8E8E93")
    cmux_log("progress", "skip-next marker set")
    print(f"다음 자동 리뷰 1회를 건너뜁니다. marker: {path}")
    return 0


def command_report(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    sid = args.session or _latest_session_id(root) or ""
    if not sid:
        print("No CCR sessions found for this cwd.", file=sys.stderr)
        return 1
    status_doc = load_json(root / "status.json", {})
    outcome = args.outcome
    if not outcome:
        if isinstance(status_doc, dict):
            outcome = str(status_doc.get("status") or "manual")
        else:
            outcome = "manual"
    report_path = generate_session_report(root, sid, outcome, trigger="manual")
    if report_path is None:
        print(f"Failed to generate report for session: {sid}", file=sys.stderr)
        return 1
    print(str(report_path))
    if getattr(args, "print_body", False):
        try:
            sys.stdout.write("\n")
            sys.stdout.write(Path(report_path).read_text(encoding="utf-8"))
        except OSError as exc:
            print(f"Failed to read report: {exc}", file=sys.stderr)
            return 1
    return 0


def _preview_data(cwd: str, root: Path) -> dict[str, Any]:
    state = load_json(root / "state.json", default_state())
    if not isinstance(state, dict):
        state = default_state()
    diff_text, diff_hash, head, has_content, changed_lines, files_touched = collect_diff(cwd)
    active = state.get("active_request")
    skip_path = skip_marker_path(root)

    blockers: list[str] = []
    notes: list[str] = []
    if not inside_git(cwd):
        blockers.append("current directory is not inside a git worktree")
    if not has_content:
        blockers.append("no reviewable git diff detected")
    if isinstance(active, dict):
        blockers.append(f"review already active: round {active.get('round', '?')} {active.get('worker', '?')}->{active.get('reviewer', '?')}")
    if MIN_DIFF_LINES > 0 and changed_lines < MIN_DIFF_LINES:
        blockers.append(f"diff has {changed_lines} changed lines (< CCR_MIN_DIFF_LINES={MIN_DIFF_LINES})")
    if diff_hash and diff_hash == state.get("last_diff_hash"):
        blockers.append("current diff hash matches the last reviewed diff")
    if skip_path.is_file():
        blockers.append("ccr-skip-next marker is pending; the next eligible automatic review will be skipped")
    if not workspace_enabled():
        notes.append("workspace is not enabled; run ccr-enable before relying on automatic review")
    if not surface_for_role("claude") or not surface_for_role("codex"):
        notes.append("both Claude and Codex surfaces should be registered for automatic handoff")

    eligible = has_content and not blockers
    return {
        "version": 1,
        "cwd": cwd,
        "ccr_root": str(root),
        "eligible": eligible,
        "head": head or "unknown",
        "diff_hash": diff_hash,
        "changed_lines": changed_lines,
        "files_touched": files_touched,
        "diff_payload_bytes": len(diff_text.encode("utf-8")),
        "max_diff_bytes": MAX_DIFF_BYTES,
        "min_diff_lines": MIN_DIFF_LINES,
        "active_request": active if isinstance(active, dict) else None,
        "skip_next": str(skip_path) if skip_path.is_file() else "",
        "blockers": blockers,
        "notes": notes,
    }


def command_preview(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    data = _preview_data(cwd, root)
    if getattr(args, "json_output", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0 if data["eligible"] else 1

    print("CCR Review Preview")
    print(f"Cwd: {cwd}")
    print(f"CCR root: {root}")
    print(f"Git HEAD: {data['head']}")
    print(f"Changed lines: {data['changed_lines']}")
    print(f"Files touched: {len(data['files_touched'])}")
    for fname in data["files_touched"][:20]:
        print(f"  - {fname}")
    if len(data["files_touched"]) > 20:
        print(f"  ... {len(data['files_touched']) - 20} more")
    print(f"Diff payload bytes: {data['diff_payload_bytes']} (limit {data['max_diff_bytes']})")
    print()
    print(f"Would auto-review now: {'yes' if data['eligible'] else 'no'}")
    if data["blockers"]:
        print("Blockers:")
        for blocker in data["blockers"]:
            print(f"- {blocker}")
    if data["notes"]:
        print("Notes:")
        for note in data["notes"]:
            print(f"- {note}")
    return 0 if data["eligible"] else 1


def _prune_candidates(root: Path, *, keep: int, days: int) -> list[dict[str, Any]]:
    now_ts = time.time()
    cutoff = now_ts - (days * 86400) if days and days > 0 else None
    candidates: list[dict[str, Any]] = []

    sessions_dir = root / "sessions"
    session_dirs = []
    if sessions_dir.is_dir():
        session_dirs = sorted(
            [d for d in sessions_dir.iterdir() if d.is_dir()],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    for idx, sdir in enumerate(session_dirs):
        age_days = max(0.0, (now_ts - sdir.stat().st_mtime) / 86400)
        reasons: list[str] = []
        if keep >= 0 and idx >= keep:
            reasons.append(f"beyond keep={keep}")
        if cutoff is not None and sdir.stat().st_mtime < cutoff:
            reasons.append(f"older than {days} days")
        if reasons:
            candidates.append({
                "type": "session",
                "path": str(sdir),
                "age_days": round(age_days, 2),
                "reasons": reasons,
            })

    support_dir = root / "support"
    support_files = []
    if support_dir.is_dir():
        support_files = sorted(
            [p for p in support_dir.iterdir() if p.is_file() and p.name.startswith("ccr-support-")],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    for idx, path in enumerate(support_files):
        age_days = max(0.0, (now_ts - path.stat().st_mtime) / 86400)
        reasons = []
        if keep >= 0 and idx >= keep:
            reasons.append(f"beyond keep={keep}")
        if cutoff is not None and path.stat().st_mtime < cutoff:
            reasons.append(f"older than {days} days")
        if reasons:
            candidates.append({
                "type": "support_bundle",
                "path": str(path),
                "age_days": round(age_days, 2),
                "reasons": reasons,
            })
    return candidates


def command_prune(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    keep = int(args.keep if args.keep is not None else 20)
    days = int(args.days if args.days is not None else 30)
    if keep < 0 and days <= 0:
        print("Refusing prune with no retention rule: use --keep N or --days N.", file=sys.stderr)
        return 2
    candidates = _prune_candidates(root, keep=keep, days=days)
    removed: list[str] = []
    if args.apply:
        for item in candidates:
            path = Path(str(item["path"]))
            if item["type"] == "session":
                shutil.rmtree(path, ignore_errors=True)
                removed.append(str(path))
            else:
                with contextlib.suppress(FileNotFoundError):
                    path.unlink()
                    removed.append(str(path))

    if getattr(args, "json_output", False):
        print(json.dumps({
            "version": 1,
            "cwd": cwd,
            "ccr_root": str(root),
            "mode": "apply" if args.apply else "dry-run",
            "keep": keep,
            "days": days,
            "candidates": candidates,
            "removed": removed,
        }, ensure_ascii=False, indent=2))
        return 0

    print("CCR Prune")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"CCR root: {root}")
    print(f"Retention: keep={keep}, days={days}")
    print()
    if not candidates:
        print("No sessions or support bundles match the retention rule.")
        return 0
    print("Candidates:")
    for item in candidates:
        print(f"- [{item['type']}] {item['path']} ({item['age_days']} days; {', '.join(item['reasons'])})")
    if args.apply:
        print()
        print(f"Removed: {len(removed)}")
    else:
        print()
        print("Dry run only. Add --apply to remove these paths.")
    return 0


def _config_doc(cwd: str) -> dict[str, Any]:
    root = root_for_cwd(cwd)
    values = {
        "CCR_MAX_ROUNDS": str(MAX_ROUNDS),
        "CCR_MAX_UNTRACKED_BYTES": str(MAX_UNTRACKED_BYTES),
        "CCR_MAX_DIFF_BYTES": str(MAX_DIFF_BYTES),
        "CCR_MIN_DIFF_LINES": str(MIN_DIFF_LINES),
        "CCR_STALE_ACTIVE_SECONDS": str(STALE_ACTIVE_SECONDS),
        "CCR_ROOT": str(root),
    }
    env: dict[str, dict[str, str]] = {}
    for key, value in values.items():
        env[key] = {
            "value": value,
            "source": "env" if key in os.environ else "default",
            "default": CCR_DEFAULTS.get(key, ""),
        }
    return {
        "version": 1,
        "cwd": cwd,
        "workspace_id": workspace_id() or "",
        "surface_id": surface_id() or "",
        "config_root": str(CONFIG_ROOT),
        "enabled_file": str(ENABLED_FILE),
        "ccr_root": str(root),
        "environment": env,
        "runtime_commands": RUNTIME_COMMANDS,
        "generated_commands": GENERATED_BIN_NAMES,
        "generated_claude_commands": GENERATED_CLAUDE_COMMAND_FILES,
        "excluded_paths": [
            ".cmux/ccr/",
            ".git/",
            ".env*",
            "node_modules/",
            "dist/",
            "build/",
            ".next/",
            ".venv/",
            "DerivedData/",
            ".open-research/logs/",
        ],
        "sensitive_suffixes": list(SENSITIVE_SUFFIXES),
        "sensitive_basenames": sorted(SENSITIVE_BASENAMES),
    }


def command_config(args: argparse.Namespace) -> int:
    doc = _config_doc(os.getcwd())
    if getattr(args, "json_output", False):
        print(json.dumps(doc, ensure_ascii=False, indent=2))
        return 0
    print("CCR Config")
    print(f"Cwd: {doc['cwd']}")
    print(f"CCR root: {doc['ccr_root']}")
    print(f"Config root: {doc['config_root']}")
    print(f"Workspace: {doc['workspace_id'] or '-'}")
    print(f"Surface: {doc['surface_id'] or '-'}")
    print()
    print("Environment:")
    for key, item in doc["environment"].items():
        print(f"- {key}={item['value']} ({item['source']}; default {item['default']})")
    print()
    print("Runtime commands:")
    for name in doc["runtime_commands"]:
        print(f"- {name}")
    print()
    print("Excluded paths:")
    for path in doc["excluded_paths"]:
        print(f"- {path}")
    return 0


def _doctor_doc_for_check() -> tuple[int, dict[str, Any]]:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        rc = command_doctor(argparse.Namespace(json_output=True))
    try:
        doc = json.loads(stdout.getvalue())
    except json.JSONDecodeError:
        doc = {"version": 1, "summary": {"fail": 1, "warn": 0, "ok": 0}, "actions": ["Run `ccr-doctor` for details."]}
        rc = 1
    return rc, doc


def _selftest_doc_for_check() -> tuple[int, dict[str, Any]]:
    results = [_run_selftest_case(name, fn) for name, fn in _selftest_cases()]
    failed = [result for result in results if result["status"] != "PASS"]
    return (0 if not failed else 1), {
        "version": 1,
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "results": results,
    }


def _check_doc(cwd: str) -> dict[str, Any]:
    root = root_for_cwd(cwd)
    doctor_rc, doctor_doc = _doctor_doc_for_check()
    selftest_rc, selftest_doc = _selftest_doc_for_check()
    ready_doc = {
        "version": 1,
        "ready": all(bool(check["ok"]) for check in _ready_checks(cwd, root)),
        "checks": _ready_checks(cwd, root),
    }
    ready_doc["actions"] = []
    seen: set[str] = set()
    for check in ready_doc["checks"]:
        action = str(check.get("action") or "")
        if action and action not in seen:
            seen.add(action)
            ready_doc["actions"].append(action)
    preview_doc = _preview_data(cwd, root)
    config_doc = _config_doc(cwd)

    actions: list[str] = []
    seen_actions: set[str] = set()

    def add_action(action: str) -> None:
        if action and action not in seen_actions:
            seen_actions.add(action)
            actions.append(action)

    if selftest_rc:
        add_action("Run `ccr-selftest` for failed runtime smoke-test details.")
    for action in doctor_doc.get("actions", []):
        add_action(str(action))
    if not ready_doc["ready"]:
        for action in ready_doc["actions"]:
            add_action(str(action))
    if not preview_doc["eligible"]:
        add_action("Run `ccr-preview` to inspect current diff review blockers.")

    return {
        "version": 1,
        "cwd": cwd,
        "ccr_root": str(root),
        "overall": "pass" if selftest_rc == 0 and doctor_rc == 0 and ready_doc["ready"] else "attention",
        "selftest": {"exit_code": selftest_rc, "passed": selftest_doc["passed"], "failed": selftest_doc["failed"]},
        "doctor": {"exit_code": doctor_rc, "summary": doctor_doc.get("summary", {})},
        "ready": {"ready": ready_doc["ready"], "failed": sum(1 for c in ready_doc["checks"] if not c["ok"])},
        "preview": {"eligible": preview_doc["eligible"], "blockers": preview_doc["blockers"], "changed_lines": preview_doc["changed_lines"]},
        "config": {"env_overrides": [k for k, v in config_doc["environment"].items() if v["source"] == "env"]},
        "actions": actions,
    }


def command_check(args: argparse.Namespace) -> int:
    doc = _check_doc(os.getcwd())
    if getattr(args, "json_output", False):
        print(json.dumps(doc, ensure_ascii=False, indent=2))
        return 0 if doc["overall"] == "pass" else 1
    print("CCR Check")
    print(f"Overall: {doc['overall']}")
    print(f"CCR root: {doc['ccr_root']}")
    print()
    print(f"Selftest: {doc['selftest']['passed']} passed, {doc['selftest']['failed']} failed")
    summary = doc["doctor"]["summary"]
    print(f"Doctor: {summary.get('fail', 0)} fail, {summary.get('warn', 0)} warn, {summary.get('ok', 0)} ok")
    print(f"Ready: {'yes' if doc['ready']['ready'] else 'no'} ({doc['ready']['failed']} blocker(s))")
    print(f"Preview: {'eligible' if doc['preview']['eligible'] else 'not eligible'} ({doc['preview']['changed_lines']} changed lines)")
    if doc["config"]["env_overrides"]:
        print(f"Env overrides: {', '.join(doc['config']['env_overrides'])}")
    else:
        print("Env overrides: none")
    if doc["actions"]:
        print()
        print("Next actions:")
        for idx, action in enumerate(doc["actions"], 1):
            print(f"{idx}. {action}")
    return 0 if doc["overall"] == "pass" else 1


def _json_file_contains(path: Path, needle: str) -> bool:
    try:
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return False
    return needle in json.dumps(parsed, ensure_ascii=False)


def _is_executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _doctor_next_message(fail_count: int, warn_count: int) -> str:
    if fail_count:
        return "rerun `bash ccr.sh`, then run `ccr-doctor` again."
    if warn_count:
        return "resolve warnings that match your intended workflow; many are expected outside cmux or before ccr-enable."
    return "run `ccr-status` or start work normally."


def _doctor_action_items(rows: list[dict[str, str]]) -> list[str]:
    actions: list[str] = []
    seen: set[str] = set()

    def add(action: str) -> None:
        if action not in seen:
            seen.add(action)
            actions.append(action)

    for row in rows:
        status = row.get("status", "")
        if status == "ok":
            continue
        name = row.get("name", "")
        detail = row.get("detail", "")
        if name.startswith("command: "):
            cmd = name.split(": ", 1)[1]
            add(f"Install or expose `{cmd}` in PATH, then rerun `ccr-doctor`.")
        elif name == "PATH":
            add("Run `source ~/.zshrc` or open a new shell so `~/.local/bin` is on PATH.")
        elif name in {"installed command files", "Claude hooks", "Codex hooks"}:
            add("Run `bash ccr.sh` from the CCR repository to reinstall generated commands and hooks.")
        elif name == "cmux surface":
            add("Open the target project in cmux and run CCR commands inside a cmux surface.")
        elif name == "registered current surface":
            add("Run `cmux-setup-claude` in the Claude surface or `cmux-setup-codex` in the Codex surface.")
        elif name == "registered Claude surface":
            add("Run `cmux-setup-claude` in the Claude terminal surface.")
        elif name == "registered Codex surface":
            add("Run `cmux-setup-codex` in the Codex terminal surface.")
        elif name == "workspace enabled":
            add("Run `ccr-enable` from the target repository directory.")
        elif name == "git repository":
            add("Change directory to the target git repository before running CCR commands.")
        elif name == "CCR runtime root":
            add("Run `ccr-enable` from the target repository directory to create local CCR state.")
        elif name == "active request":
            add("Run `ccr-status`; if the request is stale, run `ccr-cancel`.")
        elif name == "skip-next marker":
            add(f"The next eligible automatic review will be skipped; delete `{detail}` only if this was accidental.")
        else:
            add(f"Inspect `{name}`: {detail}")
    if not actions:
        actions.append("Run `ccr-status` or start work normally.")
    return actions


def command_doctor(args: argparse.Namespace) -> int:
    home = Path.home()
    bin_root = home / ".local" / "bin"
    claude_settings = home / ".claude" / "settings.json"
    codex_hooks = home / ".codex" / "hooks.json"
    cwd = os.getcwd()
    root = root_for_cwd(cwd)

    rows: list[dict[str, str]] = []

    def add(status: str, name: str, detail: str = "") -> None:
        rows.append({"status": status, "name": name, "detail": detail})

    def need_command(name: str) -> None:
        found = shutil.which(name)
        add("ok" if found else "fail", f"command: {name}", found or "not found in PATH")

    for name in ["python3", *RUNTIME_COMMANDS]:
        need_command(name)

    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    add(
        "ok" if str(bin_root) in path_entries else "warn",
        "PATH",
        f"{bin_root} {'is in PATH' if str(bin_root) in path_entries else 'is not in PATH for this shell'}",
    )

    missing_generated = [name for name in GENERATED_BIN_NAMES if not _is_executable(bin_root / name)]
    add(
        "ok" if not missing_generated else "fail",
        "installed command files",
        "all generated commands are executable" if not missing_generated else "missing/not executable: " + ", ".join(missing_generated),
    )

    claude_hook = str(bin_root / "ccr-hook-claude")
    codex_hook = str(bin_root / "ccr-hook-codex")
    claude_has_hook = _json_file_contains(claude_settings, claude_hook)
    codex_has_hook = _json_file_contains(codex_hooks, codex_hook)
    add(
        "ok" if claude_has_hook else "fail",
        "Claude hooks",
        f"{claude_settings} contains {claude_hook}" if claude_has_hook else (
            f"{claude_settings} missing CCR hook entry" if claude_settings.exists() else f"{claude_settings} not found"
        ),
    )
    add(
        "ok" if codex_has_hook else "fail",
        "Codex hooks",
        f"{codex_hooks} contains {codex_hook}" if codex_has_hook else (
            f"{codex_hooks} missing CCR hook entry" if codex_hooks.exists() else f"{codex_hooks} not found"
        ),
    )

    wid = workspace_id()
    sid = surface_id()
    add(
        "ok" if wid and sid else "warn",
        "cmux surface",
        f"workspace={wid} surface={sid}" if wid and sid else "not running inside a cmux surface",
    )

    role = role_for_current_surface()
    add(
        "ok" if role in {"claude", "codex"} else "warn",
        "registered current surface",
        role if role in {"claude", "codex"} else "run cmux-setup-claude or cmux-setup-codex in this surface",
    )

    claude_surface = surface_for_role("claude")
    codex_surface = surface_for_role("codex")
    add(
        "ok" if claude_surface else "warn",
        "registered Claude surface",
        claude_surface or "not registered",
    )
    add(
        "ok" if codex_surface else "warn",
        "registered Codex surface",
        codex_surface or "not registered",
    )

    add(
        "ok" if workspace_enabled() else "warn",
        "workspace enabled",
        "enabled" if workspace_enabled() else "run ccr-enable inside the target repo",
    )

    add(
        "ok" if inside_git(cwd) else "warn",
        "git repository",
        cwd if inside_git(cwd) else "current directory is not inside a git worktree",
    )

    status_doc = load_json(root / "status.json", {})
    state_doc = load_json(root / "state.json", {})
    if root.exists():
        reason = ""
        if isinstance(status_doc, dict):
            reason = str(status_doc.get("reason") or "")
        add("ok", "CCR runtime root", f"{root} ({reason or 'state exists'})")
    else:
        add("warn", "CCR runtime root", f"{root} not found; run ccr-enable")

    active = state_doc.get("active_request") if isinstance(state_doc, dict) else None
    if isinstance(active, dict):
        elapsed = ""
        created = active.get("created_at")
        if created:
            try:
                elapsed_secs = max(0, int(time.time() - calendar.timegm(time.strptime(str(created), "%Y-%m-%dT%H:%M:%SZ"))))
                elapsed = f", elapsed={_format_duration(elapsed_secs)}"
            except ValueError:
                elapsed = ""
        add(
            "warn",
            "active request",
            f"round {active.get('round','?')} {active.get('worker','?')}->{active.get('reviewer','?')}{elapsed}; use ccr-status or ccr-cancel if stale",
        )
    else:
        add("ok", "active request", "none")

    skip = skip_marker_path(root)
    add(
        "warn" if skip.is_file() else "ok",
        "skip-next marker",
        str(skip) if skip.is_file() else "none",
    )

    fail_count = sum(1 for row in rows if row["status"] == "fail")
    warn_count = sum(1 for row in rows if row["status"] == "warn")
    next_message = _doctor_next_message(fail_count, warn_count)
    actions = _doctor_action_items(rows)

    if getattr(args, "json_output", False):
        print(json.dumps({
            "version": 1,
            "cwd": cwd,
            "ccr_root": str(root),
            "summary": {
                "fail": fail_count,
                "warn": warn_count,
                "ok": sum(1 for row in rows if row["status"] == "ok"),
            },
            "checks": rows,
            "next": next_message,
            "actions": actions,
        }, ensure_ascii=False, indent=2))
        return 1 if fail_count else 0

    print("CCR Doctor")
    print(f"Cwd: {cwd}")
    print(f"CCR root: {root}")
    print()
    for row in rows:
        print(f"[{row['status'].upper():4}] {row['name']:<28} {row['detail']}")

    print()
    print(f"Summary: {fail_count} fail, {warn_count} warn")
    print(f"Next: {next_message}")
    print()
    print("Next actions:")
    for idx, action in enumerate(actions, 1):
        print(f"{idx}. {action}")
    return 1 if fail_count else 0


def command_support(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    root.mkdir(parents=True, exist_ok=True)
    support_dir = root / "support"
    support_dir.mkdir(parents=True, exist_ok=True)

    sid = args.session or _latest_session_id(root) or ""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    bundle_path = support_dir / f"ccr-support-{stamp}.zip"
    include_payloads = bool(getattr(args, "include_diffs", False))
    files_added: list[str] = []

    def add_text(zf: zipfile.ZipFile, arcname: str, text: str) -> None:
        zf.writestr(arcname, text)
        files_added.append(arcname)

    def add_file(zf: zipfile.ZipFile, path: Path, arcname: str) -> None:
        if not path.is_file():
            return
        try:
            zf.write(path, arcname)
            files_added.append(arcname)
        except OSError:
            return

    doctor_stdout = io.StringIO()
    with contextlib.redirect_stdout(doctor_stdout):
        doctor_rc = command_doctor(argparse.Namespace(json_output=True))

    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        add_text(zf, "doctor.json", doctor_stdout.getvalue())
        add_text(zf, "version.txt", read_text(CONFIG_ROOT / "VERSION") or "unknown\n")

        for name in ["status.json", "state.json"]:
            add_file(zf, root / name, name)

        events_path = root / "events.jsonl"
        if events_path.is_file():
            try:
                lines = events_path.read_text(encoding="utf-8", errors="replace").splitlines()
                add_text(zf, "events-tail.jsonl", "\n".join(lines[-200:]) + ("\n" if lines else ""))
            except OSError:
                pass

        if sid:
            sdir = session_dir(root, sid)
            add_file(zf, sdir / "session.json", f"sessions/{sid}/session.json")
            if include_payloads:
                add_file(zf, sdir / "report.md", f"sessions/{sid}/report.md")
            rounds_dir = sdir / "rounds"
            if rounds_dir.is_dir():
                for rdir in sorted(d for d in rounds_dir.iterdir() if d.is_dir()):
                    prefix = f"sessions/{sid}/rounds/{rdir.name}"
                    add_file(zf, rdir / "decision.json", f"{prefix}/decision.json")
                    if include_payloads:
                        for name in ["request.md", "diff.patch", "delta.patch", "worker-followup.md", "review.md"]:
                            add_file(zf, rdir / name, f"{prefix}/{name}")

        manifest = {
            "version": 1,
            "created_at": now(),
            "cwd": cwd,
            "ccr_root": str(root),
            "session": sid or None,
            "doctor_exit_code": doctor_rc,
            "include_payloads": include_payloads,
            "note": "Default bundles exclude request/review/diff payloads. Re-run with --include-diffs when sharing code payloads is acceptable.",
            "files": sorted(files_added + ["manifest.json"]),
        }
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    print(str(bundle_path))
    print("Created CCR support bundle.")
    if include_payloads:
        print("Included review request, review, and diff payload files.")
    else:
        print("Payload files excluded. Re-run with `ccr-support --include-diffs` only when sharing code/review content is acceptable.")
    if getattr(args, "print_body", False):
        print("Contents:")
        for name in sorted(files_added + ["manifest.json"]):
            print(f"  {name}")
    return 0


def _ready_checks(cwd: str, root: Path) -> list[dict[str, Any]]:
    home = Path.home()
    bin_root = home / ".local" / "bin"
    claude_settings = home / ".claude" / "settings.json"
    codex_hooks = home / ".codex" / "hooks.json"
    checks: list[dict[str, Any]] = []

    def add(ok: bool, name: str, detail: str, action: str) -> None:
        checks.append({
            "ok": ok,
            "name": name,
            "detail": detail,
            "action": "" if ok else action,
        })

    missing_runtime = [name for name in RUNTIME_COMMANDS if not shutil.which(name)]
    add(
        not missing_runtime,
        "runtime commands",
        "all runtime commands found" if not missing_runtime else "missing: " + ", ".join(missing_runtime),
        "Install missing runtime commands or expose them in PATH: " + ", ".join(missing_runtime),
    )

    missing_generated = [name for name in GENERATED_BIN_NAMES if not _is_executable(bin_root / name)]
    add(
        not missing_generated,
        "installed CCR commands",
        "all generated commands are executable" if not missing_generated else "missing/not executable: " + ", ".join(missing_generated),
        "Run `bash ccr.sh` from the CCR repository to reinstall generated commands.",
    )

    claude_hook = str(bin_root / "ccr-hook-claude")
    codex_hook = str(bin_root / "ccr-hook-codex")
    add(
        _json_file_contains(claude_settings, claude_hook),
        "Claude hook installed",
        f"{claude_settings} contains {claude_hook}" if _json_file_contains(claude_settings, claude_hook) else f"{claude_settings} missing CCR hook entry",
        "Run `bash ccr.sh` from the CCR repository to merge Claude hook entries.",
    )
    add(
        _json_file_contains(codex_hooks, codex_hook),
        "Codex hook installed",
        f"{codex_hooks} contains {codex_hook}" if _json_file_contains(codex_hooks, codex_hook) else f"{codex_hooks} missing CCR hook entry",
        "Run `bash ccr.sh` from the CCR repository to merge Codex hook entries.",
    )

    wid = workspace_id()
    sid = surface_id()
    add(
        bool(wid and sid),
        "inside cmux surface",
        f"workspace={wid} surface={sid}" if wid and sid else "not running inside a cmux surface",
        "Open the target project in cmux and run `ccr-ready` inside a Claude or Codex surface.",
    )

    role = role_for_current_surface()
    add(
        role in {"claude", "codex"},
        "current surface registered",
        role if role in {"claude", "codex"} else "current surface is not registered as Claude or Codex",
        "Run `cmux-setup-claude` in the Claude surface or `cmux-setup-codex` in the Codex surface.",
    )

    claude_surface = surface_for_role("claude")
    codex_surface = surface_for_role("codex")
    add(
        bool(claude_surface),
        "Claude surface registered",
        claude_surface or "not registered",
        "Run `cmux-setup-claude` in the Claude terminal surface.",
    )
    add(
        bool(codex_surface),
        "Codex surface registered",
        codex_surface or "not registered",
        "Run `cmux-setup-codex` in the Codex terminal surface.",
    )

    add(
        workspace_enabled(),
        "workspace enabled",
        "enabled" if workspace_enabled() else "not enabled for this cmux workspace",
        "Run `ccr-enable` from the target repository directory.",
    )
    add(
        inside_git(cwd),
        "git repository",
        cwd if inside_git(cwd) else "current directory is not inside a git worktree",
        "Change directory to the target git repository before running CCR commands.",
    )

    state_doc = load_json(root / "state.json", {})
    active = state_doc.get("active_request") if isinstance(state_doc, dict) else None
    add(
        not isinstance(active, dict),
        "no active review request",
        "none" if not isinstance(active, dict) else f"round {active.get('round','?')} {active.get('worker','?')}->{active.get('reviewer','?')}",
        "Wait for the reviewer to finish, or run `ccr-cancel` if the request is stale.",
    )
    return checks


def command_ready(args: argparse.Namespace) -> int:
    cwd = os.getcwd()
    root = root_for_cwd(cwd)
    checks = _ready_checks(cwd, root)
    ready = all(bool(check["ok"]) for check in checks)
    actions = []
    seen: set[str] = set()
    for check in checks:
        action = str(check.get("action") or "")
        if action and action not in seen:
            seen.add(action)
            actions.append(action)

    if getattr(args, "json_output", False):
        print(json.dumps({
            "version": 1,
            "ready": ready,
            "cwd": cwd,
            "ccr_root": str(root),
            "checks": checks,
            "actions": actions,
        }, ensure_ascii=False, indent=2))
        return 0 if ready else 1

    print("CCR Ready Check")
    print(f"Cwd: {cwd}")
    print(f"CCR root: {root}")
    print()
    for check in checks:
        status = "OK" if check["ok"] else "FAIL"
        print(f"[{status:<4}] {check['name']:<28} {check['detail']}")
    print()
    if ready:
        print("Ready: yes")
        print("Next: start work normally; the next mutating worker turn can trigger CCR review.")
        return 0
    print("Ready: no")
    print("Next actions:")
    for idx, action in enumerate(actions, 1):
        print(f"{idx}. {action}")
    return 1


def _run_selftest_case(name: str, fn) -> dict[str, str]:
    try:
        fn()
        return {"name": name, "status": "PASS", "detail": ""}
    except Exception as exc:
        return {"name": name, "status": "FAIL", "detail": str(exc)}


def _selftest_cases() -> list[tuple[str, Any]]:
    def decision_parser() -> None:
        assert parse_decision("REVIEW_DECISION: PASS\nrest") == "PASS"
        assert parse_decision("preamble\nREVIEW_DECISION: NEEDS_CHANGES") == "NEEDS_CHANGES"
        assert parse_decision("REVIEW_DECISION:   NEEDS_HUMAN  ") == "NEEDS_HUMAN"
        fenced = "```\nREVIEW_DECISION: PASS\n```\nREVIEW_DECISION: NEEDS_CHANGES\n"
        assert parse_decision(fenced) == "NEEDS_CHANGES"
        quoted = "> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n"
        assert parse_decision(quoted) == "NEEDS_HUMAN"

    def dirty_filter() -> None:
        assert should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "ccr-status"}}) is False
        assert should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "pytest"}}) is False
        assert should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "printf x > app.py"}}) is True
        assert should_mark_dirty_for_tool({"tool_name": "apply_patch"}) is True

    def handoff_and_prompt() -> None:
        assert is_ccr_handoff_prompt("[ccr-handoff]\n자동 리뷰 요청입니다") is True
        assert is_ccr_handoff_prompt("normal user prompt") is False
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            state = {
                "review_count": 1,
                "last_diff_hash": "hash-before",
                "active_request": {"round": 1, "worker": "claude", "reviewer": "codex"},
            }
            handle_user_prompt_submit(root, state, {"session_id": "sid", "prompt": "new user work"}, "claude", "claude")
            assert state["review_count"] == 1
            assert state["last_diff_hash"] == "hash-before"
            assert isinstance(state.get("active_request"), dict)

    def truncation_and_diff() -> None:
        many = ("+" + ("A" * 200) + "\n") * 50
        out = _truncate_sections([
            ("# Git HEAD", "abc"),
            ("# Staged Diff", many),
            ("# Unstaged Diff", many),
            ("# Untracked Files", many),
        ], max_bytes=500)
        assert len(out.encode("utf-8")) <= 500
        assert count_changed_lines("--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other") == 2

    def doctor_ready_support_json() -> None:
        doctor_stdout = io.StringIO()
        with contextlib.redirect_stdout(doctor_stdout):
            doctor_rc = command_doctor(argparse.Namespace(json_output=True))
        doctor_doc = json.loads(doctor_stdout.getvalue())
        assert doctor_rc in {0, 1}
        assert doctor_doc["version"] == 1
        assert isinstance(doctor_doc.get("checks"), list) and doctor_doc["checks"]

        ready_stdout = io.StringIO()
        with contextlib.redirect_stdout(ready_stdout):
            ready_rc = command_ready(argparse.Namespace(json_output=True))
        ready_doc = json.loads(ready_stdout.getvalue())
        assert ready_rc in {0, 1}
        assert ready_doc["version"] == 1
        assert isinstance(ready_doc.get("ready"), bool)
        assert isinstance(ready_doc.get("checks"), list) and ready_doc["checks"]

        with tempfile.TemporaryDirectory() as td:
            old_cwd = os.getcwd()
            try:
                os.chdir(td)
                support_stdout = io.StringIO()
                with contextlib.redirect_stdout(support_stdout):
                    support_rc = command_support(argparse.Namespace(session="", include_diffs=False, print_body=False))
                bundle = Path(support_stdout.getvalue().splitlines()[0])
                assert support_rc == 0 and bundle.is_file()
                with zipfile.ZipFile(bundle) as zf:
                    names = set(zf.namelist())
                    assert "manifest.json" in names and "doctor.json" in names
                    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                    assert manifest["include_payloads"] is False
            finally:
                os.chdir(old_cwd)

    def review_preview() -> None:
        with tempfile.TemporaryDirectory() as td:
            old_cwd = os.getcwd()
            try:
                os.chdir(td)
                os.system("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i >/dev/null 2>&1")
                root = root_for_cwd(td)
                preview_empty = _preview_data(td, root)
                assert preview_empty["eligible"] is False
                assert "no reviewable git diff detected" in preview_empty["blockers"]
                Path(td, "x.txt").write_text("hello\n", encoding="utf-8")
                preview = _preview_data(td, root)
                assert preview["eligible"] is True
                assert preview["changed_lines"] >= 1
                assert preview["files_touched"] == ["x.txt"]
                skip_marker_path(root).parent.mkdir(parents=True, exist_ok=True)
                write_json(skip_marker_path(root), {"at": now()})
                preview_skip = _preview_data(td, root)
                assert preview_skip["eligible"] is False
                assert any("ccr-skip-next" in blocker for blocker in preview_skip["blockers"])
            finally:
                os.chdir(old_cwd)

    def retention_prune() -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            sessions = root / "sessions"
            support = root / "support"
            sessions.mkdir(parents=True)
            support.mkdir(parents=True)
            for idx in range(3):
                sdir = sessions / f"s{idx}"
                sdir.mkdir()
                ts = time.time() - (idx * 86400)
                os.utime(sdir, (ts, ts))
            bundle = support / "ccr-support-old.zip"
            bundle.write_text("zip-ish", encoding="utf-8")
            old_ts = time.time() - (40 * 86400)
            os.utime(bundle, (old_ts, old_ts))
            candidates = _prune_candidates(root, keep=1, days=30)
            paths = {Path(item["path"]).name for item in candidates}
            assert "s1" in paths and "s2" in paths
            assert "ccr-support-old.zip" in paths

    def effective_config() -> None:
        doc = _config_doc(os.getcwd())
        assert doc["version"] == 1
        assert doc["environment"]["CCR_MAX_ROUNDS"]["value"] == str(MAX_ROUNDS)
        assert doc["environment"]["CCR_MAX_DIFF_BYTES"]["value"] == str(MAX_DIFF_BYTES)
        assert ".cmux/ccr/" in doc["excluded_paths"]
        assert "ccr-config" in doc["generated_commands"]
        assert "ccr-check" in doc["generated_commands"]

    def event_log_viewer() -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            root.mkdir()
            append_jsonl(root / "events.jsonl", {"at": "2026-01-01T00:00:00Z", "type": "dirty", "session_id": "s1"})
            append_jsonl(root / "events.jsonl", {"at": "2026-01-01T00:01:00Z", "type": "skipped", "reason": "test"})
            events = _read_events(root, 1)
            assert len(events) == 1
            assert events[0]["type"] == "skipped"
            (root / "events.jsonl").write_text("{bad-json\n", encoding="utf-8")
            invalid = _read_events(root, 10)
            assert invalid and invalid[0]["type"] == "invalid_json"

    def intent_extraction() -> None:
        # Single-line form, all three keys.
        msg = (
            "Here's a summary.\n\n"
            "PURPOSE: Refactor the auth middleware so token rotation does not lose existing sessions.\n"
            "NON_GOAL: rewriting the legacy /v1/logout endpoint\n"
            "INVARIANT: existing JWT cookies stay valid until natural expiry\n"
            "Applied:\n- ...\n"
        )
        parsed = extract_intent_from_message(msg)
        assert "token rotation" in parsed["purpose"], parsed
        assert "legacy" in parsed["non_goal"], parsed
        assert "JWT cookies" in parsed["invariant"], parsed

        # Multi-line form with markdown bold and dash bullets.
        msg2 = (
            "- **Purpose**: keep the queue worker idempotent\n"
            "  even when redelivery happens within 30s\n"
            "- **Non-goal**: changing the retry backoff\n"
            "- **Invariant**: at-most-once side-effects per message_id\n"
        )
        parsed2 = extract_intent_from_message(msg2)
        assert "idempotent" in parsed2["purpose"], parsed2
        assert "redelivery" in parsed2["purpose"], parsed2
        assert "backoff" in parsed2["non_goal"], parsed2
        assert "at-most-once" in parsed2["invariant"], parsed2

        # Missing fields stay empty.
        parsed3 = extract_intent_from_message("PURPOSE: only purpose given\n")
        assert parsed3["purpose"] == "only purpose given"
        assert parsed3["non_goal"] == ""
        assert parsed3["invariant"] == ""

        # No intent at all → all empty, no crash.
        assert extract_intent_from_message("just a normal commit message") == {
            "purpose": "", "non_goal": "", "invariant": "",
        }

        # File-based intent.md wins over fallback message.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            sid = "sid-intent"
            session_dir(root, sid).mkdir(parents=True)
            session_intent_path(root, sid).write_text(
                "PURPOSE: from file\nNON_GOAL: also from file\nINVARIANT: must hold\n",
                encoding="utf-8",
            )
            picked = load_session_intent(root, sid, "PURPOSE: from message\n")
            assert picked["purpose"] == "from file", picked
            assert picked["non_goal"] == "also from file", picked

            # No file → fall back to message extraction.
            sid2 = "sid-msg"
            session_dir(root, sid2).mkdir(parents=True)
            picked2 = load_session_intent(root, sid2, "PURPOSE: from message only\n")
            assert picked2["purpose"] == "from message only", picked2

        # render_intent_section omits when fully empty, renders when any field set.
        assert render_intent_section({"purpose": "", "non_goal": "", "invariant": ""}) == []
        rendered = render_intent_section({"purpose": "p", "non_goal": "", "invariant": "i"})
        joined = "\n".join(rendered)
        assert "## Purpose / Non-goal / Invariant" in joined
        assert "**Purpose**: p" in joined
        assert "**Non-goal**: _(missing)_" in joined
        assert "**Invariant**: i" in joined

    def handoff_detection_and_dirty_clear() -> None:
        # Sentinel-prefixed prompts are recognized.
        assert is_ccr_handoff_prompt("[ccr-handoff]\nanything") is True
        # First-line CCR header is also recognized even without the sentinel.
        assert is_ccr_handoff_prompt("CCR review: NEEDS_CHANGES (round 2, 1 must-fix). …") is True
        assert is_ccr_handoff_prompt("CCR review result: PASS …") is True
        assert is_ccr_handoff_prompt("CCR automatic review request. Read the request file …") is True
        assert is_ccr_handoff_prompt("CCR manual review request. Read request.md …") is True
        # Plain prompts are not.
        assert is_ccr_handoff_prompt("please review the auth module") is False
        assert is_ccr_handoff_prompt("the CCR review went well yesterday") is False
        # Header must be on the first line, not buried inside.
        assert is_ccr_handoff_prompt("hello\nCCR review: PASS") is False

        # handle_user_prompt_submit clears the receiver's dirty marker on handoff.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            sid = "sid-receiver"
            root.mkdir(parents=True)
            mark_dirty(root, {"session_id": sid}, "claude", "claude")
            assert has_dirty(root, sid) is True
            state: dict[str, Any] = {}
            handle_user_prompt_submit(
                root, state,
                {"session_id": sid, "prompt": "CCR review: NEEDS_CHANGES (round 1, 2 must-fix). …"},
                "claude", "claude",
            )
            assert has_dirty(root, sid) is False, "handoff should clear receiver dirty"

    def stale_active_reaper() -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "ccr"
            root.mkdir(parents=True)

            # Age-based reaping fires ONLY on SessionStart (a fresh session),
            # never on routine mid-session events — so a slow/large review in
            # flight is not cancelled by the worker's own activity.
            old_active = {
                "round": 1,
                "worker": "claude",
                "reviewer": "codex",
                "worker_session_id": "sid-A",
                "created_at": "2000-01-01T00:00:00Z",
            }
            # Mid-session event with an ancient request must NOT reap.
            keep_old: dict[str, Any] = {"active_request": dict(old_active)}
            assert reap_stale_active(root, keep_old, "UserPromptSubmit", {"session_id": "sid-A"}, "claude") is False, "age reap must not fire on UserPromptSubmit"
            assert isinstance(keep_old["active_request"], dict)
            # The same ancient request IS reaped on SessionStart.
            old_state: dict[str, Any] = {"active_request": dict(old_active)}
            cleared = reap_stale_active(root, old_state, "SessionStart", {"session_id": "sid-A"}, "claude")
            assert cleared is True
            assert old_state["active_request"] is None
            events = _read_events(root, 5)
            assert events and events[0]["type"] == "stale_active_discarded"
            assert events[0].get("trigger_event") == "SessionStart"

            # Session-mismatch: a fresh worker session_id orphans the active
            # even when the age is below the threshold.
            (root / "events.jsonl").unlink(missing_ok=True)
            from datetime import datetime, timezone
            fresh = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            mismatch_state: dict[str, Any] = {
                "active_request": {
                    "round": 1,
                    "worker": "claude",
                    "reviewer": "codex",
                    "worker_session_id": "sid-OLD",
                    "created_at": fresh,
                },
            }
            cleared = reap_stale_active(root, mismatch_state, "SessionStart", {"session_id": "sid-NEW"}, "claude")
            assert cleared is True
            assert mismatch_state["active_request"] is None

            # Negative: a recent, same-session active must be left alone.
            (root / "events.jsonl").unlink(missing_ok=True)
            keep_state: dict[str, Any] = {
                "active_request": {
                    "round": 1,
                    "worker": "claude",
                    "reviewer": "codex",
                    "worker_session_id": "sid-A",
                    "created_at": fresh,
                },
            }
            cleared = reap_stale_active(root, keep_state, "UserPromptSubmit", {"session_id": "sid-A"}, "claude")
            assert cleared is False
            assert isinstance(keep_state["active_request"], dict)

            # Regression (reviewer handoff): a reviewer-side UserPromptSubmit
            # whose session_id differs from the worker's MUST NOT reap — the
            # reviewer is mid-review and finish_review must still finalize it.
            (root / "events.jsonl").unlink(missing_ok=True)
            reviewer_state: dict[str, Any] = {
                "active_request": {
                    "round": 1,
                    "worker": "claude",
                    "reviewer": "codex",
                    "worker_session_id": "sid-WORKER",
                    "created_at": fresh,
                },
            }
            assert reap_stale_active(root, reviewer_state, "UserPromptSubmit", {"session_id": "sid-REVIEWER"}, "codex") is False, "reviewer UserPromptSubmit must not reap"
            assert isinstance(reviewer_state["active_request"], dict)
            # Reviewer restart (SessionStart) must also preserve the request.
            assert reap_stale_active(root, reviewer_state, "SessionStart", {"session_id": "sid-REVIEWER"}, "codex") is False, "reviewer SessionStart must not reap"
            assert isinstance(reviewer_state["active_request"], dict)

            # Regression (manual request): a synthetic worker_session_id never
            # matches a live session; the worker's next UserPromptSubmit (real
            # session_id) must NOT reap the pending manual request.
            manual_state: dict[str, Any] = {
                "active_request": {
                    "round": 1,
                    "worker": "claude",
                    "reviewer": "codex",
                    "worker_session_id": "manual-123-claude",
                    "manual": True,
                    "created_at": fresh,
                },
            }
            assert reap_stale_active(root, manual_state, "UserPromptSubmit", {"session_id": "real-sid"}, "claude") is False, "manual/worker UserPromptSubmit mismatch must not reap"
            assert isinstance(manual_state["active_request"], dict)

            # Negative: no active_request → no-op, no event logged.
            empty_state: dict[str, Any] = {}
            assert reap_stale_active(root, empty_state, "UserPromptSubmit", {"session_id": "sid"}, "claude") is False
            assert empty_state == {}

    return [
        ("decision parser", decision_parser),
        ("dirty filter", dirty_filter),
        ("handoff and prompt reset safety", handoff_and_prompt),
        ("diff truncation helpers", truncation_and_diff),
        ("doctor/ready/support JSON smoke", doctor_ready_support_json),
        ("review preview", review_preview),
        ("retention prune", retention_prune),
        ("effective config", effective_config),
        ("event log viewer", event_log_viewer),
        ("intent extraction", intent_extraction),
        ("handoff detection and dirty clear", handoff_detection_and_dirty_clear),
        ("stale active reaper", stale_active_reaper),
    ]


def command_selftest(args: argparse.Namespace) -> int:
    results = [_run_selftest_case(name, fn) for name, fn in _selftest_cases()]
    passed = sum(1 for result in results if result["status"] == "PASS")
    failed = [result for result in results if result["status"] != "PASS"]
    if getattr(args, "json_output", False):
        print(json.dumps({
            "version": 1,
            "passed": passed,
            "failed": len(failed),
            "results": results,
        }, ensure_ascii=False, indent=2))
        return 0 if not failed else 1
    print("CCR Self-Test")
    for result in results:
        detail = f" {result['detail']}" if result["detail"] else ""
        print(f"[{result['status']:<4}] {result['name']}{detail}")
    print()
    print(f"Summary: {passed} passed, {len(failed)} failed")
    return 0 if not failed else 1


def command_uninstall(args: argparse.Namespace) -> int:
    home = Path.home()
    bin_root = home / ".local" / "bin"
    cmd_root = home / ".claude" / "commands"
    settings = home / ".claude" / "settings.json"
    codex_hooks = home / ".codex" / "hooks.json"
    targets_bin = [bin_root / f for f in GENERATED_BIN_NAMES if (bin_root / f).exists()]
    targets_cmd = [cmd_root / f for f in GENERATED_CLAUDE_COMMAND_FILES if (cmd_root / f).exists()]
    purge_dirs: list[Path] = []
    if args.purge:
        for d in [CONFIG_ROOT, Path.home() / ".local" / "state" / "claude-codex-review"]:
            if d.exists():
                purge_dirs.append(d)

    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print("Files to remove:")
    for p in targets_bin + targets_cmd:
        print(f"  {p}")
    if purge_dirs:
        print("Directories to remove (--purge):")
        for d in purge_dirs:
            print(f"  {d}")
    print("Hook entries to strip from:")
    for p in [settings, codex_hooks]:
        if p.exists():
            print(f"  {p}")
    print("Note: ~/.zshrc PATH line is left untouched.")

    if not args.apply:
        print("\nDry run only. Add --apply to perform removal.")
        return 0

    ccr_bins = {
        str(home / ".local" / "bin" / "ccr-hook-claude"),
        str(home / ".local" / "bin" / "ccr-hook-codex"),
    }

    def _is_ccr_hook_group(g: Any) -> bool:
        if not isinstance(g, dict):
            return False
        hooks_list = g.get("hooks")
        if not isinstance(hooks_list, list):
            return False
        for h in hooks_list:
            if not isinstance(h, dict):
                continue
            cmd = str(h.get("command") or "")
            tokens = cmd.split()
            if tokens and tokens[0] in ccr_bins:
                return True
        return False

    for path in [settings, codex_hooks]:
        if not path.exists():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        hooks = doc.get("hooks") if isinstance(doc, dict) else None
        if not isinstance(hooks, dict):
            continue
        changed = False
        for event in list(hooks.keys()):
            groups = hooks.get(event)
            if not isinstance(groups, list):
                continue
            filtered = []
            for g in groups:
                if _is_ccr_hook_group(g):
                    changed = True
                    continue
                filtered.append(g)
            hooks[event] = filtered
        if changed:
            path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for p in targets_bin + targets_cmd:
        with contextlib.suppress(FileNotFoundError):
            p.unlink()
    for d in purge_dirs:
        shutil.rmtree(d, ignore_errors=True)

    print("Removed.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", choices=["claude", "codex"])
    parser.add_argument("--event")
    parser.add_argument("--command", choices=[
        "enable", "disable", "reset", "status", "request",
        "cancel", "history", "show", "uninstall", "skip-next",
        "report", "doctor", "support", "ready", "selftest", "preview", "prune", "config", "events", "check",
    ])
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
    parser.add_argument("--purpose", help="One-line purpose for this review (PNI block)")
    parser.add_argument("--non-goal", dest="non_goal", help="What is deliberately out of scope (PNI block)")
    parser.add_argument("--invariant", help="A must-not-break property for this review (PNI block)")
    parser.add_argument("--use-diff", action="store_true")
    parser.add_argument("--no-diff", action="store_false", dest="use_diff")
    parser.set_defaults(use_diff=False)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--session")
    parser.add_argument("--round", type=int)
    parser.add_argument("--review", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--purge", action="store_true")
    parser.add_argument("--outcome")
    parser.add_argument("--print", action="store_true", dest="print_body")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--include-diffs", action="store_true", dest="include_diffs")
    parser.add_argument("--keep", type=int)
    parser.add_argument("--days", type=int)
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
    if args.command == "cancel":
        return command_cancel()
    if args.command == "history":
        return command_history(args)
    if args.command == "events":
        return command_events(args)
    if args.command == "show":
        return command_show(args)
    if args.command == "uninstall":
        return command_uninstall(args)
    if args.command == "skip-next":
        return command_skip_next()
    if args.command == "report":
        return command_report(args)
    if args.command == "doctor":
        return command_doctor(args)
    if args.command == "support":
        return command_support(args)
    if args.command == "ready":
        return command_ready(args)
    if args.command == "selftest":
        return command_selftest(args)
    if args.command == "preview":
        return command_preview(args)
    if args.command == "prune":
        return command_prune(args)
    if args.command == "config":
        return command_config(args)
    if args.command == "check":
        return command_check(args)

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
