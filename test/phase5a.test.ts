/**
 * phase5a.test.ts — ORACLE test for the hook ENTRYPOINT + byte-exact hook stdout
 * (Phase 5a, risk 7). Spawns BOTH the Python runtime (templates/bin/ccr-hook.py)
 * and the TS CLI (`bun src/cli.ts`) as subprocesses with IDENTICAL stdin + env,
 * and asserts stdout bytes + exit code match.
 *
 * The subprocess+HOME strategy is the parity keystone: HOME is pointed at a temp
 * dir so CONFIG_ROOT ($HOME/.config/claude-codex-review) relocates identically in
 * both runtimes (the real shared ENABLED_FILE is never touched), and CCR_ROOT is
 * a temp dir so locked state writes nowhere real. A fake `cmux` (exit 0) on PATH
 * keeps cmux side effects deterministic no-ops in both.
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
  const d = mkdtempSync(join(tmpdir(), `ccr-p5a-${label}-`));
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

function runPy(args: string[], env: Record<string, string>, input: string) {
  return spawnSync("python3", [PY, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    input,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: fakePath(), ...env },
  });
}
function runTs(args: string[], env: Record<string, string>, input: string) {
  return spawnSync("bun", [TS_CLI, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    input,
    env: { ...process.env, PATH: fakePath(), ...env },
  });
}

/** Run both runtimes with identical args/env/stdin; assert stdout + exit parity. */
function expectParity(args: string[], env: Record<string, string>, input: string): string {
  const py = runPy(args, env, input);
  const ts = runTs(args, env, input);
  if (py.status !== 0) throw new Error(`py exited ${py.status}: ${py.stderr}`);
  if (ts.status !== 0) throw new Error(`ts exited ${ts.status}: ${ts.stderr}\n${ts.stdout}`);
  expect(ts.stdout).toBe(py.stdout);
  expect(ts.status).toBe(py.status);
  return ts.stdout;
}

// Isolated, ENABLED workspace under a temp HOME (real CONFIG_ROOT untouched).
function enabledHome(): { home: string; wid: string } {
  const home = freshTmp("home");
  const wid = "ws-5a";
  const cfg = join(home, ".config", "claude-codex-review");
  mkdirSync(join(cfg, "workspaces", wid), { recursive: true });
  writeFileSync(join(cfg, "enabled-workspaces.txt"), wid + "\n");
  writeFileSync(join(cfg, "workspaces", wid, "claude-surface"), "SURF_CLAUDE\n");
  writeFileSync(join(cfg, "workspaces", wid, "codex-surface"), "SURF_CODEX\n");
  return { home, wid };
}

function seedActiveRequest(reviewer: string): string {
  const root = freshTmp("root");
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({
      version: 1,
      review_count: 1,
      last_diff_hash: "",
      active_request: {
        round: 1, worker: reviewer === "codex" ? "claude" : "codex", reviewer,
        worker_session_id: "w", worker_surface: "S", reviewer_surface: "S2",
        request_file: "/r/req.md", diff_file: "/r/d.patch", diff_hash: "h",
        created_at: "2026-06-03T10:00:00Z",
      },
      last_completed: null,
    }) + "\n",
  );
  return root;
}

// ===========================================================================
// Gate paths (not enabled): the only output is the codex/Stop "{}" sentinel.
// ===========================================================================
describe("cli hook gate paths (oracle stdout parity)", () => {
  test("not-enabled codex/Stop -> prints {}", () => {
    const home = freshTmp("home-gate");
    const env = { HOME: home, CCR_ROOT: freshTmp("root-gate"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" };
    const out = expectParity(["--agent", "codex", "--event", "Stop"], env, "{}");
    expect(out).toBe("{}\n");
  });

  test("not-enabled claude/Stop -> no output", () => {
    const home = freshTmp("home-gate2");
    const env = { HOME: home, CCR_ROOT: freshTmp("root-gate2"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" };
    const out = expectParity(["--agent", "claude", "--event", "Stop"], env, "{}");
    expect(out).toBe("");
  });

  test("not-enabled codex/PreToolUse -> no output", () => {
    const env = { HOME: freshTmp("home-gate3"), CCR_ROOT: freshTmp("root-gate3"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" };
    expect(expectParity(["--agent", "codex", "--event", "PreToolUse"], env, "{}")).toBe("");
  });

  test("missing agent -> exit 0, no output", () => {
    const env = { HOME: freshTmp("home-gate4"), CCR_ROOT: freshTmp("root-gate4") };
    expect(expectParity(["--event", "Stop"], env, "{}")).toBe("");
  });

  test("event from stdin hook_event_name when --event absent", () => {
    const env = { HOME: freshTmp("home-gate5"), CCR_ROOT: freshTmp("root-gate5"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" };
    expect(expectParity(["--agent", "codex"], env, JSON.stringify({ hook_event_name: "Stop" }))).toBe("{}\n");
  });
});

// ===========================================================================
// Enabled PreToolUse block — exercises the real serializer on a NESTED object
// (codex deny shape) and a flat object (claude block shape).
// ===========================================================================
describe("cli enabled PreToolUse block (oracle stdout parity)", () => {
  test("codex reviewer blocks Edit -> nested deny shape, byte-identical", () => {
    const { home, wid } = enabledHome();
    const root = seedActiveRequest("codex");
    const env = { HOME: home, CCR_ROOT: root, CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CODEX" };
    const input = JSON.stringify({ session_id: "rev", cwd: REPO_ROOT, tool_name: "Edit" });
    const out = expectParity(["--agent", "codex", "--event", "PreToolUse"], env, input);
    expect(out).toContain('"permissionDecision": "deny"');
    expect(out.endsWith("\n")).toBe(true);
  });

  test("claude reviewer blocks Edit -> flat block shape, byte-identical", () => {
    const { home, wid } = enabledHome();
    const root = seedActiveRequest("claude");
    const env = { HOME: home, CCR_ROOT: root, CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CLAUDE" };
    const input = JSON.stringify({ session_id: "rev", cwd: REPO_ROOT, tool_name: "Edit" });
    const out = expectParity(["--agent", "claude", "--event", "PreToolUse"], env, input);
    expect(out).toBe('{"decision": "block", "reason": "CCR reviewer-only mode is active. Review the request file without modifying files."}\n');
  });

  test("enabled reviewer non-mutating tool -> no block, no output", () => {
    const { home, wid } = enabledHome();
    const root = seedActiveRequest("codex");
    const env = { HOME: home, CCR_ROOT: root, CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CODEX" };
    const input = JSON.stringify({ session_id: "rev", cwd: REPO_ROOT, tool_name: "Read" });
    expect(expectParity(["--agent", "codex", "--event", "PreToolUse"], env, input)).toBe("");
  });
});
