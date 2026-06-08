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
import { existsSync, readFileSync, accessSync, statSync, mkdirSync, constants as fsConstants } from "node:fs";
import { join, delimiter } from "node:path";

import { readText, writeFileAtomic } from "./io";
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
// Cache keyed on the PATH string: the same process makes several cmux calls
// (log/status/notify/send) and rescanning PATH each time is wasteful. On a hit
// we re-validate the cached path (it may have been removed/replaced), but we do
// NOT rescan while the PATH string is unchanged — so a freshly installed cmux
// shadowing an earlier dir won't be picked up mid-process. That's acceptable
// for this short-lived CLI; any PATH mutation (incl. test substitution that
// changes PATH) invalidates the cache and triggers a full rescan.
let cachedCmuxPathEnv: string | null = null;
let cachedCmuxBin: string | null = null;

function resolveCmuxBin(): string {
  const pathEnv = process.env.PATH ?? "";
  if (cachedCmuxPathEnv === pathEnv && cachedCmuxBin !== null) {
    try {
      if (statSync(cachedCmuxBin).isDirectory()) {
        throw new Error("cached cmux path is a directory");
      }
      accessSync(cachedCmuxBin, fsConstants.X_OK);
      return cachedCmuxBin;
    } catch {
      cachedCmuxPathEnv = null;
      cachedCmuxBin = null;
    }
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, "cmux");
    try {
      if (statSync(candidate).isDirectory()) {
        continue;
      }
      accessSync(candidate, fsConstants.X_OK);
      cachedCmuxPathEnv = pathEnv;
      cachedCmuxBin = candidate;
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

/**
 * Parse `caller.surface_id` / `caller.workspace_id` out of `cmux identify
 * --id-format uuids` JSON. Pure (unit-tested). The `caller` block is the surface
 * that actually invoked cmux — authoritative even when the CMUX_SURFACE_ID env
 * var is stale (e.g. inherited unchanged by a split pane or a resumed surface).
 */
export function parseIdentifyCaller(stdout: string): { surface: string; workspace: string } | null {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const caller = data?.caller as Record<string, unknown> | undefined;
    const surface = typeof caller?.surface_id === "string" ? caller.surface_id : "";
    const workspace = typeof caller?.workspace_id === "string" ? caller.workspace_id : "";
    return surface ? { surface, workspace } : null;
  } catch {
    return null;
  }
}

// cmux identify is stable for a process's lifetime; cache it. `undefined` = not
// yet attempted, `null` = attempted and unavailable (cmux missing / not a surface).
let cachedIdentify: { surface: string; workspace: string } | null | undefined;

function cmuxIdentifyCaller(): { surface: string; workspace: string } | null {
  if (cachedIdentify !== undefined) {
    return cachedIdentify;
  }
  const res = spawnSync(resolveCmuxBin(), ["identify", "--id-format", "uuids"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  });
  cachedIdentify = res.error || res.status !== 0 || typeof res.stdout !== "string"
    ? null
    : parseIdentifyCaller(res.stdout);
  return cachedIdentify;
}

/**
 * Authoritative current surface id: cmux's `caller` view, which is robust to a
 * stale CMUX_SURFACE_ID env var (the root cause of "cmux-setup-* registered but
 * the surface isn't recognized"). Falls back to the env var when cmux can't be
 * reached (e.g. a sandboxed model command, or outside cmux).
 */
export function currentSurfaceId(): string {
  return cmuxIdentifyCaller()?.surface || surfaceId();
}

/** Test seam: reset the cached `cmux identify` result. */
export function resetIdentifyCache(): void {
  cachedIdentify = undefined;
}

/** Python `role_for_current_surface` (177-185). */
export function roleForCurrentSurface(): string {
  const current = currentSurfaceId();
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

/** Path to the role->surface registration file (e.g. `<wsdir>/claude-surface`). */
function surfaceFile(role: string): string {
  return join(workspaceConfigDir(), `${role}-surface`);
}

/** Python `surface_for_role` (188-189). */
export function surfaceForRole(role: string): string {
  return readText(surfaceFile(role));
}

/**
 * Register `surface` as the given role's surface. Atomic, with the trailing
 * newline the bash setup scripts write (readText strips it on read, so role
 * detection stays consistent). Creates the workspace config dir if absent.
 */
export function registerSurface(role: string, surface: string): void {
  mkdirSync(workspaceConfigDir(), { recursive: true });
  writeFileAtomic(surfaceFile(role), surface + "\n");
}

/**
 * The set of live surface UUIDs (uppercased) in the CURRENT cmux workspace,
 * parsed from `cmux list-pane-surfaces --id-format both`. Both CCR agents share
 * one workspace (their registration files live under the same workspace dir), so
 * this enumerates both surfaces. Returns null — not an empty set — whenever the
 * lookup is unavailable (no workspace id, cmux missing, non-zero exit, or no
 * UUID parsed) so callers can tell "known dead" apart from "couldn't verify" and
 * never reclaim a registration they merely failed to confirm.
 */
export function liveSurfaceIds(): Set<string> | null {
  const wid = workspaceId();
  if (!wid) {
    return null;
  }
  const res = spawnSync(resolveCmuxBin(), ["list-pane-surfaces", "--workspace", wid, "--id-format", "both"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") {
    return null;
  }
  const ids = new Set<string>();
  const re = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
  for (const m of res.stdout.matchAll(re)) {
    ids.add(m[0].toUpperCase());
  }
  return ids.size > 0 ? ids : null;
}

/** True iff `id` is among `live`; null when liveness is unknown (`live` is null). "" is dead. */
export function isSurfaceLive(id: string, live: Set<string> | null): boolean | null {
  if (!id) {
    return false;
  }
  if (live === null) {
    return null;
  }
  return live.has(id.toUpperCase());
}

export type PairingAction =
  | "noop"            // current already registered for this role
  | "register-unset"  // role had no registration; claim current
  | "repair-dead"     // role's registered surface is gone; re-pair to current
  | "refuse-live"     // a different, still-live surface owns the role; don't steal
  | "unknown-liveness"; // couldn't verify the registered surface; leave it alone

/**
 * Pure pairing decision (no IO — unit-tested). Given this session's live surface
 * id, the role's currently registered id, and whether that registered id is live
 * (null = couldn't verify), decide what to do. See {@link healPairing}.
 */
export function decidePairing(current: string, registered: string, regAlive: boolean | null): PairingAction {
  if (!current || registered === current) {
    return "noop";
  }
  if (!registered) {
    return "register-unset";
  }
  if (regAlive === false) {
    return "repair-dead";
  }
  if (regAlive === true) {
    return "refuse-live";
  }
  return "unknown-liveness";
}

export interface HealResult {
  action: PairingAction;
  healed: boolean;
}

/**
 * Reconcile this session's surface registration with reality. `agent` is the
 * hook-proven role ("claude"/"codex"), which is independent of the (possibly
 * stale) surface-file mapping: a restarted surface gets a fresh CMUX_SURFACE_ID,
 * so its prior registration goes stale and role detection returns "unknown",
 * wedging the pair. Called on a session's first events to auto re-pair when the
 * old registration is missing or points at a now-dead surface; refuses to hijack
 * a registration that still points at a different, live surface (duplicate
 * session) so two same-role tabs don't fight.
 */
export function healPairing(agent: string): HealResult {
  const current = currentSurfaceId();
  const registered = surfaceForRole(agent);
  let regAlive: boolean | null = null;
  if (current && registered && registered !== current) {
    regAlive = isSurfaceLive(registered, liveSurfaceIds());
  }
  const action = decidePairing(current, registered, regAlive);
  // Registration writes to ~/.config; a write can fail (e.g. a sandboxed
  // context where that path is read-only). Never let that break the hook.
  const tryRegister = (): boolean => {
    try {
      registerSurface(agent, current);
      return true;
    } catch (e) {
      cmuxLog("warning", `CCR: could not persist ${agent} surface registration (${String((e as Error)?.message ?? e)}); run cmux-setup-${agent} from a normal terminal surface`);
      return false;
    }
  };
  switch (action) {
    case "register-unset":
      if (!tryRegister()) {
        return { action, healed: false };
      }
      cmuxLog("info", `CCR: registered ${agent} surface ${current} (was unset)`);
      return { action, healed: true };
    case "repair-dead":
      if (!tryRegister()) {
        return { action, healed: false };
      }
      cmuxLog("info", `CCR: re-paired ${agent} surface (previous ${registered} is gone -> ${current})`);
      cmuxStatus("CCR re-paired", "#34C759");
      return { action, healed: true };
    case "refuse-live":
      cmuxLog(
        "warning",
        `CCR: ${agent} is already paired to a live surface ${registered}; this session (${current}) will NOT take over (run \`ccr-repair --force\` to override)`,
      );
      return { action, healed: false };
    case "unknown-liveness":
      cmuxLog("warning", `CCR: could not verify whether ${agent} surface ${registered} is live; leaving the registration unchanged`);
      return { action, healed: false };
    default:
      return { action, healed: false };
  }
}

/** Python `workspace_enabled` (192-196): workspace id present AND listed in ENABLED_FILE. */
export function workspaceEnabled(): boolean {
  const wid = workspaceId();
  if (!wid || !existsSync(ENABLED_FILE)) {
    return false;
  }
  return splitlines(readFileSync(ENABLED_FILE, "utf-8")).includes(wid);
}
