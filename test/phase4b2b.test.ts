/**
 * phase4b2b.test.ts — ORACLE integration test for Phase 4b-2b (review
 * orchestration + hook dispatch) against the Python runtime via phase3-probe.py.
 *
 * The orchestration functions are driven DIRECTLY (start_review / finish_review /
 * handle_user_prompt_submit / handle_pre_tool), each given an explicit
 * (root, state, input, role) — so the workspace_enabled gate is never hit and the
 * real shared ENABLED_FILE is never touched. handle_hook is tested only on its
 * SAFE gate paths (not-enabled / unknown-role) with the cmux env vars unset.
 *
 * Isolation:
 *  - state roots are PARALLEL temp dirs (py vs ts); embedded absolute paths are
 *    normalized (root -> <ROOT>) and timestamps to <TS>.
 *  - send_to_surface succeeds identically via a fake `cmux` (exit 0) prepended to
 *    PATH — honored by Python (probe env) and TS (cmux.ts resolves against the
 *    live PATH).
 *  - surface_for_role reads an isolated, uniquely-named workspace dir created
 *    under the real CONFIG_ROOT and removed afterwards (other workspaces & the
 *    ENABLED_FILE untouched).
 *  - the git repo whose diff is collected is SHARED between both runtimes (read
 *    only), so the HEAD short hash + diff_hash match.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { startReview, finishReview } from "../src/lib/review.ts";
import { handlePreTool, handleUserPromptSubmit, handleHook, ensureInfoExclude } from "../src/lib/hooks.ts";
import { markDirty } from "../src/lib/lock.ts";
import { defaultState } from "../src/lib/misc.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "phase3-probe.py");
const CONFIG_ROOT = join(homedir(), ".config", "claude-codex-review");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p4b2b-${label}-`));
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

// Fake cmux (exit 0): send/log/notify/status are deterministic no-ops; the
// send-to-surface success branch is exercised without invoking the real cmux.
let FAKE_BIN = "";
function fakeBin(): string {
  if (!FAKE_BIN) {
    const bin = freshTmp("bin");
    const c = join(bin, "cmux");
    writeFileSync(c, "#!/bin/sh\nexit 0\n");
    chmodSync(c, 0o755);
    FAKE_BIN = bin;
  }
  return FAKE_BIN;
}
function fakePath(): string {
  return `${fakeBin()}${delimiter}${process.env.PATH ?? ""}`;
}

// Unique workspace id -> isolated surface dir under the real CONFIG_ROOT.
const WID = `ccr-test-${process.pid}-${process.hrtime.bigint()}`;
const WS_DIR = join(CONFIG_ROOT, "workspaces", WID);
function setupSurfaces(): void {
  mkdirSync(WS_DIR, { recursive: true });
  TMP.push(WS_DIR);
  writeFileSync(join(WS_DIR, "claude-surface"), "SURF_CLAUDE\n");
  writeFileSync(join(WS_DIR, "codex-surface"), "SURF_CODEX\n");
}

function probe(args: string[], env: Record<string, string> = {}): string {
  const proc = spawnSync("python3", [PROBE, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: fakePath(), ...env },
  });
  if (proc.status !== 0) {
    throw new Error(`probe ${args[0]} exited ${proc.status}\n${proc.stdout}\n${proc.stderr}`);
  }
  return proc.stdout;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function probeJson(args: string[], env: Record<string, string> = {}): any {
  return JSON.parse(probe(args, env).trim());
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev[k]!;
      }
    }
  }
}

function read(p: string): string {
  return readFileSync(p, "utf-8");
}
function norm(s: string, root: string): string {
  return s.split(root).join("<ROOT>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>");
}

// A SHARED temp git repo with one committed + one unstaged change, so collect_diff
// has content and a stable HEAD/diff_hash for BOTH runtimes.
let SHARED_REPO = "";
function sharedRepo(): string {
  if (!SHARED_REPO) {
    const r = freshTmp("repo");
    const run = (...a: string[]) =>
      spawnSync("git", ["-C", r, ...a], { encoding: "utf-8" });
    run("init", "-q");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    writeFileSync(join(r, "a.ts"), "export const a = 1;\n");
    run("add", "a.ts");
    run("commit", "-q", "-m", "init");
    writeFileSync(join(r, "a.ts"), "export const a = 2;\n"); // unstaged change
    SHARED_REPO = r;
  }
  return SHARED_REPO;
}

// ===========================================================================
// End-to-end: UserPromptSubmit -> dirty -> Stop(start_review) -> reviewer
// Stop(finish_review) — every artifact byte-compared.
// ===========================================================================
describe("review e2e (oracle byte parity)", () => {
  test("worker round 1 -> reviewer PASS produces identical state/files", () => {
    setupSurfaces();
    const repo = sharedRepo();
    const sid = "sess-worker";
    const promptText = "PURPOSE: ship the widget\nNON_GOAL: refactors";
    const reviewMsg = "REVIEW_DECISION: PASS\n\n# Review\n\n## Verdict\n- Looks good.";
    const env = { CMUX_WORKSPACE_ID: WID, PATH: fakePath() };

    const py = freshTmp("e2e-py");
    const ts = freshTmp("e2e-ts");

    // --- TS run -----------------------------------------------------------
    let tsAfterStart: unknown;
    const tsState = withEnv(env, () => {
      const state: Record<string, unknown> = { ...defaultState() };
      handleUserPromptSubmit(ts, state, { session_id: sid, prompt: promptText }, "claude", "claude");
      markDirty(ts, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit" }, "claude", "claude");
      startReview(ts, state, { session_id: sid, cwd: repo, last_assistant_message: "did the work" }, "claude");
      tsAfterStart = JSON.parse(JSON.stringify(state)); // capture active_request shape
      const finished = finishReview(
        ts,
        state,
        { session_id: "sess-rev", last_assistant_message: reviewMsg },
        "codex",
      );
      expect(finished).toBe(true);
      return state;
    });

    // --- Python run (thread state through the probe ops) ------------------
    const s1 = probeJson(
      ["handle-user-prompt", py, JSON.stringify(defaultState()), JSON.stringify({ session_id: sid, prompt: promptText }), "claude", "claude"],
      env,
    ).state;
    probe(
      ["mark-dirty", py, JSON.stringify({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit" }), "claude", "claude"],
      env,
    );
    const s2 = probeJson(
      ["start-review", py, JSON.stringify(s1), JSON.stringify({ session_id: sid, cwd: repo, last_assistant_message: "did the work" }), "claude"],
      env,
    ).state;
    const finRes = probeJson(
      ["finish-review", py, JSON.stringify(s2), JSON.stringify({ session_id: "sess-rev", last_assistant_message: reviewMsg }), "codex"],
      env,
    );
    expect(finRes.finished).toBe(true);
    const pyState = finRes.state;

    // active_request shape + key order parity (overwritten by finish_review).
    expect(norm(JSON.stringify(tsAfterStart), ts)).toBe(norm(JSON.stringify(s2), py));
    // Final state parity (normalize embedded root + timestamps).
    expect(norm(JSON.stringify(tsState), ts)).toBe(norm(JSON.stringify(pyState), py));

    // Per-round + session artifacts.
    const rel = (p: string) => p;
    const files = [
      join("sessions", sid, "rounds", "0001", "diff.patch"),
      join("sessions", sid, "rounds", "0001", "request.md"),
      join("sessions", sid, "rounds", "0001", "review.md"),
      join("sessions", sid, "rounds", "0001", "decision.json"),
      join("sessions", sid, "ledger.md"),
      join("sessions", sid, "context.md"),
      join("sessions", sid, "report.md"),
      "status.json",
      "events.jsonl",
    ];
    for (const f of files) {
      expect(existsSync(join(ts, f))).toBe(true);
      expect(existsSync(join(py, f))).toBe(true);
      expect(norm(read(join(ts, rel(f))), ts)).toBe(norm(read(join(py, rel(f))), py));
    }

    // Sanity: the round was sent + finalized as PASS.
    expect(read(join(ts, "status.json"))).toContain('"status": "passed"');
    expect(read(join(ts, "sessions", sid, "rounds", "0001", "request.md"))).toContain("# CCR Review Request");
    expect(read(join(ts, "sessions", sid, "report.md"))).toContain("# CCR Session Report");
  });
});

// ===========================================================================
// handle_pre_tool — reviewer-only mutation block.
// ===========================================================================
describe("hooks.handlePreTool (oracle parity)", () => {
  const active = {
    round: 1, worker: "claude", reviewer: "codex", worker_session_id: "w",
    worker_surface: "S-A", reviewer_surface: "S-B", request_file: "/r/req.md",
    diff_file: "/r/d.patch", diff_hash: "h", created_at: "2026-06-03T10:00:00Z",
  };

  function run(state: Record<string, unknown>, input: Record<string, unknown>, agent: string, role: string) {
    const py = freshTmp("pt-py");
    const ts = freshTmp("pt-ts");
    const pyOut = probeJson(["handle-pre-tool", py, JSON.stringify(state), JSON.stringify(input), agent, role]);
    const tsState = JSON.parse(JSON.stringify(state));
    const result = withEnv({ PATH: fakePath() }, () => handlePreTool(ts, tsState, input, agent, role));
    expect({ result, state: tsState }).toEqual({ result: pyOut.result ?? null, state: pyOut.state });
    return result;
  }

  test("codex reviewer + Edit -> codex deny shape", () => {
    const r = run({ version: 1, active_request: { ...active } }, { tool_name: "Edit" }, "codex", "codex") as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect((r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("claude reviewer + mutating Bash -> block decision", () => {
    const r = run({ version: 1, active_request: { ...active, reviewer: "claude" } }, { tool_name: "Bash", tool_input: { command: "rm -rf x" } }, "claude", "claude") as Record<string, unknown>;
    expect((r as { decision?: string }).decision).toBe("block");
  });

  test("non-mutating tool -> null", () => {
    expect(run({ version: 1, active_request: { ...active } }, { tool_name: "Read" }, "codex", "codex")).toBeNull();
  });

  test("role is not the reviewer -> null", () => {
    expect(run({ version: 1, active_request: { ...active } }, { tool_name: "Edit" }, "claude", "claude")).toBeNull();
  });

  test("no active_request -> null", () => {
    expect(run({ version: 1, active_request: null }, { tool_name: "Edit" }, "codex", "codex")).toBeNull();
  });
});

// ===========================================================================
// handle_user_prompt_submit — reset + handoff branches.
// ===========================================================================
describe("hooks.handleUserPromptSubmit (oracle parity)", () => {
  test("non-handoff prompt with prior rounds resets counter + emits event", () => {
    const py = freshTmp("ups-py");
    const ts = freshTmp("ups-ts");
    const state = { version: 1, review_count: 2, last_diff_hash: "abc", active_request: null };
    const input = { session_id: "s1", prompt: "please do the next thing" };

    const pyOut = probeJson(["handle-user-prompt", py, JSON.stringify(state), JSON.stringify(input), "claude", "claude"]);
    const tsState = JSON.parse(JSON.stringify(state));
    withEnv({ PATH: fakePath() }, () => handleUserPromptSubmit(ts, tsState, input, "claude", "claude"));

    expect(tsState).toEqual(pyOut.state);
    expect(norm(read(join(ts, "status.json")), ts)).toBe(norm(read(join(py, "status.json")), py));
    expect(norm(read(join(ts, "events.jsonl")), ts)).toBe(norm(read(join(py, "events.jsonl")), py));
    expect(read(join(ts, "events.jsonl"))).toContain('"type": "user_prompt"');
  });

  test("CCR handoff prompt clears the receiver dirty marker", () => {
    const py = freshTmp("uph-py");
    const ts = freshTmp("uph-ts");
    const sid = "recv";
    const input = { session_id: sid, prompt: "[ccr-handoff]\nCCR review result: PASS" };
    for (const r of [py, ts]) {
      mkdirSync(join(r, "sessions", sid), { recursive: true });
      writeFileSync(join(r, "sessions", sid, "dirty.json"), "{}\n");
    }
    const state = { version: 1, review_count: 0, last_diff_hash: "", active_request: null };
    const pyOut = probeJson(["handle-user-prompt", py, JSON.stringify(state), JSON.stringify(input), "codex", "codex"]);
    const tsState = JSON.parse(JSON.stringify(state));
    withEnv({ PATH: fakePath() }, () => handleUserPromptSubmit(ts, tsState, input, "codex", "codex"));

    expect(tsState).toEqual(pyOut.state);
    expect(existsSync(join(ts, "sessions", sid, "dirty.json"))).toBe(false);
    expect(existsSync(join(py, "sessions", sid, "dirty.json"))).toBe(false);
  });
});

// ===========================================================================
// handle_hook — SAFE gate paths only (cmux env unset -> never enabled).
// ===========================================================================
describe("hooks.handleHook (safe gate paths, oracle parity)", () => {
  const gateEnv = { CMUX_WORKSPACE_ID: undefined, CMUX_SURFACE_ID: undefined };
  const probeGateEnv = { CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" };

  for (const [agent, event] of [
    ["codex", "Stop"],
    ["claude", "Stop"],
    ["codex", "PreToolUse"],
    ["claude", "SessionStart"],
  ] as const) {
    test(`not-enabled ${agent}/${event} -> matches oracle`, () => {
      const input = { cwd: REPO_ROOT, session_id: "x" };
      const pyVal = probeJson(["handle-hook", agent, event, JSON.stringify(input)], probeGateEnv).value;
      const tsVal = withEnv(gateEnv, () => handleHook(agent, event, input));
      expect(tsVal ?? null).toEqual(pyVal ?? null);
    });
  }
});

// ===========================================================================
// ensure_info_exclude — idempotent .git/info/exclude append.
// ===========================================================================
describe("hooks.ensureInfoExclude (oracle parity)", () => {
  function freshRepo(label: string): string {
    const r = freshTmp(label);
    spawnSync("git", ["-C", r, "init", "-q"], { encoding: "utf-8" });
    return r;
  }
  test("appends the CCR exclude block once (idempotent) and matches oracle", () => {
    const py = freshRepo("excl-py");
    const ts = freshRepo("excl-ts");
    probe(["ensure-info-exclude", py]);
    probe(["ensure-info-exclude", py]); // idempotent
    ensureInfoExclude(ts);
    ensureInfoExclude(ts);

    const tsEx = read(join(ts, ".git", "info", "exclude"));
    const pyEx = read(join(py, ".git", "info", "exclude"));
    expect(tsEx).toBe(pyEx);
    expect(tsEx).toContain("# Added by claude-codex-review");
    expect(tsEx.match(/\.cmux\/ccr\//g)?.length).toBe(1); // only once
  });
});
