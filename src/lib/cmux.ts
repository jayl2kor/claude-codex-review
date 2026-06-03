/**
 * cmux.ts — cmux CLI / surface / role layer, Phase 4b of the Python->Bun
 * migration (ccr-hook.py).
 *
 * Ported from ccr-hook.py: cmux (463-467), cmux_log (470-471), cmux_status
 * (474-475), cmux_notify (478-482), send_to_surface (488-497),
 * role_for_current_surface (177-185), surface_for_role (188-189),
 * workspace_enabled (192-196).
 *
 * The cmux invocations shell out to the `cmux` CLI (best-effort: a missing
 * binary or non-zero exit is swallowed exactly as Python's
 * subprocess.run(check=False) / FileNotFoundError handling). The surface/role/
 * enabled helpers are env- and FS-driven and are oracle-tested.
 *
 * Zero npm deps — node:child_process / node:fs + lib modules only.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { join, delimiter } from "node:path";

import { readText } from "./io";
import { splitlines } from "./pycompat";
import { surfaceId, workspaceId, workspaceConfigDir, ENABLED_FILE } from "./paths";
import { CCR_HANDOFF_SENTINEL } from "./constants";

/**
 * Resolve the `cmux` binary by scanning the CURRENT PATH for an executable.
 * Bun's spawnSync resolves a bare command name against the PATH captured at
 * process start, ignoring a runtime-mutated process.env.PATH; doing the lookup
 * explicitly honors the live PATH (matching Python's subprocess.run, which
 * execvp's against the current env) so a fake `cmux` can be substituted in
 * tests. Falls back to "cmux" so spawnSync still ENOENTs if it is truly absent.
 */
function resolveCmuxBin(): string {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, "cmux");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not executable here */
    }
  }
  return "cmux";
}

/**
 * Python `cmux` (463-467): run `cmux <args...>`, discard output, never raise
 * (a missing `cmux` binary is ignored). spawnSync reports ENOENT via proc.error
 * rather than throwing, so this naturally swallows it.
 */
export function cmux(...args: string[]): void {
  spawnSync(resolveCmuxBin(), args, { stdio: ["ignore", "ignore", "ignore"] });
}

/** Python `cmux_log` (470-471). */
export function cmuxLog(level: string, message: string): void {
  cmux("log", "--source", "ccr", "--level", level, "--", message);
}

/** Python `cmux_status` (474-475). */
export function cmuxStatus(value: string, color: string = "#0A84FF"): void {
  cmux("set-status", "ccr", value, "--icon", "git-pull-request", "--color", color, "--priority", "80");
}

/** Python `cmux_notify` (478-482). */
export function cmuxNotify(title: string, body: string, surface: string = ""): void {
  const args = ["notify", "--title", title, "--body", body];
  if (surface) {
    args.push("--surface", surface);
  }
  cmux(...args);
}

/**
 * Python `send_to_surface` (488-497): send a `[ccr-handoff]`-prefixed message to
 * a surface, then an Enter key. Returns false on missing binary / non-zero exit
 * (mirrors check=True + FileNotFoundError/CalledProcessError handling).
 */
export function sendToSurface(surface: string, message: string): boolean {
  if (!surface) {
    return false;
  }
  const wrapped = `${CCR_HANDOFF_SENTINEL}\n${message}`;
  const bin = resolveCmuxBin();
  const send = spawnSync(bin, ["send", "--surface", surface, wrapped], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (send.error || send.status !== 0) {
    return false;
  }
  const enter = spawnSync(bin, ["send-key", "--surface", surface, "enter"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (enter.error || enter.status !== 0) {
    return false;
  }
  return true;
}

/** Python `role_for_current_surface` (177-185). */
export function roleForCurrentSurface(): string {
  const current = surfaceId();
  if (!current) {
    return "unknown";
  }
  if (readText(join(workspaceConfigDir(), "claude-surface")) === current) {
    return "claude";
  }
  if (readText(join(workspaceConfigDir(), "codex-surface")) === current) {
    return "codex";
  }
  return "unknown";
}

/** Python `surface_for_role` (188-189). */
export function surfaceForRole(role: string): string {
  return readText(join(workspaceConfigDir(), `${role}-surface`));
}

/** Python `workspace_enabled` (192-196): workspace id present AND listed in ENABLED_FILE. */
export function workspaceEnabled(): boolean {
  const wid = workspaceId();
  if (!wid || !existsSync(ENABLED_FILE)) {
    return false;
  }
  return splitlines(readFileSync(ENABLED_FILE, "utf-8")).includes(wid);
}
