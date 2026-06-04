/**
 * phase5d.test.ts — ORACLE test for the diagnostic ccr commands (Phase 5d):
 * doctor (+ check/support/ready/selftest/uninstall as they land). Spawns BOTH
 * `ccr-hook.py --command X` and `bun src/cli.ts --command X` under identical
 * temp HOME + PATH + CMUX env, with a constructed fake install layout, and
 * compares stdout + exit code.
 *
 * The fake install lives entirely under a temp HOME (real ~/.local/bin,
 * ~/.claude, ~/.config are never touched); HOME relocates Path.home()/homedir()
 * identically in both runtimes. home/root/cwd absolute paths are normalized.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_BIN_NAMES, GENERATED_CLAUDE_COMMAND_FILES } from "../src/lib/constants.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PY = join(REPO_ROOT, "templates", "bin", "ccr-hook.py");
const TS_CLI = join(REPO_ROOT, "src", "cli.ts");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p5d-${label}-`));
  TMP.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const WID = "ws-5d";

// A dir of fake runtime tools (cmux/claude/codex) so `which` resolves them.
let TOOLS = "";
function tools(): string {
  if (!TOOLS) {
    const d = freshTmp("tools");
    for (const name of ["cmux", "claude", "codex"]) {
      const p = join(d, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    TOOLS = d;
  }
  return TOOLS;
}

/** Build a full, healthy fake install under `home`. */
function fakeInstall(home: string, opts: { enabled?: boolean; surfaces?: boolean; hooks?: boolean; commands?: boolean } = {}): string {
  const cfg = join(home, ".config", "claude-codex-review");
  mkdirSync(join(cfg, "workspaces", WID), { recursive: true });
  writeFileSync(join(cfg, "VERSION"), "9.9.9-test\n");
  if (opts.enabled) writeFileSync(join(cfg, "enabled-workspaces.txt"), WID + "\n");
  if (opts.surfaces) {
    writeFileSync(join(cfg, "workspaces", WID, "claude-surface"), "SURF_CLAUDE\n");
    writeFileSync(join(cfg, "workspaces", WID, "codex-surface"), "SURF_CODEX\n");
  }
  const binRoot = join(home, ".local", "bin");
  mkdirSync(binRoot, { recursive: true });
  for (const name of GENERATED_BIN_NAMES) {
    const p = join(binRoot, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  if (opts.hooks) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${join(binRoot, "ccr-hook-claude")} Stop` }] }] } }, null, 2) + "\n");
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: [{ event: "Stop", command: `${join(binRoot, "ccr-hook-codex")} Stop` }] }, null, 2) + "\n");
  }
  if (opts.commands) {
    const cmdRoot = join(home, ".claude", "commands");
    mkdirSync(cmdRoot, { recursive: true });
    for (const name of GENERATED_CLAUDE_COMMAND_FILES) {
      writeFileSync(join(cmdRoot, name), "# cmd\n");
    }
  }
  return binRoot;
}

function gitRepo(): string {
  const r = freshTmp("repo");
  spawnSync("git", ["-C", r, "init", "-q"], { encoding: "utf-8" });
  return r;
}

interface Case {
  args: string[];
  home: { enabled?: boolean; surfaces?: boolean; hooks?: boolean; commands?: boolean } | null; // null => bare home (no install)
  cmuxEnv?: boolean; // set CMUX_WORKSPACE_ID/SURFACE
  withTools?: boolean; // put fake cmux/claude/codex on PATH
  onPath?: boolean; // put home/.local/bin on PATH
  gitCwd?: boolean;
  noCcrRoot?: boolean; // omit CCR_ROOT so rootForCwd falls back to <cwd>/.cmux/ccr
}

function norm(s: string, home: string, root: string, cwd: string): string {
  return s
    .split(root).join("<ROOT>")
    .split(home).join("<HOME>")
    .split(cwd).join("<CWD>")
    .split(tools()).join("<TOOLS>")
    .replace(/ccr-support-\d{8}T\d{6}Z/g, "ccr-support-<STAMP>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>");
}

function runBoth(c: Case): void {
  const pyHome = freshTmp("home");
  const tsHome = freshTmp("home");
  const pyRoot = freshTmp("root");
  const tsRoot = freshTmp("root");
  const pyBin = c.home ? fakeInstall(pyHome, c.home) : join(pyHome, ".local", "bin");
  const tsBin = c.home ? fakeInstall(tsHome, c.home) : join(tsHome, ".local", "bin");
  const cwd = c.gitCwd ? gitRepo() : freshTmp("cwd");

  function env(home: string, root: string, bin: string): Record<string, string> {
    const parts: string[] = [];
    if (c.onPath) parts.push(bin);
    if (c.withTools) parts.push(tools());
    parts.push(process.env.PATH ?? "");
    const e: Record<string, string> = { HOME: home, PATH: parts.join(delimiter), PYTHONDONTWRITEBYTECODE: "1" };
    if (!c.noCcrRoot) e.CCR_ROOT = root;
    if (c.cmuxEnv) {
      e.CMUX_WORKSPACE_ID = WID;
      e.CMUX_SURFACE_ID = "SURF_CLAUDE";
    } else {
      e.CMUX_WORKSPACE_ID = "";
      e.CMUX_SURFACE_ID = "";
    }
    return e;
  }
  const py = spawnSync("python3", [PY, ...c.args], { encoding: "utf-8", cwd, env: { ...process.env, ...env(pyHome, pyRoot, pyBin) } });
  const ts = spawnSync("bun", [TS_CLI, ...c.args], { encoding: "utf-8", cwd, env: { ...process.env, ...env(tsHome, tsRoot, tsBin) } });
  if (ts.status === null) throw new Error(`ts crashed: ${ts.stderr}`);
  if (py.status === null) throw new Error(`py crashed: ${py.stderr}`);
  expect(norm(ts.stdout, tsHome, tsRoot, cwd)).toBe(norm(py.stdout, pyHome, pyRoot, cwd));
  expect(ts.status).toBe(py.status);
}

describe("command doctor (oracle parity)", () => {
  test("healthy install (text)", () => {
    runBoth({ args: ["--command", "doctor"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("healthy install (--json)", () => {
    runBoth({ args: ["--command", "doctor", "--json"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("bare home, no cmux env (degraded, text)", () => {
    runBoth({ args: ["--command", "doctor"], home: null });
  });
  test("bare home (--json, exit 1)", () => {
    runBoth({ args: ["--command", "doctor", "--json"], home: null });
  });
  test("installed but not enabled / no surfaces", () => {
    runBoth({ args: ["--command", "doctor"], home: { hooks: true }, withTools: true, onPath: true });
  });
});

describe("command ready (oracle parity)", () => {
  test("fully ready (text)", () => {
    runBoth({ args: ["--command", "ready"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("fully ready (--json)", () => {
    runBoth({ args: ["--command", "ready", "--json"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("not ready (bare home)", () => {
    runBoth({ args: ["--command", "ready"], home: null });
  });
});

describe("command selftest (oracle parity)", () => {
  // No CCR_ROOT so each case isolates under its own temp dir; output is just
  // "[PASS] name" lines + a summary (no paths/timestamps) -> exact compare.
  test("all cases pass (text)", () => {
    runBoth({ args: ["--command", "selftest"], home: null, noCcrRoot: true });
  });
  test("all cases pass (--json)", () => {
    runBoth({ args: ["--command", "selftest", "--json"], home: null, noCcrRoot: true });
  });
});

describe("command check (oracle parity)", () => {
  test("healthy rollup (text)", () => {
    runBoth({ args: ["--command", "check"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("healthy rollup (--json)", () => {
    runBoth({ args: ["--command", "check", "--json"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true, gitCwd: true });
  });
  test("degraded rollup", () => {
    runBoth({ args: ["--command", "check"], home: null });
  });
});

describe("command support (oracle parity)", () => {
  test("creates a bundle, lists contents (--print)", () => {
    runBoth({ args: ["--command", "support", "--print"], home: { enabled: true, surfaces: true, hooks: true }, cmuxEnv: true, withTools: true, onPath: true });
  });
});

describe("command uninstall (oracle parity)", () => {
  test("dry-run lists targets", () => {
    runBoth({ args: ["--command", "uninstall"], home: { hooks: true, commands: true }, onPath: true });
  });
  test("dry-run with --purge", () => {
    runBoth({ args: ["--command", "uninstall", "--purge"], home: { enabled: true, hooks: true, commands: true }, onPath: true });
  });
});
