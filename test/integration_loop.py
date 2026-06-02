#!/usr/bin/env python3
"""CCR loop integration harness.

Drives the REAL hook dispatcher ``handle_hook`` end-to-end against a temp
HOME/cwd, stubbing ONLY the surface/transport boundary (cmux send) plus the
diff collector and request renderer. Everything else — the lock, state
persistence, the stale-active reaper, start_review, finish_review and the Stop
dispatch — runs for real.

This exercises the integration path that unit tests miss: the worker -> reviewer
-> worker handoff across multiple hook events, and specifically that the reaper
preserves ``active_request`` through reviewer-side and worker-side
``UserPromptSubmit`` events (the bug that silently dropped a completed review).

Run directly:  python3 test/integration_loop.py     (prints OK, or raises)
The Bun wrapper test/loop.test.ts asserts this exits 0.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / "templates" / "bin" / "ccr-hook.py"

# Isolate HOME *before* importing the module — module-level constants such as
# CONFIG_ROOT are computed from Path.home() at import time.
_HOME = tempfile.mkdtemp(prefix="ccr-itest-home-")
os.environ["HOME"] = _HOME
os.environ.pop("XDG_CONFIG_HOME", None)


def load_module():
    spec = importlib.util.spec_from_file_location("ccr_hook_itest", str(HOOK))
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class Harness:
    """Drives handle_hook with stubbed surface/diff boundaries."""

    def __init__(self, mod):
        self.mod = mod
        self.cwd = tempfile.mkdtemp(prefix="ccr-itest-cwd-")
        self.role = "claude"
        self.sent: list[tuple[str, str]] = []
        self._diff_n = 0
        self._install_stubs()

    def _install_stubs(self) -> None:
        m = self.mod
        m.role_for_current_surface = lambda: self.role
        m.workspace_enabled = lambda: True
        m.surface_for_role = lambda r: {"claude": "SURF-CLAUDE", "codex": "SURF-CODEX"}[r]

        def _send(surface: str, message: str) -> bool:
            self.sent.append((surface, message))
            return True

        m.send_to_surface = _send
        m.cmux = lambda *a, **k: None
        m.cmux_log = lambda *a, **k: None
        m.cmux_status = lambda *a, **k: None
        m.cmux_notify = lambda *a, **k: None
        m._try_generate_report = lambda *a, **k: None
        # Keep the request render off the filesystem/config; the markdown body is
        # tested elsewhere. We only care about the dispatch + handoff state here.
        m.request_markdown = lambda *a, **k: "REQUEST BODY"

        def _collect(_cwd: str):
            # Distinct hash each call so the same-hash stop guard never trips.
            self._diff_n += 1
            text = f"diff --git a/x.py b/x.py\n+change-{self._diff_n}\n"
            return (text, f"hash-{self._diff_n}", "HEAD0", True, 10, ["x.py"])

        m.collect_diff = _collect

    # -- driving + inspection -------------------------------------------------
    def hook(self, agent: str, event: str, **input_data):
        input_data.setdefault("cwd", self.cwd)
        input_data.setdefault("hook_event_name", event)
        return self.mod.handle_hook(agent, event, input_data)

    def state(self) -> dict:
        root = self.mod.root_for_cwd(self.cwd)
        st = self.mod.load_json(root / "state.json", {})
        return st if isinstance(st, dict) else {}

    def active(self):
        return self.state().get("active_request")

    def last_sent_to(self, surface: str):
        for surf, msg in reversed(self.sent):
            if surf == surface:
                return msg
        return None


def _new_harness():
    return Harness(load_module())


def scenario_full_handoff_pass() -> None:
    """worker edit -> Stop sends request; reviewer/worker prompts preserve the
    active request; reviewer PASS Stop delivers the result back to the worker."""
    h = _new_harness()
    W, R = "sess-worker", "sess-reviewer"

    # Worker makes a mutating edit, then stops.
    h.role = "claude"
    h.hook("claude", "PostToolUse", session_id=W, tool_name="Write",
           tool_input={"file_path": "x.py"})
    h.hook("claude", "Stop", session_id=W, last_assistant_message="did work")

    a = h.active()
    assert isinstance(a, dict), "Stop did not open a review round"
    assert a["worker"] == "claude" and a["reviewer"] == "codex"
    assert a["worker_session_id"] == W
    req = h.last_sent_to("SURF-CODEX")
    assert req and "review request" in req.lower(), f"reviewer never got request: {req!r}"

    # Reviewer receives the handoff as a UserPromptSubmit (reviewer session id !=
    # worker session id). REGRESSION: this must NOT reap the active request.
    h.role = "codex"
    h.hook("codex", "UserPromptSubmit", session_id=R,
           prompt="CCR automatic review request. Read the request file …")
    assert isinstance(h.active(), dict), "reviewer-side UserPromptSubmit reaped active_request"

    # Worker, meanwhile, submits an unrelated prompt under a DIFFERENT session id
    # (the manual-request / new-session shape). REGRESSION: must NOT reap either.
    h.role = "claude"
    h.hook("claude", "UserPromptSubmit", session_id="sess-worker-2",
           prompt="some unrelated follow-up")
    assert isinstance(h.active(), dict), "worker-side UserPromptSubmit mismatch reaped active_request"

    # Reviewer finishes with PASS -> the worker must receive the result handoff.
    h.role = "codex"
    h.hook("codex", "Stop", session_id=R,
           last_assistant_message="REVIEW_DECISION: PASS\n\nLooks good.")
    assert h.active() is None, "PASS did not clear active_request"
    res = h.last_sent_to("SURF-CLAUDE")
    assert res and "CCR review result: PASS" in res, f"worker never got PASS handoff: {res!r}"
    assert h.state().get("last_completed", {}).get("decision") == "PASS"


def scenario_needs_changes_delivers() -> None:
    h = _new_harness()
    W, R = "w2", "r2"
    h.role = "claude"
    h.hook("claude", "PostToolUse", session_id=W, tool_name="Write",
           tool_input={"file_path": "x.py"})
    h.hook("claude", "Stop", session_id=W, last_assistant_message="work")
    assert isinstance(h.active(), dict)

    # Reviewer handoff prompt then NEEDS_CHANGES verdict.
    h.role = "codex"
    h.hook("codex", "UserPromptSubmit", session_id=R,
           prompt="CCR automatic review request. …")
    assert isinstance(h.active(), dict), "reviewer prompt reaped before verdict"
    h.hook("codex", "Stop", session_id=R,
           last_assistant_message="REVIEW_DECISION: NEEDS_CHANGES\n\n## Must Fix\n- a real one\n")
    assert h.active() is None, "NEEDS_CHANGES did not clear active_request"
    res = h.last_sent_to("SURF-CLAUDE")
    assert res and "NEEDS_CHANGES" in res, f"worker never got NEEDS_CHANGES handoff: {res!r}"


def scenario_slow_review_survives_worker_activity() -> None:
    """A review that outlives the stale threshold must NOT be reaped by the
    worker's own mid-session events; the reviewer's later Stop still delivers.

    This guards the failure where a large diff (slow review) plus ongoing worker
    activity age-reaped the pending request before the handoff could return."""
    h = _new_harness()
    W, R = "w4", "r4"
    h.role = "claude"
    h.hook("claude", "PostToolUse", session_id=W, tool_name="Write",
           tool_input={"file_path": "x.py"})
    h.hook("claude", "Stop", session_id=W, last_assistant_message="work")
    assert isinstance(h.active(), dict)

    # Simulate a long-running review: pretend the active request is far older
    # than any stale threshold, then have the worker keep working.
    h.mod._active_request_age_seconds = lambda active: 10_000.0
    h.role = "claude"
    h.hook("claude", "UserPromptSubmit", session_id=W, prompt="still iterating while review runs")
    assert isinstance(h.active(), dict), "old-age active reaped on worker UserPromptSubmit (slow review lost)"
    h.hook("claude", "PostToolUse", session_id=W, tool_name="Write",
           tool_input={"file_path": "y.py"})
    assert isinstance(h.active(), dict), "old-age active reaped on worker PostToolUse"

    # Reviewer finally finishes — the result must still be delivered.
    h.role = "codex"
    h.hook("codex", "Stop", session_id=R,
           last_assistant_message="REVIEW_DECISION: PASS\n\nok")
    assert h.active() is None, "slow review did not finalize"
    assert h.last_sent_to("SURF-CLAUDE"), "slow review result not delivered to worker"


def scenario_orphan_still_reaped() -> None:
    """A genuine orphan — the WORKER surface starts a fresh session — must still
    be cleaned up, so the reaper fix did not over-correct."""
    h = _new_harness()
    W = "w3"
    h.role = "claude"
    h.hook("claude", "PostToolUse", session_id=W, tool_name="Write",
           tool_input={"file_path": "x.py"})
    h.hook("claude", "Stop", session_id=W, last_assistant_message="work")
    assert isinstance(h.active(), dict)

    # Worker surface restarts under a brand-new session id -> orphaned request.
    h.role = "claude"
    h.hook("claude", "SessionStart", session_id="w3-new")
    assert h.active() is None, "worker SessionStart with new session id should reap orphaned active_request"


def main() -> int:
    scenarios = [
        ("full handoff (PASS) preserves active across prompts", scenario_full_handoff_pass),
        ("NEEDS_CHANGES result is delivered to worker", scenario_needs_changes_delivers),
        ("slow review survives worker mid-session activity", scenario_slow_review_survives_worker_activity),
        ("genuine orphan (worker SessionStart) is still reaped", scenario_orphan_still_reaped),
    ]
    failed = 0
    for name, fn in scenarios:
        try:
            fn()
            print(f"[PASS] {name}")
        except AssertionError as e:
            failed += 1
            print(f"[FAIL] {name}: {e}")
        except Exception as e:  # noqa: BLE001 - surface unexpected errors per-case
            failed += 1
            print(f"[ERROR] {name}: {type(e).__name__}: {e}")
    print(f"\nCCR loop integration: {len(scenarios) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
