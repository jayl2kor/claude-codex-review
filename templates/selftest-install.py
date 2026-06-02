import contextlib
import io
import importlib.util
import json
import sys
import zipfile as _zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("ccr_hook", str(Path.home() / ".local" / "bin" / "ccr-hook.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.parse_decision("REVIEW_DECISION: PASS\nrest") == "PASS", "PASS parse failed"
assert mod.parse_decision("preamble\nREVIEW_DECISION: NEEDS_CHANGES") == "NEEDS_CHANGES", "NEEDS_CHANGES with preamble failed"
assert mod.parse_decision("REVIEW_DECISION:   NEEDS_HUMAN  ") == "NEEDS_HUMAN", "NEEDS_HUMAN with whitespace failed"
assert mod.parse_decision("REVIEW_DECISION: pass") == "PASS", "case-insensitive failed"
assert mod.parse_decision("no decision here") == "INVALID", "INVALID fallback failed"
fenced = (
    "Example format:\n"
    "```\n"
    "REVIEW_DECISION: PASS\n"
    "```\n"
    "Actual verdict:\n"
    "REVIEW_DECISION: NEEDS_CHANGES\n"
)
assert mod.parse_decision(fenced) == "NEEDS_CHANGES", "fenced example leaked into decision"
quoted = "> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n"
assert mod.parse_decision(quoted) == "NEEDS_HUMAN", "blockquote example leaked into decision"

assert mod.count_changed_lines("--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other") == 2, "count_changed_lines miscounted"

assert mod.should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "ccr-reset"}}) is False, "ccr-reset should not mark dirty"
assert mod.should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "ccr-status"}}) is False, "ccr-status should not mark dirty"
assert mod.should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "pytest"}}) is False, "read-only/test bash should not mark dirty"
assert mod.should_mark_dirty_for_tool({"tool_name": "Bash", "tool_input": {"command": "printf x > app.py"}}) is True, "redirecting bash should mark dirty"
assert mod.should_mark_dirty_for_tool({"tool_name": "apply_patch"}) is True, "apply_patch should mark dirty"

_followup_req = mod.request_markdown(
    "codex",
    "claude",
    2,
    "hash",
    "head",
    Path("/tmp/diff.patch"),
    Path("/tmp/delta.patch"),
    {"review_file": "/tmp/review.md", "decision": "NEEDS_CHANGES", "must_fix_count": 1},
    {"file": "/tmp/worker-followup.md", "message": "Applied A.\nDid not apply B because C.", "files": ["ccr.sh"]},
)
assert "## Worker Follow-up Since Previous Review" in _followup_req, "worker follow-up section missing"
assert "Applied A." in _followup_req and "Did not apply B because C." in _followup_req, "worker follow-up message missing"
assert "Files touched in current diff: ccr.sh" in _followup_req, "worker follow-up files missing"

big_section = "+" + ("A" * 200) + "\n"
many = big_section * 50
out = mod._truncate_sections(
    [
        ("# Git HEAD", "abc"),
        ("# Staged Diff", many),
        ("# Unstaged Diff", many),
        ("# Untracked Files", many),
    ],
    max_bytes=500,
)
assert len(out.encode("utf-8")) <= 500, f"truncate_sections exceeded budget: {len(out.encode('utf-8'))}"
tiny = mod._truncate_sections([("# Git HEAD", "abc"), ("# Staged Diff", "x" * 10000)], max_bytes=30)
assert len(tiny.encode("utf-8")) <= 30, f"truncate_sections degenerate budget breach: {len(tiny.encode('utf-8'))}"

assert mod.is_ccr_handoff_prompt("[ccr-handoff]\n자동 리뷰 요청입니다") is True, "sentinel not detected"
assert mod.is_ccr_handoff_prompt("please [ccr-handoff] later") is False, "sentinel must be on first line"
assert mod.is_ccr_handoff_prompt("normal user prompt") is False, "false positive on normal prompt"
assert mod.is_ccr_handoff_prompt("") is False, "empty prompt mishandled"

