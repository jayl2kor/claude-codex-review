/**
 * phase4b2.test.ts — ORACLE integration test for Phase 4b-2a (report generator +
 * stale reaper + skip marker) against the Python runtime via phase3-probe.py.
 *
 * cmux side effects are isolated by prepending a temp bin with a fake `cmux`
 * (exit 0) to PATH — honored by Python (probe env) and by TS (cmux.ts resolves
 * the binary against the live PATH). Functions are run on PARALLEL temp roots;
 * embedded absolute paths are normalized (root -> <ROOT>) and timestamps to <TS>.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSessionReport } from "../src/lib/report.ts";
import { reapStaleActive, consumeSkipMarker } from "../src/lib/review.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "phase3-probe.py");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p4b2-${label}-`));
  TMP.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Fake cmux (exit 0) so send/log/notify/status are deterministic no-ops.
let FAKE_PATH = "";
function fakeCmuxPath(): string {
  if (!FAKE_PATH) {
    const bin = freshTmp("bin");
    const c = join(bin, "cmux");
    writeFileSync(c, "#!/bin/sh\nexit 0\n");
    chmodSync(c, 0o755);
    FAKE_PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  }
  return FAKE_PATH;
}

function probe(args: string[]): string {
  const proc = spawnSync("python3", [PROBE, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: fakeCmuxPath() },
  });
  if (proc.status !== 0) {
    throw new Error(`probe ${args[0]} exited ${proc.status}\n${proc.stdout}\n${proc.stderr}`);
  }
  return proc.stdout;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function probeJson(args: string[]): any {
  return JSON.parse(probe(args).trim());
}
function withFakeCmux<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = fakeCmuxPath();
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}
function read(p: string): string {
  return readFileSync(p, "utf-8");
}
function norm(s: string, root: string): string {
  return s.split(root).join("<ROOT>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>");
}

// ===========================================================================
// generate_session_report
// ===========================================================================
function buildSession(root: string, sid: string): void {
  const sdir = join(root, "sessions", sid);
  mkdirSync(join(sdir, "rounds", "0001"), { recursive: true });
  mkdirSync(join(sdir, "rounds", "0002"), { recursive: true });
  writeFileSync(
    join(sdir, "session.json"),
    JSON.stringify({
      version: 1, agent: "claude", role: "claude", session_id: sid, cwd: "/work/repo",
      workspace_id: "WS-1", surface_id: "S-1", transcript_path: null, model: null,
      created_at: "2026-06-03T10:00:00Z", updated_at: "2026-06-03T10:05:00Z",
    }, null, 2) + "\n",
  );
  const r1 = join(sdir, "rounds", "0001");
  writeFileSync(join(r1, "decision.json"), JSON.stringify({
    decision: "NEEDS_CHANGES", reviewer: "codex", worker: "claude", round: 1,
    review_file: join(r1, "review.md"), must_fix_count: 2, updated_at: "2026-06-03T10:01:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(r1, "review.md"), "REVIEW_DECISION: NEEDS_CHANGES\n\n## Must Fix\n- `x.ts:1` bad\n- `x.ts:2` worse\n");
  writeFileSync(join(r1, "request.md"), "# CCR Review Request\n\nstuff\n");
  writeFileSync(join(r1, "diff.patch"), "diff --git a/src/x.ts b/src/x.ts\n@@\n+added\n-removed\n");
  const r2 = join(sdir, "rounds", "0002");
  writeFileSync(join(r2, "decision.json"), JSON.stringify({
    decision: "PASS", reviewer: "codex", worker: "claude", round: 2, updated_at: "2026-06-03T10:04:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(r2, "review.md"), "REVIEW_DECISION: PASS\n\n## Must Fix\n- None.\n");
  writeFileSync(join(r2, "diff.patch"), "diff --git a/src/y.ts b/src/y.ts\n@@\n+ok\n");
  writeFileSync(join(r2, "delta.patch"), "--- a\n+++ b\n");
  // events.jsonl: one for this session (skipped + user_prompt) + one foreign (filtered out)
  writeFileSync(
    join(root, "events.jsonl"),
    JSON.stringify({ at: "2026-06-03T10:00:30Z", type: "skipped", reason: "ccr-skip-next", session_id: sid }) + "\n" +
    JSON.stringify({ at: "2026-06-03T10:02:30Z", type: "user_prompt", session_id: sid }) + "\n" +
    JSON.stringify({ at: "2026-06-03T10:03:00Z", type: "skipped", reason: "x", session_id: "OTHER" }) + "\n",
  );
}

describe("report.generateSessionReport (oracle byte parity)", () => {
  test("full session report.md + status.json + events match the oracle", () => {
    const sid = "sess-rep";
    const py = freshTmp("rep-py");
    const ts = freshTmp("rep-ts");
    buildSession(py, sid);
    buildSession(ts, sid);

    const pyVal = (probeJson(["generate-report", py, sid, "passed", "auto"]) as { value: string }).value;
    const tsVal = withFakeCmux(() => generateSessionReport(ts, sid, "passed", "auto"));

    expect(norm(tsVal ?? "", ts)).toBe(norm(pyVal ?? "", py));
    const rel = join("sessions", sid, "report.md");
    expect(norm(read(join(ts, rel)), ts)).toBe(norm(read(join(py, rel)), py));
    expect(norm(read(join(ts, "status.json")), ts)).toBe(norm(read(join(py, "status.json")), py));
    expect(norm(read(join(ts, "events.jsonl")), ts)).toBe(norm(read(join(py, "events.jsonl")), py));
    // sanity: the report embeds the rounds + files-touched
    expect(read(join(ts, rel))).toContain("# CCR Session Report");
    expect(read(join(ts, rel))).toContain("`src/x.ts`");
    expect(read(join(ts, rel))).toContain("<details><summary>review.md</summary>");
  });

  test("empty session id with no sessions dir returns null on both", () => {
    const py = freshTmp("rep0-py");
    const ts = freshTmp("rep0-ts");
    const pyVal = (probeJson(["generate-report", py, "", "passed", "auto"]) as { value: string | null }).value;
    const tsVal = withFakeCmux(() => generateSessionReport(ts, "", "passed", "auto"));
    expect(tsVal).toBeNull();
    expect(pyVal).toBeNull();
  });
});

// ===========================================================================
// reap_stale_active
// ===========================================================================
describe("review.reapStaleActive (oracle parity)", () => {
  const activeBase = {
    round: 1, worker: "claude", reviewer: "codex", worker_session_id: "sess-A",
    worker_surface: "S-A", reviewer_surface: "S-B", request_file: "/r/req.md",
    diff_file: "/r/diff.patch", diff_hash: "abc", created_at: "2000-01-01T00:00:00Z",
  };

  function run(state: Record<string, unknown>, event: string, input: Record<string, unknown>, role: string) {
    const py = freshTmp("reap-py");
    const ts = freshTmp("reap-ts");
    const pyOut = probeJson(["reap-stale", py, JSON.stringify(state), event, JSON.stringify(input), role]);
    const tsState = JSON.parse(JSON.stringify(state));
    const cleared = withFakeCmux(() => reapStaleActive(ts, tsState, event, input, role));
    expect({ cleared, state: tsState }).toEqual({ cleared: pyOut.cleared, state: pyOut.state });
    return { py, ts };
  }

  test("age-stale on SessionStart clears + writes status/events", () => {
    const { py, ts } = run(
      { version: 1, review_count: 1, active_request: { ...activeBase } },
      "SessionStart",
      { session_id: "sess-NEW", cwd: "/work" },
      "claude",
    );
    expect(norm(read(join(ts, "status.json")), ts)).toBe(norm(read(join(py, "status.json")), py));
    expect(norm(read(join(ts, "events.jsonl")), ts)).toBe(norm(read(join(py, "events.jsonl")), py));
  });

  test("session-mismatch on worker SessionStart clears", () => {
    run(
      { version: 1, active_request: { ...activeBase, created_at: "2026-06-03T09:59:59Z" } },
      "SessionStart",
      { session_id: "sess-DIFFERENT", cwd: "/work" },
      "claude",
    );
  });

  test("PostToolUse never reaps (no clear)", () => {
    run(
      { version: 1, active_request: { ...activeBase } },
      "PostToolUse",
      { session_id: "sess-NEW" },
      "claude",
    );
  });

  test("no active_request -> false no-op", () => {
    run({ version: 1, active_request: null }, "SessionStart", { session_id: "s" }, "claude");
  });
});

// ===========================================================================
// consume_skip_marker
// ===========================================================================
describe("review.consumeSkipMarker (oracle parity)", () => {
  test("present marker is returned and removed", () => {
    const py = freshTmp("skip-py");
    const ts = freshTmp("skip-ts");
    for (const r of [py, ts]) {
      writeFileSync(join(r, "skip-next.json"), JSON.stringify({ by_surface: "S-1" }));
    }
    const pyOut = probeJson(["consume-skip", py]);
    const tsOut = consumeSkipMarker(ts);
    expect(tsOut).toEqual(pyOut);
    expect(existsSync(join(ts, "skip-next.json"))).toBe(false);
    expect(existsSync(join(py, "skip-next.json"))).toBe(false);
  });

  test("absent marker -> null", () => {
    const py = freshTmp("skip0-py");
    const ts = freshTmp("skip0-ts");
    expect(consumeSkipMarker(ts)).toBeNull();
    expect(probeJson(["consume-skip", py])).toBeNull();
  });
});
