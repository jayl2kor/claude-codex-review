#!/usr/bin/env python3
"""Golden probe for the CCR Python runtime.

Phase-0 regression net: this helper importlib-loads the CURRENT Python runtime
at templates/bin/ccr-hook.py (NOT an installed ~/.local/bin copy) and exposes a
tiny JSON-in / JSON-out CLI so a Bun/TypeScript test harness can pin the exact
behavior of the stdlib-only pure functions. When ccr-hook.py is later ported to
Bun, the port can be proven equivalent against the same golden values.

Usage:
    python3 golden-probe.py <function_name> '<json-args-array>'
        -> prints {"ok": true, "result": <value>} on stdout

    python3 golden-probe.py --emit-golden
        -> prints the full golden snapshot object (the committed
           test/golden/functions.json) on stdout

Only Python stdlib is used. No third-party imports.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

# Loading ccr-hook.py would otherwise write __pycache__/*.pyc into templates/bin
# and pollute the working tree. Suppress bytecode generation before any import.
sys.dont_write_bytecode = True

# Resolve templates/bin/ccr-hook.py relative to THIS file so the probe works
# regardless of cwd. test/golden-probe.py -> ../templates/bin/ccr-hook.py
_THIS = Path(__file__).resolve()
_REPO_ROOT = _THIS.parent.parent
_RUNTIME = _REPO_ROOT / "templates" / "bin" / "ccr-hook.py"


def _load_runtime():
    if not _RUNTIME.is_file():
        raise SystemExit(f"runtime not found: {_RUNTIME}")
    spec = importlib.util.spec_from_file_location("ccr_hook_probe", str(_RUNTIME))
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load runtime spec from {_RUNTIME}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Allowlist of pure functions the probe is allowed to call. Each is invoked
# generically as `getattr(mod, name)(*args)` so a TypeScript differential test
# can use this Python runtime as an oracle for ALL of these stdlib-only pure
# functions. They are deterministic and side-effect free (no filesystem, no
# git, no network, no env-dependent behavior). Tuple results serialize as JSON
# arrays via json.dumps, matching what a TS port would produce.
ALLOWED_FUNCTIONS = frozenset(
    {
        "sanitize",
        "opposite",
        "_join_sections",
        "_truncate_sections",
        "_truncate_text",
        "_fenced_markdown_block",
        "_format_duration",
        "_diff_has_content",
        "count_changed_lines",
        "_files_touched_from_diff_text",
        "safe_rel_path",
        "diff_pathspecs",
        "parse_decision",
        "_is_sentinel_must_fix",
        "_count_must_fix_in_text",
        "extract_intent_from_message",
        "render_intent_section",
        "is_ccr_handoff_prompt",
        "tool_name",
        "tool_command",
        "bash_looks_mutating",
        "should_mark_dirty_for_tool",
        "default_state",
        "reviewer_block_response",
        "_doctor_next_message",
        "_doctor_action_items",
        # Phase 2b: pure markdown builders. These accept Path-typed parameters
        # in the runtime but only ever str()-interpolate them, so they are
        # deterministic and side-effect free — the probe passes plain strings.
        "request_markdown",
        "scope_request_markdown",
    }
)


def _call(mod, name: str, args: list):
    if name not in ALLOWED_FUNCTIONS:
        raise SystemExit(f"unsupported function: {name}")
    fn = getattr(mod, name, None)
    if fn is None or not callable(fn):
        raise SystemExit(f"runtime is missing callable: {name}")
    return fn(*args)


# The deterministic golden cases. Each is (function, [args], expected).
# Values are taken from selftest-install.py semantics and the runtime source.
GOLDEN_CASES = [
    # parse_decision
    ["parse_decision", ["REVIEW_DECISION: PASS\nrest"], "PASS"],
    ["parse_decision", ["preamble\nREVIEW_DECISION: NEEDS_CHANGES"], "NEEDS_CHANGES"],
    ["parse_decision", ["REVIEW_DECISION: pass"], "PASS"],
    ["parse_decision", ["REVIEW_DECISION:   NEEDS_HUMAN  "], "NEEDS_HUMAN"],
    ["parse_decision", ["no decision here"], "INVALID"],
    [
        "parse_decision",
        [
            "Example format:\n```\nREVIEW_DECISION: PASS\n```\n"
            "Actual verdict:\nREVIEW_DECISION: NEEDS_CHANGES\n"
        ],
        "NEEDS_CHANGES",
    ],
    [
        "parse_decision",
        ["> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n"],
        "NEEDS_HUMAN",
    ],
    # count_changed_lines
    ["count_changed_lines", ["--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other"], 2],
    # _count_must_fix_in_text
    ["_count_must_fix_in_text", ["## Must Fix\n- None.\n\n## Looks Good\n- ok\n"], 0],
    ["_count_must_fix_in_text", ["## Must Fix\n- N/A\n- -\n- (none)\n- 없음\n"], 0],
    ["_count_must_fix_in_text", ["## Must Fix\n- a real one\n- another\n"], 2],
    ["_count_must_fix_in_text", ["## Must Fix\n- None.\n- a real one\n"], 1],
    # is_ccr_handoff_prompt
    ["is_ccr_handoff_prompt", ["[ccr-handoff]\n..."], True],
    ["is_ccr_handoff_prompt", ["[ccr-handoff]\n자동 리뷰 요청입니다"], True],
    ["is_ccr_handoff_prompt", ["please [ccr-handoff] later"], False],
    ["is_ccr_handoff_prompt", ["normal"], False],
    ["is_ccr_handoff_prompt", [""], False],
    # should_mark_dirty_for_tool
    ["should_mark_dirty_for_tool", [{"tool_name": "apply_patch"}], True],
    ["should_mark_dirty_for_tool", [{"tool_name": "Edit"}], True],
    ["should_mark_dirty_for_tool", [{"tool_name": "Write"}], True],
    ["should_mark_dirty_for_tool", [{"tool_name": "MultiEdit"}], True],
    [
        "should_mark_dirty_for_tool",
        [{"tool_name": "Bash", "tool_input": {"command": "pytest"}}],
        False,
    ],
    [
        "should_mark_dirty_for_tool",
        [{"tool_name": "Bash", "tool_input": {"command": "ccr-reset"}}],
        False,
    ],
    [
        "should_mark_dirty_for_tool",
        [{"tool_name": "Bash", "tool_input": {"command": "ccr-status"}}],
        False,
    ],
    [
        "should_mark_dirty_for_tool",
        [{"tool_name": "Bash", "tool_input": {"command": "printf x > app.py"}}],
        True,
    ],
    [
        "should_mark_dirty_for_tool",
        [{"tool_name": "Bash", "tool_input": {"command": "rm -rf build"}}],
        True,
    ],
]


def _emit_golden(mod) -> dict:
    cases = []
    for fn, args, expected in GOLDEN_CASES:
        actual = _call(mod, fn, args)
        cases.append(
            {
                "fn": fn,
                "args": args,
                "expected": expected,
                "actual": actual,
            }
        )
    return {
        "version": 1,
        "source": "templates/bin/ccr-hook.py",
        "note": (
            "Golden snapshot of CCR pure-function behavior. Regenerate with "
            "`python3 test/golden-probe.py --emit-golden`."
        ),
        "cases": cases,
    }


def main(argv: list[str]) -> int:
    mod = _load_runtime()
    if len(argv) >= 1 and argv[0] == "--emit-golden":
        sys.stdout.write(json.dumps(_emit_golden(mod), ensure_ascii=False, indent=2) + "\n")
        return 0
    if len(argv) < 2:
        sys.stderr.write(
            "usage: golden-probe.py <function_name> '<json-args-array>'\n"
            "       golden-probe.py --emit-golden\n"
        )
        return 2
    name = argv[0]
    try:
        args = json.loads(argv[1])
    except json.JSONDecodeError as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"bad json args: {exc}"}) + "\n")
        return 1
    if not isinstance(args, list):
        sys.stdout.write(json.dumps({"ok": False, "error": "args must be a JSON array"}) + "\n")
        return 1
    try:
        result = _call(mod, name, args)
    except SystemExit as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
        return 1
    sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