import tempfile, os as _os
with tempfile.TemporaryDirectory() as _td_prompt:
    _root_prompt = Path(_td_prompt) / "ccr"
    _state_prompt = {
        "review_count": 1,
        "last_diff_hash": "hash-before",
        "active_request": {"round": 1, "worker": "claude", "reviewer": "codex"},
    }
    mod.handle_user_prompt_submit(
        _root_prompt,
        _state_prompt,
        {"session_id": "sid", "prompt": "new user work"},
        "claude",
        "claude",
    )
    assert _state_prompt["review_count"] == 1, "active review prompt reset review_count"
    assert _state_prompt["last_diff_hash"] == "hash-before", "active review prompt reset last_diff_hash"
    assert isinstance(_state_prompt.get("active_request"), dict), "active review prompt cleared active_request"
    assert not (_root_prompt / "events.jsonl").exists(), "active review prompt should not append reset event"

with tempfile.TemporaryDirectory() as _td_json:
    _json_path = Path(_td_json) / "hooks.json"
    _json_path.write_text('{"hooks":{"Stop":[{"hooks":[{"command":"/tmp/ccr-hook-codex Stop"}]}]}}', encoding="utf-8")
    assert mod._json_file_contains(_json_path, "/tmp/ccr-hook-codex") is True, "doctor JSON hook detection failed"
    assert mod._json_file_contains(_json_path, "/tmp/other-hook") is False, "doctor JSON hook false positive"
    _json_path.write_text("{not-json", encoding="utf-8")
    assert mod._json_file_contains(_json_path, "/tmp/ccr-hook-codex") is False, "invalid JSON should not match"

_doctor_stdout = io.StringIO()
with contextlib.redirect_stdout(_doctor_stdout):
    _doctor_rc = mod.command_doctor(mod.argparse.Namespace(json_output=True))
_doctor_body = _doctor_stdout.getvalue()
_doctor_doc = json.loads(_doctor_body)
assert _doctor_rc in {0, 1}, "doctor JSON returned unexpected exit code"
assert "CCR Doctor" not in _doctor_body, "doctor JSON output included text header"
assert _doctor_doc["version"] == 1, "doctor JSON version missing"
assert isinstance(_doctor_doc.get("checks"), list) and _doctor_doc["checks"], "doctor JSON checks missing"
assert {"fail", "warn", "ok"} <= set(_doctor_doc.get("summary", {}).keys()), "doctor JSON summary keys missing"
assert isinstance(_doctor_doc.get("next"), str) and _doctor_doc["next"], "doctor JSON next message missing"
assert isinstance(_doctor_doc.get("actions"), list) and _doctor_doc["actions"], "doctor JSON actions missing"
assert mod._doctor_action_items([{"status": "warn", "name": "workspace enabled", "detail": "run ccr-enable"}]) == [
    "Run `ccr-enable` from the target repository directory."
], "doctor workspace action missing"
assert mod._doctor_action_items([{"status": "ok", "name": "active request", "detail": "none"}]) == [
    "Run `ccr-status` or start work normally."
], "doctor all-ok action missing"

_ready_stdout = io.StringIO()
with contextlib.redirect_stdout(_ready_stdout):
    _ready_rc = mod.command_ready(mod.argparse.Namespace(json_output=True))
_ready_doc = json.loads(_ready_stdout.getvalue())
assert _ready_rc in {0, 1}, "ready JSON returned unexpected exit code"
assert _ready_doc["version"] == 1, "ready JSON version missing"
assert isinstance(_ready_doc.get("ready"), bool), "ready JSON ready flag missing"
assert isinstance(_ready_doc.get("checks"), list) and _ready_doc["checks"], "ready JSON checks missing"
assert isinstance(_ready_doc.get("actions"), list), "ready JSON actions missing"

