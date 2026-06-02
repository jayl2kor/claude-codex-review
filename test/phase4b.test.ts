/**
 * phase4b.test.ts — tests for the cmux surface/role layer (src/lib/cmux.ts).
 *
 * NOTE on the subprocess layer: Bun's spawnSync resolves a bare command name
 * against the PATH captured at process start, so a runtime PATH override cannot
 * substitute a fake `cmux`, and `cmux` is actually installed on this machine.
 * To avoid invoking the REAL cmux (which has side effects), sendToSurface is
 * only exercised on its no-spawn guard (empty surface -> false); the spawn/exit
 * branches are a thin faithful port verified by review.
 *
 * - role/surface resolution is FS+env driven; it is oracle-compared against the
 *   Python runtime using an ISOLATED, uniquely-named workspace dir created under
 *   the real CONFIG_ROOT and removed afterwards (other workspaces untouched).
 * - workspace_enabled is only exercised on its SAFE false paths (a random wid not
 *   listed / no wid), so the shared real ENABLED_FILE is never modified.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sendToSurface,
  roleForCurrentSurface,
  surfaceForRole,
  workspaceEnabled,
} from "../src/lib/cmux.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "phase3-probe.py");
const CONFIG_ROOT = join(homedir(), ".config", "claude-codex-review");

const CLEANUP: string[] = [];
afterAll(() => {
  for (const d of CLEANUP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

// ===========================================================================
// send_to_surface — only the no-spawn guard is exercised (see header note).
// ===========================================================================
describe("cmux.sendToSurface", () => {
  test("empty surface -> false (no spawn, no real cmux invoked)", () => {
    expect(sendToSurface("", "hi")).toBe(false);
  });
});

// ===========================================================================
// role / surface resolution (oracle parity, isolated workspace under CONFIG_ROOT)
// ===========================================================================
describe("cmux role/surface resolution", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function probeValue(args: string[], env: Record<string, string>): any {
    const proc = spawnSync("python3", [PROBE, ...args], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    });
    if (proc.status !== 0) {
      throw new Error(`probe ${args[0]} exited ${proc.status}\n${proc.stdout}\n${proc.stderr}`);
    }
    return (JSON.parse(proc.stdout.trim()) as { value: unknown }).value;
  }

  // Unique workspace id so we only ever create/remove our own subdir.
  const wid = `ccr-test-${process.pid}-${Date.now()}`;
  const wsDir = join(CONFIG_ROOT, "workspaces", wid);

  function setup(claudeSurface: string, codexSurface: string): void {
    mkdirSync(wsDir, { recursive: true });
    CLEANUP.push(wsDir);
    writeFileSync(join(wsDir, "claude-surface"), claudeSurface + "\n");
    writeFileSync(join(wsDir, "codex-surface"), codexSurface + "\n");
  }

  test("role_for_current_surface matches oracle (claude / codex / unknown)", () => {
    setup("SURF_CLAUDE", "SURF_CODEX");
    for (const [surf, expected] of [
      ["SURF_CLAUDE", "claude"],
      ["SURF_CODEX", "codex"],
      ["SURF_OTHER", "unknown"],
    ] as const) {
      const env = { CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: surf };
      const ts = withEnv(env, () => roleForCurrentSurface());
      const py = probeValue(["role-for-surface"], env);
      expect(ts).toBe(py);
      expect(ts).toBe(expected);
    }
  });

  test("role_for_current_surface -> unknown with no surface id", () => {
    const env = { CMUX_WORKSPACE_ID: wid, CMUX_SURFACE_ID: "" };
    expect(withEnv(env, () => roleForCurrentSurface())).toBe("unknown");
    expect(probeValue(["role-for-surface"], env)).toBe("unknown");
  });

  test("surface_for_role matches oracle", () => {
    setup("SURF_CLAUDE", "SURF_CODEX");
    const env = { CMUX_WORKSPACE_ID: wid };
    for (const role of ["claude", "codex"] as const) {
      const ts = withEnv(env, () => surfaceForRole(role));
      const py = probeValue(["surface-for-role", role], env);
      expect(ts).toBe(py);
    }
    expect(withEnv(env, () => surfaceForRole("claude"))).toBe("SURF_CLAUDE");
  });
});

// ===========================================================================
// workspace_enabled (safe false paths only — never touch the real ENABLED_FILE)
// ===========================================================================
describe("cmux.workspaceEnabled (safe paths)", () => {
  function probeBool(env: Record<string, string>): boolean {
    const proc = spawnSync("python3", [PROBE, "workspace-enabled"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    });
    if (proc.status !== 0) throw new Error(`probe exited ${proc.status}: ${proc.stderr}`);
    return (JSON.parse(proc.stdout.trim()) as { value: boolean }).value;
  }

  test("no workspace id -> false", () => {
    const env = { CMUX_WORKSPACE_ID: "" };
    expect(withEnv(env, () => workspaceEnabled())).toBe(false);
    expect(probeBool(env)).toBe(false);
  });

  test("a workspace id not listed in ENABLED_FILE -> false (file unmodified)", () => {
    const env = { CMUX_WORKSPACE_ID: `not-enabled-${process.pid}-${Date.now()}` };
    expect(withEnv(env, () => workspaceEnabled())).toBe(false);
    expect(probeBool(env)).toBe(false);
  });
});
