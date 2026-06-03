#!/usr/bin/env python3
"""Stateful oracle probe for Phase 3 (I/O + lock + git) of the CCR migration.

Like test/golden-probe.py, this importlib-loads the CURRENT Python runtime at
templates/bin/ccr-hook.py (the single source of truth) WITHOUT modifying it, and
drives its side-effecting functions against caller-provided temp paths so the
Bun/TypeScript port can be proven byte-equivalent (state/status/dirty/session
JSON, events.jsonl) and behaviorally identical (collect_diff tuple incl. its
sha256 diff_hash).

Usage:
    phase3-probe.py now
    phase3-probe.py write-json   <path> <json>
    phase3-probe.py append-jsonl <path> <json>
    phase3-probe.py locked-state-set <root> <patch-json>
    phase3-probe.py write-status <root> <state-json> <status> <reason>
    phase3-probe.py mark-dirty   <root> <input-json> <agent> <role>
    phase3-probe.py ensure-session <root> <input-json> <agent> <role>
    phase3-probe.py collect-diff <cwd>

Only Python stdlib is used. Bytecode generation is suppressed so importing the
runtime never drops __pycache__ next to ccr-hook.py.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

_THIS = Path(__file__).resolve()
_RUNTIME = _THIS.parent.parent / "templates" / "bin" / "ccr-hook.py"


def _load_runtime():
    if not _RUNTIME.is_file():
        raise SystemExit(f"runtime not found: {_RUNTIME}")
    spec = importlib.util.spec_from_file_location("ccr_hook_phase3_probe", str(_RUNTIME))
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load runtime spec from {_RUNTIME}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv: list[str]) -> int:
    if not argv:
        sys.stderr.write("usage: phase3-probe.py <op> ...\n")
        return 2
    mod = _load_runtime()
    op = argv[0]
    rest = argv[1:]

    if op == "now":
        sys.stdout.write(mod.now() + "\n")
        return 0

    if op == "write-json":
        path, data = rest[0], json.loads(rest[1])
        mod.write_json(Path(path), data)
        return 0

    if op == "append-jsonl":
        path, data = rest[0], json.loads(rest[1])
        mod.append_jsonl(Path(path), data)
        return 0

    if op == "locked-state-set":
        root, patch = Path(rest[0]), json.loads(rest[1])
        with mod.locked_state(root) as state:
            state.update(patch)
        return 0

    if op == "write-status":
        root, state, status, reason = Path(rest[0]), json.loads(rest[1]), rest[2], rest[3]
        mod.write_status(root, state, status, reason)
        return 0

    if op == "mark-dirty":
        root, input_data, agent, role = Path(rest[0]), json.loads(rest[1]), rest[2], rest[3]
        mod.mark_dirty(root, input_data, agent, role)
        return 0

    if op == "ensure-session":
        root, input_data, agent, role = Path(rest[0]), json.loads(rest[1]), rest[2], rest[3]
        mod.ensure_session(root, agent, role, input_data)
        return 0

    if op == "collect-diff":
        result = list(mod.collect_diff(rest[0]))
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    if op == "compute-delta-patch":
        prev_diff, current_diff, dest = Path(rest[0]), Path(rest[1]), Path(rest[2])
        ok = mod.compute_delta_patch(prev_diff, current_diff, dest)
        sys.stdout.write(json.dumps({"ok": bool(ok)}) + "\n")
        return 0

    # ---- Phase 4a: session / intent / ledger + review/report FS helpers ----

    if op == "capture-context":
        mod.capture_session_context(Path(rest[0]), rest[1], rest[2])
        return 0

    if op == "load-context":
        sys.stdout.write(
            json.dumps({"value": mod.load_session_context(Path(rest[0]), rest[1])}, ensure_ascii=False) + "\n"
        )
        return 0

    if op == "load-intent":
        fallback = rest[2] if len(rest) > 2 else ""
        result = mod.load_session_intent(Path(rest[0]), rest[1], fallback)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    if op == "append-ledger":
        root, sid, round_no = Path(rest[0]), rest[1], int(rest[2])
        decision, must_fix, review_file = rest[3], int(rest[4]), Path(rest[5])
        mod.append_ledger(root, sid, round_no, decision, must_fix, review_file)
        return 0

    if op == "iteration-table":
        value = mod.build_iteration_table(Path(rest[0]), rest[1], int(rest[2]))
        sys.stdout.write(json.dumps({"value": value}, ensure_ascii=False) + "\n")
        return 0

    if op == "review-instructions":
        value = mod.load_review_instructions(Path(rest[0]))
        sys.stdout.write(json.dumps({"value": value}, ensure_ascii=False) + "\n")
        return 0

    if op == "find-prev-round":
        prev = mod.find_previous_round_dir(Path(rest[0]), rest[1], int(rest[2]))
        sys.stdout.write(json.dumps({"value": str(prev) if prev is not None else None}) + "\n")
        return 0

    if op == "parse-prev-review":
        prev = Path(rest[0]) if rest[0] else None
        result = mod.parse_previous_review(prev)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    if op == "build-worker-followup":
        round_dir, files, input_data = Path(rest[0]), json.loads(rest[1]), json.loads(rest[2])
        result = mod.build_worker_followup(round_dir, files, input_data)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    if op == "latest-session-id":
        sys.stdout.write(json.dumps({"value": mod._latest_session_id(Path(rest[0]))}, ensure_ascii=False) + "\n")
        return 0

    if op == "round-must-fix":
        sys.stdout.write(json.dumps({"value": mod._round_must_fix_count(Path(rest[0]))}) + "\n")
        return 0

    if op == "round-files-touched":
        value = sorted(mod._round_files_touched(Path(rest[0])))
        sys.stdout.write(json.dumps({"value": value}, ensure_ascii=False) + "\n")
        return 0

    # ---- Phase 4b: cmux surface/role/enabled (env + CONFIG_ROOT driven) ----

    if op == "role-for-surface":
        sys.stdout.write(json.dumps({"value": mod.role_for_current_surface()}) + "\n")
        return 0

    if op == "surface-for-role":
        sys.stdout.write(json.dumps({"value": mod.surface_for_role(rest[0])}, ensure_ascii=False) + "\n")
        return 0

    if op == "workspace-enabled":
        sys.stdout.write(json.dumps({"value": bool(mod.workspace_enabled())}) + "\n")
        return 0

    # ---- Phase 4b-2a: report generator + reaper + skip ----

    if op == "generate-report":
        root, sid, outcome = Path(rest[0]), rest[1], rest[2]
        trigger = rest[3] if len(rest) > 3 else "auto"
        p = mod.generate_session_report(root, sid, outcome, trigger=trigger)
        sys.stdout.write(json.dumps({"value": str(p) if p is not None else None}, ensure_ascii=False) + "\n")
        return 0

    if op == "reap-stale":
        root, state, event = Path(rest[0]), json.loads(rest[1]), rest[2]
        input_data, role = json.loads(rest[3]), rest[4]
        cleared = mod.reap_stale_active(root, state, event, input_data, role)
        sys.stdout.write(json.dumps({"cleared": bool(cleared), "state": state}, ensure_ascii=False) + "\n")
        return 0

    if op == "consume-skip":
        result = mod.consume_skip_marker(Path(rest[0]))
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    # ---- Phase 4b-2b: review orchestration + hook dispatch ----

    if op == "start-review":
        root, state, input_data, role = Path(rest[0]), json.loads(rest[1]), json.loads(rest[2]), rest[3]
        mod.start_review(root, state, input_data, role)
        sys.stdout.write(json.dumps({"state": state}, ensure_ascii=False) + "\n")
        return 0

    if op == "finish-review":
        root, state, input_data, role = Path(rest[0]), json.loads(rest[1]), json.loads(rest[2]), rest[3]
        finished = mod.finish_review(root, state, input_data, role)
        sys.stdout.write(json.dumps({"finished": bool(finished), "state": state}, ensure_ascii=False) + "\n")
        return 0

    if op == "handle-pre-tool":
        root, state, input_data = Path(rest[0]), json.loads(rest[1]), json.loads(rest[2])
        agent, role = rest[3], rest[4]
        result = mod.handle_pre_tool(root, state, input_data, agent, role)
        sys.stdout.write(json.dumps({"result": result, "state": state}, ensure_ascii=False) + "\n")
        return 0

    if op == "handle-user-prompt":
        root, state, input_data = Path(rest[0]), json.loads(rest[1]), json.loads(rest[2])
        agent, role = rest[3], rest[4]
        mod.handle_user_prompt_submit(root, state, input_data, agent, role)
        sys.stdout.write(json.dumps({"state": state}, ensure_ascii=False) + "\n")
        return 0

    if op == "handle-hook":
        agent, event, input_data = rest[0], rest[1], json.loads(rest[2])
        result = mod.handle_hook(agent, event, input_data)
        sys.stdout.write(json.dumps({"value": result}, ensure_ascii=False) + "\n")
        return 0

    if op == "ensure-info-exclude":
        mod.ensure_info_exclude(rest[0])
        sys.stdout.write(json.dumps({"ok": True}) + "\n")
        return 0

    sys.stderr.write(f"unknown op: {op}\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
