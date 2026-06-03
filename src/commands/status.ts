/**
 * status.ts — `ccr-status`. Faithful port of ccr-hook.py command_status
 * (2052-2096): print a human-readable summary of the workspace + CCR state.
 */
import { join } from "node:path";

import { loadJson, readText, pyJsonCompact } from "../lib/io";
import { defaultState } from "../lib/misc";
import { rootForCwd, skipMarkerPath, CONFIG_ROOT, workspaceId } from "../lib/paths";
import { workspaceEnabled, surfaceForRole } from "../lib/cmux";
import { STALE_ACTIVE_SECONDS } from "../lib/constants";
import { statSync } from "node:fs";
import { out, g, isPlainObject, utcEpochSeconds, nowEpochSeconds } from "./shared";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function commandStatus(): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const state = loadJson<Record<string, unknown>>(join(root, "state.json"), defaultState() as unknown as Record<string, unknown>);
  const status = loadJson<Record<string, unknown>>(join(root, "status.json"), {});
  const version = readText(join(CONFIG_ROOT, "VERSION")) || "unknown";
  out(`Workspace: ${workspaceId() || "-"}`);
  out(`Enabled: ${workspaceEnabled() ? "yes" : "no"}`);
  out(`Version: ${version}`);
  out(`Claude surface: ${surfaceForRole("claude") || "-"}`);
  out(`Codex surface: ${surfaceForRole("codex") || "-"}`);
  out(`CCR root: ${root}`);
  out(`Status: ${g(status, "status", "-")}`);
  out(`Reason: ${g(status, "reason", "-")}`);
  out(`Review count: ${g(state, "review_count", 0)}`);
  const lastCompleted = g(state, "last_completed", undefined);
  if (isPlainObject(lastCompleted)) {
    out(`Last round: r${g(lastCompleted, "round", "?")} ${g(lastCompleted, "decision", "?")} @ ${g(lastCompleted, "at", "?")}`);
  } else {
    out("Last round: -");
  }
  const active = g(state, "active_request", undefined);
  if (isPlainObject(active)) {
    let elapsed = "";
    let elapsedSecs = -1;
    const created = g(active, "created_at", null);
    if (created) {
      const ep = utcEpochSeconds(String(created));
      if (ep !== null) {
        elapsedSecs = Math.max(0, Math.trunc(nowEpochSeconds() - ep));
        elapsed = ` elapsed=${elapsedSecs}s`;
      }
    }
    out(`Active request: r${g(active, "round", "?")} ${g(active, "worker", "?")}->${g(active, "reviewer", "?")}${elapsed}`);
    out(`Active request details: ${pyJsonCompact(active)}`);
    if (STALE_ACTIVE_SECONDS > 0 && elapsedSecs >= STALE_ACTIVE_SECONDS) {
      out(`Hint: active request is ${elapsedSecs}s old (>= CCR_STALE_ACTIVE_SECONDS=${STALE_ACTIVE_SECONDS}s). It will be auto-discarded on the next hook event from this workspace, or run \`ccr-cancel\` to recover immediately.`);
    }
  } else {
    out("Active request: -");
  }
  const skip = skipMarkerPath(root);
  if (isFile(skip)) {
    out(`Skip-next: pending (${skip})`);
  }
  const lastReport = isPlainObject(status) ? g(status, "last_report", null) : null;
  if (isPlainObject(lastReport) && g(lastReport, "path", "")) {
    out(`Last report: ${g(lastReport, "outcome", "?")} @ ${g(lastReport, "at", "?")} -> ${g(lastReport, "path", "")}`);
  }
  return 0;
}