with tempfile.TemporaryDirectory() as _td_support:
    _cwd_support = _os.getcwd()
    try:
        _os.chdir(_td_support)
        _sid_support = "support-session"
        _rdir_support = Path(_td_support) / ".cmux" / "ccr" / "sessions" / _sid_support / "rounds" / "0001"
        _rdir_support.mkdir(parents=True)
        (_rdir_support.parent.parent / "session.json").write_text(
            '{"workspace_id":"w","cwd":"/tmp","role":"claude","created_at":"2026-01-01T00:00:00Z"}',
            encoding="utf-8",
        )
        (_rdir_support / "decision.json").write_text(
            '{"decision":"PASS","reviewer":"codex","worker":"claude","round":1,"updated_at":"2026-01-01T00:01:00Z"}',
            encoding="utf-8",
        )
        (_rdir_support / "diff.patch").write_text("diff --git a/x b/x\n+hi\n", encoding="utf-8")
        _support_stdout = io.StringIO()
        with contextlib.redirect_stdout(_support_stdout):
            _support_rc = mod.command_support(mod.argparse.Namespace(session="", include_diffs=False, print_body=True))
        _support_zip = Path(_support_stdout.getvalue().splitlines()[0])
        assert _support_rc == 0 and _support_zip.is_file(), "support bundle not created"
        with _zipfile.ZipFile(_support_zip) as _zf:
            _names = set(_zf.namelist())
            assert "manifest.json" in _names and "doctor.json" in _names, "support bundle missing base files"
            assert f"sessions/{_sid_support}/rounds/0001/decision.json" in _names, "support bundle missing decision metadata"
            assert f"sessions/{_sid_support}/rounds/0001/diff.patch" not in _names, "support bundle included diff without --include-diffs"
            _manifest = json.loads(_zf.read("manifest.json").decode("utf-8"))
            assert _manifest["include_payloads"] is False, "support manifest payload flag false missing"
        _support_stdout2 = io.StringIO()
        with contextlib.redirect_stdout(_support_stdout2):
            mod.command_support(mod.argparse.Namespace(session=_sid_support, include_diffs=True, print_body=False))
        _support_zip2 = Path(_support_stdout2.getvalue().splitlines()[0])
        with _zipfile.ZipFile(_support_zip2) as _zf2:
            assert f"sessions/{_sid_support}/rounds/0001/diff.patch" in set(_zf2.namelist()), "support bundle omitted diff with --include-diffs"
    finally:
        _os.chdir(_cwd_support)

with tempfile.TemporaryDirectory() as _td:
    _cwd = _os.getcwd()
    try:
        _os.chdir(_td)
        _os.system("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i >/dev/null 2>&1")
        big = ("+x" * 1000 + "\n") * 200
        with open(_os.path.join(_td, "big.txt"), "w") as _f:
            _f.write(big)
        mod.MAX_DIFF_BYTES = 200
        text, _h, _head, has, _cl, files = mod.collect_diff(_td)
        assert has is True, "collect_diff lost has_content after truncation"
        assert files == ["big.txt"], f"collect_diff lost touched files after truncation: {files!r}"
    finally:
        _os.chdir(_cwd)

with tempfile.TemporaryDirectory() as _td2:
    _cwd2 = _os.getcwd()
    try:
        _os.chdir(_td2)
        _os.system("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i >/dev/null 2>&1")
        lines = 60
        per_line = ("x" * 40) + "\n"
        with open(_os.path.join(_td2, "big.txt"), "w") as _f:
            _f.write(per_line * lines)
        mod.MAX_DIFF_BYTES = 200
        text2, _h2, _head2, has2, changed2, files2 = mod.collect_diff(_td2)
        assert has2 is True, "collect_diff lost has_content"
        assert changed2 >= lines, f"full_changed_lines undercounted under truncation: got {changed2}, expected >= {lines}"
        assert mod.count_changed_lines(text2) < changed2, "expected truncated text to under-count vs full"
        assert files2 == ["big.txt"], f"full touched files under truncation missing: {files2!r}"
    finally:
        _os.chdir(_cwd2)

with tempfile.TemporaryDirectory() as _td3:
    _cwd3 = _os.getcwd()
    try:
        _os.chdir(_td3)
        _os.system("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i >/dev/null 2>&1")
        per_line = ("x" * 40) + "\n"
        with open(_os.path.join(_td3, "big.txt"), "w") as _f:
            _f.write(per_line * 60)
        mod.MAX_DIFF_BYTES = 100
        _t1, hash1, _, _, _, _ = mod.collect_diff(_td3)
        with open(_os.path.join(_td3, "big.txt"), "a") as _f:
            _f.write(("y" * 40 + "\n") * 50)
        _t2, hash2, _, _, _, _ = mod.collect_diff(_td3)
        assert hash1 != hash2, "diff_hash collapsed under truncation: same-hash guard would silently skip real changes"
    finally:
        _os.chdir(_cwd3)

