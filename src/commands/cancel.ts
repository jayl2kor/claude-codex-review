/**
 * cancel.ts — `ccr-cancel`. Faithful port of ccr-hook.py command_cancel
 * (2209-2241): clear any active request, clear dirty markers, and emit a
 * cancellation report.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { rootForCwd } from "../lib/paths";
import { lockedState, writeStatus } from "../lib/lock";
import { cmuxStatus, cmuxLog } from "../lib/cmux";
import { tryGenerateReport } from "../lib/report";
import { out, err, g, isPlainObject } from "./shared";

export function commandCancel(): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  if (!existsSync(root)) {
    err("CCR root not found for this cwd.");
    return 1;
  }
  let cancelledActive: Record<string, unknown> | null = null;
  lockedState(root, (state) => {
    const active = state.active_request;
    if (isPlainObject(active)) {
      cancelledActive = { ...active };
    }
    state.active_request = null;
    writeStatus(root, state, "cancelled", "ccr-cancel");
  });
  const sessionsDir = join(root, "sessions");
  let isDir = false;
  try {
    isDir = statSync(sessionsDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    for (const name of readdirSync(sessionsDir)) {
      const dirty = join(sessionsDir, name, "dirty.json");
      try {
        unlinkSync(dirty);
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") {
          throw e;
        }
      }
    }
  }
  cmuxStatus("CCR cancelled", "#8E8E93");
  cmuxLog("warning", "ccr-cancel executed");
  if (cancelledActive) {
    const sid = String(g(cancelledActive, "worker_session_id", null) || "");
    tryGenerateReport(root, sid, "cancelled", "cancel");
  }
  if (cancelledActive) {
    out(`Cancelled active request: round ${g(cancelledActive, "round", "?")} (${g(cancelledActive, "worker", "?")}->${g(cancelledActive, "reviewer", "?")})`);
  } else {
    out("No active request; status set to cancelled and dirty flags cleared.");
  }
  return 0;
}
