/**
 * phase5b.test.ts — ORACLE test for the read-only ccr commands (Phase 5b):
 * status, history, events, show, report, preview, config. Spawns BOTH the Python
 * runtime (`ccr-hook.py --command X`) and the TS CLI (`bun src/cli.ts --command
 * X`) with identical cwd / env / fixture, and asserts stdout + exit-code parity.
 *
 * Same isolation as 5a: temp HOME relocates CONFIG_ROOT, CCR_ROOT points state at
 * a temp fixture, a fake `cmux` (exit 0) is on PATH. now()-derived timestamps are
 * normalized to <TS> (and active-request elapsed digits to <E>); the root path is
 * normalized to <ROOT> so commands that write under separate per-runtime roots
 * (report) still compare.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PY = join(REPO_ROOT, "templates", "bin", "ccr-hook.py");
const TS_CLI = join(REPO_ROOT, "src", "cli.ts");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p5b-${label}-`));
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

// Enabled, isolated workspace under a temp HOME (real CONFIG_ROOT untouched).
function enabledHome(): { home: string; wid: string } {
  const home = freshTmp("home");
  const wid = "ws-5b";
  const cfg = join(home, ".config", "claude-codex-review");
  mkdirSync(join(cfg, "workspaces", wid), { recursive: true });
  writeFileSync(join(cfg, "enabled-workspaces.txt"), wid + "\n");
  writeFileSync(join(cfg, "workspaces", wid, "claude-surface"), "SURF_CLAUDE\n");
  writeFileSync(join(cfg, "workspaces", wid, "codex-surface"), "SURF_CODEX\n");
  writeFileSync(join(cfg, "VERSION"), "9.9.9-test\n");
  return { home, wid };
}

// Populate a CCR_ROOT fixture (2 rounds, state/status/events) into `root`.
function buildFixture(root: string, sid: string, opts: { active?: boolean } = {}): void {
  const sdir = join(root, "sessions", sid);
  const r1 = join(sdir, "rounds", "0001");
  const r2 = join(sdir, "rounds", "0002");
  mkdirSync(r1, { recursive: true });
  mkdirSync(r2, { recursive: true });
  writeFileSync(join(sdir, "session.json"), JSON.stringify({
    version: 1, agent: "claude", role: "claude", session_id: sid, cwd: "/work/repo",
    workspace_id: "ws-5b", surface_id: "SURF_CLAUDE", transcript_path: null, model: null,
    created_at: "2026-06-03T10:00:00Z", updated_at: "2026-06-03T10:05:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(r1, "decision.json"), JSON.stringify({
    decision: "NEEDS_CHANGES", reviewer: "codex", worker: "claude", round: 1,
    review_file: join(r1, "review.md"), must_fix_count: 2, updated_at: "2026-06-03T10:01:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(r1, "review.md"), "REVIEW_DECISION: NEEDS_CHANGES\n\n## Must Fix\n- `x.ts:1` bad\n- `x.ts:2` worse\n");
  writeFileSync(join(r1, "request.md"), "# CCR Review Request\n\nstuff\n");
  writeFileSync(join(r1, "diff.patch"), "diff --git a/src/x.ts b/src/x.ts\n@@\n+added\n-removed\n");
  writeFileSync(join(r2, "decision.json"), JSON.stringify({
    decision: "PASS", reviewer: "codex", worker: "claude", round: 2, review_file: join(r2, "review.md"),
    must_fix_count: 0, updated_at: "2026-06-03T10:04:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(r2, "review.md"), "REVIEW_DECISION: PASS\n\n## Verdict\n- ok\n");
  writeFileSync(join(r2, "diff.patch"), "diff --git a/src/y.ts b/src/y.ts\n@@\n+ok\n");
  writeFileSync(join(r2, "delta.patch"), "--- a\n+++ b\n");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    version: 1, review_count: 2, last_diff_hash: "",
    active_request: opts.active
      ? { round: 3, worker: "claude", reviewer: "codex", worker_session_id: sid, worker_surface: "SURF_CLAUDE", reviewer_surface: "SURF_CODEX", request_file: join(root, "r.md"), diff_file: join(root, "d.patch"), diff_hash: "abc", created_at: "2000-01-01T00:00:00Z" }
      : null,
    last_completed: { round: 2, decision: "PASS", at: "2026-06-03T10:04:00Z" },
  }, null, 2) + "\n");
  writeFileSync(join(root, "status.json"), JSON.stringify({
    status: "passed", reason: "round 2", updated_at: "2026-06-03T10:04:00Z",
    review_count: 2, active_request: null,
    last_completed: { round: 2, decision: "PASS", at: "2026-06-03T10:04:00Z" },
    last_report: { path: join(sdir, "report.md"), outcome: "passed", at: "2026-06-03T10:04:30Z", summary: "Outcome: passed after 2 round(s)." },
  }, null, 2) + "\n");
  writeFileSync(join(root, "events.jsonl"),
    JSON.stringify({ at: "2026-06-03T10:00:30Z", type: "user_prompt", agent: "claude", role: "claude", session_id: sid, prev_review_count: 0 }) + "\n" +
    JSON.stringify({ at: "2026-06-03T10:02:30Z", type: "skipped", reason: "ccr-skip-next", session_id: sid }) + "\n");
}

function runPy(args: string[], cwd: string, env: Record<string, string>, input = "") {
  return spawnSync("python3", [PY, ...args], {
    encoding: "utf-8", cwd, input,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: fakePath(), ...env },
  });
}
function runTs(args: string[], cwd: string, env: Record<string, string>, input = "") {
  return spawnSync("bun", [TS_CLI, ...args], {
    encoding: "utf-8", cwd, input,
    env: { ...process.env, PATH: fakePath(), ...env },
  });
}
function norm(s: string, root: string): string {
  return s
    .split(root).join("<ROOT>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>")
    .replace(/elapsed=\d+s/g, "elapsed=<E>s")
    .replace(/is \d+s old/g, "is <E>s old")
    // report.md duration is now()-derived; can differ by <=1s between the two
    // independently-timed runtime invocations.
    .replace(/\| duration \| [^|]*\|/g, "| duration | <DUR> |");
}

/** Read-only command on a SHARED fixture root: assert stdout + exit parity. */
function expectParityShared(
  args: string[],
  build: (root: string) => void,
  envExtra: (home: string, wid: string) => Record<string, string>,
  cwd?: string,
): string {
  const { home, wid } = enabledHome();
  const root = freshTmp("root");
  build(root);
  const env = { HOME: home, CCR_ROOT: root, ...envExtra(home, wid) };
  const useCwd = cwd ?? root;
  const py = runPy(args, useCwd, env);
  const ts = runTs(args, useCwd, env);
  if (ts.status === null) throw new Error(`ts crashed: ${ts.stderr}`);
  if (py.status === null) throw new Error(`py crashed: ${py.stderr}`);
  expect(norm(ts.stdout, root)).toBe(norm(py.stdout, root));
  expect(ts.status).toBe(py.status);
  return ts.stdout;
}

