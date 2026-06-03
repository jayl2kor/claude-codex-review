/**
 * paths.ts — workspace / surface identity and session path helpers ported from
 * the CCR runtime (ccr-hook.py), Phase 3 of the Python->Bun migration.
 *
 * Ported from ccr-hook.py: workspace_id (140-141), surface_id (144-145),
 * root_for_cwd (181-186), session_dir (189-190), session_context_path
 * (193-194), session_ledger_path (197-198).
 *
 * Zero npm deps — node:path + pycompat/text only.
 */

import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { sanitize } from "./text";

/** Python `CONFIG_ROOT` (22): Path.home() / ".config" / "claude-codex-review". */
export const CONFIG_ROOT = join(homedir(), ".config", "claude-codex-review");

/** Python `ENABLED_FILE` (23): $CONFIG_ROOT/enabled-workspaces.txt. */
export const ENABLED_FILE = join(CONFIG_ROOT, "enabled-workspaces.txt");

/** Python `workspace_config_dir` (148-149): $CONFIG_ROOT/workspaces/<workspace_id>. */
export function workspaceConfigDir(): string {
  return join(CONFIG_ROOT, "workspaces", workspaceId());
}

/** Python `session_intent_path`: session_dir/intent.md. */
export function sessionIntentPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "intent.md");
}

/** Python `workspace_id` (140-141): os.environ.get("CMUX_WORKSPACE_ID", ""). */
export function workspaceId(): string {
  return process.env.CMUX_WORKSPACE_ID ?? "";
}

/** Python `surface_id` (144-145): os.environ.get("CMUX_SURFACE_ID", ""). */
export function surfaceId(): string {
  return process.env.CMUX_SURFACE_ID ?? "";
}

/**
 * Python `root_for_cwd` (181-186): honor an absolute/relative CCR_ROOT override,
 * else <cwd>/.cmux/ccr.
 */
export function rootForCwd(cwd: string): string {
  const override = (process.env.CCR_ROOT ?? "").trim();
  if (override) {
    return isAbsolute(override) ? override : join(cwd, override);
  }
  return join(cwd, ".cmux", "ccr");
}

/** Python `session_dir` (189-190): root/sessions/sanitize(session_id). */
export function sessionDir(root: string, sessionId: string): string {
  return join(root, "sessions", sanitize(sessionId));
}

/** Python `session_context_path` (193-194): session_dir/context.md. */
export function sessionContextPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "context.md");
}

/** Python `session_ledger_path` (197-198): session_dir/ledger.md. */
export function sessionLedgerPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "ledger.md");
}

/** Python `skip_marker_path` (1509-1510): root/skip-next.json. */
export function skipMarkerPath(root: string): string {
  return join(root, "skip-next.json");
}