with tempfile.TemporaryDirectory() as _td4:
    _root = Path(_td4) / "ccr"
    _sid = "test-session"
    _sdir = _root / "sessions" / _sid
    _rdir = _sdir / "rounds" / "0001"
    _rdir.mkdir(parents=True)
    (_sdir / "session.json").write_text(
        '{"workspace_id":"w","cwd":"/tmp","role":"claude","created_at":"2026-01-01T00:00:00Z"}',
        encoding="utf-8",
    )
    (_rdir / "request.md").write_text("req body", encoding="utf-8")
    (_rdir / "diff.patch").write_text("diff --git a/x b/x\n+hi\n-bye\n", encoding="utf-8")
    (_rdir / "review.md").write_text(
        "REVIEW_DECISION: PASS\n\n## Must Fix\n- one thing\n- another\n\n## Looks Good\n- yes\n",
        encoding="utf-8",
    )
    (_rdir / "decision.json").write_text(
        '{"decision":"PASS","reviewer":"codex","worker":"claude","round":1,"review_file":"'
        + str(_rdir / "review.md") + '","updated_at":"2026-01-01T00:05:00Z"}',
        encoding="utf-8",
    )
    rp_passed = mod.generate_session_report(_root, _sid, "passed")
    assert rp_passed is not None and rp_passed.exists(), "report.md not created (passed)"
    body = rp_passed.read_text(encoding="utf-8")
    assert "# CCR Session Report" in body, "report missing title"
    assert "## Summary" in body, "report missing Summary"
    assert "Round 1" in body, "report missing Round 1 detail"
    assert "**passed**" in body, "report missing outcome cell"
    st = mod.load_json(_root / "status.json", {})
    assert isinstance(st, dict) and isinstance(st.get("last_report"), dict), "last_report not stamped in status.json"

    rp_max = mod.generate_session_report(_root, _sid, "max_rounds")
    assert rp_max is not None and "**max_rounds**" in rp_max.read_text(encoding="utf-8"), "max_rounds outcome missing"

    rp_none = mod.generate_session_report(_root, "no-such-sid", "passed")
    assert rp_none is None, "report should return None for unknown session"

    # Fence-escape: review.md with triple-backticks must not break the report's fence.
    _sid2 = "fence-session"
    _sdir2 = _root / "sessions" / _sid2
    _rdir2 = _sdir2 / "rounds" / "0001"
    _rdir2.mkdir(parents=True)
    (_sdir2 / "session.json").write_text(
        '{"workspace_id":"w","cwd":"/tmp","role":"claude","created_at":"2026-01-01T00:00:00Z"}',
        encoding="utf-8",
    )
    (_rdir2 / "diff.patch").write_text("diff --git a/x b/x\n+hi\n", encoding="utf-8")
    (_rdir2 / "review.md").write_text(
        "REVIEW_DECISION: PASS\n\nExample:\n```\ncode\n```\n",
        encoding="utf-8",
    )
    (_rdir2 / "decision.json").write_text(
        '{"decision":"PASS","reviewer":"codex","worker":"claude","round":1,"updated_at":"2026-01-01T00:01:00Z"}',
        encoding="utf-8",
    )
    rp_fence = mod.generate_session_report(_root, _sid2, "passed")
    assert rp_fence is not None
    fbody = rp_fence.read_text(encoding="utf-8")
    assert "````markdown" in fbody or "`````markdown" in fbody, "fence not escaped for review.md containing ```"

assert mod._count_must_fix_in_text("## Must Fix\n- None.\n\n## Looks Good\n- ok\n") == 0, "sentinel '- None.' counted as must-fix"
assert mod._count_must_fix_in_text("## Must Fix\n- N/A\n- -\n- (none)\n- 없음\n") == 0, "sentinel variants counted as must-fix"
assert mod._count_must_fix_in_text("## Must Fix\n- a real one\n- another\n") == 2, "real must-fix items not counted"
assert mod._count_must_fix_in_text("## Must Fix\n- None.\n- a real one\n") == 1, "mixed sentinel + real miscounted"

print("ccr-hook self-test OK", file=sys.stderr)
