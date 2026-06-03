/**
 * phase5e.test.ts — verify the bundled CLI (scripts/build-cli.ts → ccr-cli.js)
 * is behavior-identical to the source entrypoint (`bun src/cli.ts`). The Python
 * oracle parity of the underlying logic is already covered by phase5a/5b/5c; this
 * proves bundling does not change behavior (no missing module, no import/runtime
 * resolution drift), so the 5f cutover can ship the single bundle safely.
 *
 * For each invocation, `bun src/cli.ts ARGS` and `bun <bundle> ARGS` are run with
 * identical cwd / env / stdin; stdout + exit code must match exactly (no
 * normalization — both execute the same code, so output is byte-identical).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const TS_CLI = join(REPO_ROOT, "src", "cli.ts");
const BUILD = join(REPO_ROOT, "scripts", "build-cli.ts");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p5e-${label}-`));
  TMP.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

let FAKE_BIN = "";
function fakePath(): string {
  if (!FAKE_BIN) {
    const bin = freshTmp("bin");
    const c = join(bin, "cmux");
    writeFileSync(c, "#!/bin/sh\nexit 0\n");
    chmodSync(c, 0o755);
    FAKE_BIN = bin;
  }
  return `${FAKE_BIN}${delimiter}${process.env.PATH ?? ""}`;
}

let BUNDLE = "";
beforeAll(() => {
  BUNDLE = join(freshTmp("out"), "ccr-cli.js");
  const built = spawnSync("bun", [BUILD, BUNDLE], { encoding: "utf-8", cwd: REPO_ROOT });
  if (built.status !== 0) {
    throw new Error(`build-cli failed (${built.status}):\n${built.stdout}\n${built.stderr}`);
  }
});

function runSrc(args: string[], cwd: string, env: Record<string, string>, input = "") {
  return spawnSync("bun", [TS_CLI, ...args], { encoding: "utf-8", cwd, input, env: { ...process.env, PATH: fakePath(), ...env } });
}
function runBundle(args: string[], cwd: string, env: Record<string, string>, input = "") {
  return spawnSync("bun", [BUNDLE, ...args], { encoding: "utf-8", cwd, input, env: { ...process.env, PATH: fakePath(), ...env } });
}
function expectSame(args: string[], cwd: string, env: Record<string, string>, input = ""): string {
  const a = runSrc(args, cwd, env, input);
  const b = runBundle(args, cwd, env, input);
  if (a.status === null) throw new Error(`src crashed: ${a.stderr}`);
  if (b.status === null) throw new Error(`bundle crashed: ${b.stderr}`);
  expect(b.stdout).toBe(a.stdout);
  expect(b.status).toBe(a.status);
  return b.stdout;
}

function enabledHome(): { home: string; wid: string } {
  const home = freshTmp("home");
  const wid = "ws-5e";
  const cfg = join(home, ".config", "claude-codex-review");
  mkdirSync(join(cfg, "workspaces", wid), { recursive: true });
  writeFileSync(join(cfg, "enabled-workspaces.txt"), wid + "\n");
  writeFileSync(join(cfg, "workspaces", wid, "claude-surface"), "SURF_CLAUDE\n");
  writeFileSync(join(cfg, "workspaces", wid, "codex-surface"), "SURF_CODEX\n");
  writeFileSync(join(cfg, "VERSION"), "9.9.9-test\n");
  return { home, wid };
}

describe("bundled cli == source cli (behavior parity)", () => {
  test("config --json", () => {
    const home = freshTmp("home");
    const out = expectSame(["--command", "config", "--json"], REPO_ROOT, { HOME: home, CCR_ROOT: freshTmp("root") });
    expect(out).toContain('"runtime_commands"');
  });

  test("status on empty root", () => {
    const home = freshTmp("home");
    expectSame(["--command", "status"], freshTmp("cwd"), { HOME: home, CCR_ROOT: freshTmp("root"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" });
  });

  test("history with no sessions", () => {
    const out = expectSame(["--command", "history"], freshTmp("cwd"), { HOME: freshTmp("home"), CCR_ROOT: freshTmp("root") });
    expect(out).toBe("No sessions yet.\n");
  });

  test("not-yet-ported command exits the same (2 / stderr)", () => {
    // doctor (5d) throws in both -> bun reports an uncaught error + nonzero exit.
    const a = runSrc(["--command", "doctor"], freshTmp("cwd"), { HOME: freshTmp("home"), CCR_ROOT: freshTmp("root") });
    const b = runBundle(["--command", "doctor"], freshTmp("cwd"), { HOME: freshTmp("home"), CCR_ROOT: freshTmp("root") });
    expect(b.status).toBe(a.status);
    expect(a.status).not.toBe(0);
  });

  test("hook gate: not-enabled codex/Stop -> '{}'", () => {
    const out = expectSame(["--agent", "codex", "--event", "Stop"], REPO_ROOT, { HOME: freshTmp("home"), CCR_ROOT: freshTmp("root"), CMUX_WORKSPACE_ID: "", CMUX_SURFACE_ID: "" }, "{}");
    expect(out).toBe("{}\n");
  });

  test("hook enabled PreToolUse block -> identical serialized deny", () => {
    const { home, wid } = enabledHome();
    const root = freshTmp("root");
    writeFileSync(join(root, "state.json"), JSON.stringify({
      version: 1, review_count: 1, last_diff_hash: "",
      active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "w", worker_surface: "S", reviewer_surface: "S2", request_file: "/r/req.md", diff_file: "/r/d.patch", diff_hash: "h", created_at: "2026-06-03T10:00:00Z" },
      last_completed: null,
    }) + "\n");
    const env = { HOME: home, CCR_ROOT: root, CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "SURF_CODEX" };
    const input = JSON.stringify({ session_id: "rev", cwd: REPO_ROOT, tool_name: "Edit" });
    const out = expectSame(["--agent", "codex", "--event", "PreToolUse"], REPO_ROOT, env, input);
    expect(out).toContain('"permissionDecision": "deny"');
  });
});