const enabledEnv = (_home: string, wid: string) => ({ CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CLAUDE" });

describe("command status (oracle parity)", () => {
  test("populated state", () => {
    const out = expectParityShared(["--command", "status"], (r) => buildFixture(r, "sess-A"), enabledEnv);
    expect(out).toContain("Enabled: yes");
    expect(out).toContain("Review count: 2");
  });
  test("with a stale active request (elapsed + hint)", () => {
    const out = expectParityShared(["--command", "status"], (r) => buildFixture(r, "sess-A", { active: true }), enabledEnv);
    expect(out).toContain("Active request: r3 claude->codex");
    expect(out).toContain("Hint: active request is");
  });
  test("empty root", () => {
    expectParityShared(["--command", "status"], () => {}, enabledEnv);
  });
});

describe("command history (oracle parity)", () => {
  test("two rounds, most recent first", () => {
    const out = expectParityShared(["--command", "history"], (r) => buildFixture(r, "sess-A"), enabledEnv);
    expect(out).toContain("NEEDS_CHANGES");
    expect(out).toContain("PASS");
  });
  test("--limit 1", () => {
    expectParityShared(["--command", "history", "--limit", "1"], (r) => buildFixture(r, "sess-A"), enabledEnv);
  });
  test("no sessions", () => {
    const out = expectParityShared(["--command", "history"], () => {}, enabledEnv);
    expect(out).toBe("No sessions yet.\n");
  });
});

describe("command events (oracle parity)", () => {
  test("table form", () => {
    expectParityShared(["--command", "events"], (r) => buildFixture(r, "sess-A"), enabledEnv);
  });
  test("--json form", () => {
    const out = expectParityShared(["--command", "events", "--json"], (r) => buildFixture(r, "sess-A"), enabledEnv);
    expect(out).toContain('"events": [');
  });
  test("no events", () => {
    expectParityShared(["--command", "events"], () => {}, enabledEnv);
  });
});

describe("command show (oracle parity)", () => {
  test("latest session + round", () => {
    expectParityShared(["--command", "show", "--session", "sess-A"], (r) => buildFixture(r, "sess-A"), enabledEnv);
  });
  test("--round 1", () => {
    expectParityShared(["--command", "show", "--session", "sess-A", "--round", "1"], (r) => buildFixture(r, "sess-A"), enabledEnv);
  });
  test("--review dumps review.md raw", () => {
    const out = expectParityShared(["--command", "show", "--session", "sess-A", "--round", "2", "--review"], (r) => buildFixture(r, "sess-A"), enabledEnv);
    expect(out).toBe("REVIEW_DECISION: PASS\n\n## Verdict\n- ok\n");
  });
  test("missing session -> stderr + exit 1", () => {
    expectParityShared(["--command", "show", "--session", "nope"], (r) => buildFixture(r, "sess-A"), enabledEnv);
  });
});

describe("command config (oracle parity)", () => {
  test("text form", () => {
    const fixedCwd = freshTmp("cwd");
    const out = expectParityShared(["--command", "config"], () => {}, enabledEnv, fixedCwd);
    expect(out).toContain("CCR Config");
    expect(out).toContain("CCR_MAX_ROUNDS=3");
  });
  test("--json form", () => {
    const fixedCwd = freshTmp("cwd");
    const out = expectParityShared(["--command", "config", "--json"], () => {}, enabledEnv, fixedCwd);
    expect(out).toContain('"runtime_commands"');
  });
});

describe("command preview (oracle parity)", () => {
  // preview reads the git diff at cwd; use a shared temp repo with a change.
  let REPO = "";
  function repo(): string {
    if (!REPO) {
      const r = freshTmp("repo");
      const run = (...a: string[]) => spawnSync("git", ["-C", r, ...a], { encoding: "utf-8" });
      run("init", "-q");
      run("config", "user.email", "t@t");
      run("config", "user.name", "t");
      writeFileSync(join(r, "a.ts"), "export const a = 1;\n");
      run("add", "a.ts");
      run("commit", "-q", "-m", "init");
      writeFileSync(join(r, "a.ts"), "export const a = 2;\n");
      REPO = r;
    }
    return REPO;
  }
  test("eligible diff (text)", () => {
    const out = expectParityShared(["--command", "preview"], () => {}, enabledEnv, repo());
    expect(out).toContain("CCR Review Preview");
  });
  test("eligible diff (--json)", () => {
    expectParityShared(["--command", "preview", "--json"], () => {}, enabledEnv, repo());
  });
});

describe("command report (oracle parity, separate roots)", () => {
  test("generates a report and prints its path", () => {
    const { home, wid } = enabledHome();
    const py = freshTmp("rep-py");
    const ts = freshTmp("rep-ts");
    buildFixture(py, "sess-A");
    buildFixture(ts, "sess-A");
    const env = (root: string) => ({ HOME: home, CCR_ROOT: root, CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CLAUDE" });
    const pyRes = runPy(["--command", "report", "--session", "sess-A", "--print"], py, env(py));
    const tsRes = runTs(["--command", "report", "--session", "sess-A", "--print"], ts, env(ts));
    expect(norm(tsRes.stdout, ts)).toBe(norm(pyRes.stdout, py));
    expect(tsRes.status ?? -1).toBe(pyRes.status ?? -1);
    expect(norm(tsRes.stdout, ts)).toContain("<ROOT>/sessions/sess-A/report.md");
  });
});
