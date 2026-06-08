/**
 * doctor.ts — `ccr-doctor`. Faithful port of ccr-hook.py command_doctor
 * (2881-3044): inspect the install (PATH, generated bins, Claude/Codex hook
 * registration), the cmux surface/role wiring, and the CCR runtime root, then
 * print a status table (or --json) with next-step actions. Exit 1 on any fail.
 */
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";

import { loadJson } from "../lib/io";
import { rootForCwd, skipMarkerPath, workspaceId, surfaceId } from "../lib/paths";
import { workspaceEnabled, surfaceForRole, roleForCurrentSurface, liveSurfaceIds, isSurfaceLive, currentSurfaceId } from "../lib/cmux";
import { insideGit } from "../lib/git";
import { formatDuration } from "../lib/text";
import { doctorNextMessage, doctorActionItems } from "../lib/misc";
import { RUNTIME_COMMANDS, GENERATED_BIN_NAMES } from "../lib/constants";
import { ljust } from "../lib/pycompat";
import { which, isExecutable, jsonFileContains, installLayout } from "./diag";
import { out, g, isPlainObject, utcEpochSeconds, nowEpochSeconds } from "./shared";

export interface DoctorRow {
  status: string;
  name: string;
  detail: string;
}

/** Build the doctor rows (shared with command_check via the json doc). */
export function doctorRows(cwd: string): DoctorRow[] {
  const { binRoot, claudeSettings, codexHooks } = installLayout();
  const root = rootForCwd(cwd);
  const rows: DoctorRow[] = [];
  const add = (status: string, name: string, detail = ""): void => {
    rows.push({ status, name, detail });
  };

  // `bun` runs the installed runtime (ccr-cli.js) via the bin wrappers, so it is
  // the required command (Phase 5f: Python is no longer used at install or
  // runtime). cmux/claude/codex remain runtime-workflow requirements.
  for (const name of ["bun", ...RUNTIME_COMMANDS]) {
    const found = which(name);
    add(found ? "ok" : "fail", `command: ${name}`, found || "not found in PATH");
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  const onPath = pathEntries.includes(binRoot);
  add(onPath ? "ok" : "warn", "PATH", `${binRoot} ${onPath ? "is in PATH" : "is not in PATH for this shell"}`);

  const missingGenerated = GENERATED_BIN_NAMES.filter((name) => !isExecutable(join(binRoot, name)));
  add(
    missingGenerated.length === 0 ? "ok" : "fail",
    "installed command files",
    missingGenerated.length === 0 ? "all generated commands are executable" : "missing/not executable: " + missingGenerated.join(", "),
  );

  const claudeHook = join(binRoot, "ccr-hook-claude");
  const codexHook = join(binRoot, "ccr-hook-codex");
  const claudeHasHook = jsonFileContains(claudeSettings, claudeHook);
  const codexHasHook = jsonFileContains(codexHooks, codexHook);
  add(
    claudeHasHook ? "ok" : "fail",
    "Claude hooks",
    claudeHasHook
      ? `${claudeSettings} contains ${claudeHook}`
      : existsSync(claudeSettings) ? `${claudeSettings} missing CCR hook entry` : `${claudeSettings} not found`,
  );
  add(
    codexHasHook ? "ok" : "fail",
    "Codex hooks",
    codexHasHook
      ? `${codexHooks} contains ${codexHook}`
      : existsSync(codexHooks) ? `${codexHooks} missing CCR hook entry` : `${codexHooks} not found`,
  );

  const wid = workspaceId();
  const sid = surfaceId();
  add(wid && sid ? "ok" : "warn", "cmux surface", wid && sid ? `workspace=${wid} surface=${sid}` : "not running inside a cmux surface");

  // A stale CMUX_SURFACE_ID env var (inherited unchanged by a split/resumed
  // shell) is the classic "cmux-setup-* registered but the surface isn't
  // recognized" cause: setup/role-detection then use the wrong id. Compare the
  // env var against cmux's authoritative caller surface.
  if (sid) {
    const authoritative = currentSurfaceId();
    const matches = authoritative === sid;
    add(matches ? "ok" : "warn", "surface id source",
      matches ? "CMUX_SURFACE_ID matches cmux identify"
        : `CMUX_SURFACE_ID (${sid}) != cmux caller surface (${authoritative}) — env is stale; re-run cmux-setup-* (now uses the cmux value)`);
  }

  const role = roleForCurrentSurface();
  const roleKnown = role === "claude" || role === "codex";
  add(roleKnown ? "ok" : "warn", "registered current surface", roleKnown ? role : "run cmux-setup-claude or cmux-setup-codex in this surface");

  const claudeSurface = surfaceForRole("claude");
  const codexSurface = surfaceForRole("codex");
  add(claudeSurface ? "ok" : "warn", "registered Claude surface", claudeSurface || "not registered");
  add(codexSurface ? "ok" : "warn", "registered Codex surface", codexSurface || "not registered");

  // Liveness: a registered surface whose id is no longer among the workspace's
  // live surfaces was closed/reopened and needs re-pairing (SessionStart
  // self-heals it; ccr-repair forces it). Skipped when enumeration is
  // unavailable (not in a cmux workspace, or cmux can't be reached).
  const live = liveSurfaceIds();
  if (live !== null) {
    for (const [r, reg] of [["Claude", claudeSurface], ["Codex", codexSurface]] as const) {
      if (!reg) {
        continue;
      }
      const alive = isSurfaceLive(reg, live);
      add(alive ? "ok" : "warn", `${r} surface live`, alive ? reg : `${reg} is gone — re-pair (restart the surface or run ccr-repair there)`);
    }
  }

  const enabled = workspaceEnabled();
  add(enabled ? "ok" : "warn", "workspace enabled", enabled ? "enabled" : "run ccr-enable inside the target repo");

  const inGit = insideGit(cwd);
  add(inGit ? "ok" : "warn", "git repository", inGit ? cwd : "current directory is not inside a git worktree");

  const statusDoc = loadJson<Record<string, unknown>>(join(root, "status.json"), {});
  const stateDoc = loadJson<Record<string, unknown>>(join(root, "state.json"), {});
  if (existsSync(root)) {
    const reason = isPlainObject(statusDoc) ? String(g(statusDoc, "reason", null) || "") : "";
    add("ok", "CCR runtime root", `${root} (${reason || "state exists"})`);
  } else {
    add("warn", "CCR runtime root", `${root} not found; run ccr-enable`);
  }

  const active = isPlainObject(stateDoc) ? stateDoc.active_request : null;
  if (isPlainObject(active)) {
    let elapsed = "";
    const created = g(active, "created_at", null);
    if (created) {
      const ep = utcEpochSeconds(String(created));
      if (ep !== null) {
        const elapsedSecs = Math.max(0, Math.trunc(nowEpochSeconds() - ep));
        elapsed = `, elapsed=${formatDuration(elapsedSecs)}`;
      }
    }
    add("warn", "active request", `round ${g(active, "round", "?")} ${g(active, "worker", "?")}->${g(active, "reviewer", "?")}${elapsed}; use ccr-status or ccr-cancel if stale`);
  } else {
    add("ok", "active request", "none");
  }

  const skip = skipMarkerPath(root);
  const skipPending = existsSync(skip);
  add(skipPending ? "warn" : "ok", "skip-next marker", skipPending ? skip : "none");

  return rows;
}

/** Build the doctor JSON doc + exit code (shared with command_check). */
export function doctorDoc(cwd: string): { code: number; doc: Record<string, unknown> } {
  const root = rootForCwd(cwd);
  const rows = doctorRows(cwd);
  const failCount = rows.filter((r) => r.status === "fail").length;
  const warnCount = rows.filter((r) => r.status === "warn").length;
  const okCount = rows.filter((r) => r.status === "ok").length;
  const doc: Record<string, unknown> = {
    version: 1,
    cwd,
    ccr_root: root,
    summary: { fail: failCount, warn: warnCount, ok: okCount },
    checks: rows,
    next: doctorNextMessage(failCount, warnCount),
    actions: doctorActionItems(rows),
  };
  return { code: failCount ? 1 : 0, doc };
}

export function commandDoctor(jsonOutput: boolean): number {
  const cwd = process.cwd();
  const { code, doc } = doctorDoc(cwd);
  const root = String(doc.ccr_root);
  const summary = doc.summary as { fail: number; warn: number; ok: number };
  const failCount = summary.fail;
  const warnCount = summary.warn;
  const rows = doc.checks as DoctorRow[];
  const nextMessage = String(doc.next);
  const actions = doc.actions as string[];

  if (jsonOutput) {
    out(JSON.stringify(doc, null, 2));
    return code;
  }

  out("CCR Doctor");
  out(`Cwd: ${cwd}`);
  out(`CCR root: ${root}`);
  out();
  for (const row of rows) {
    out(`[${ljust(row.status.toUpperCase(), 4)}] ${ljust(row.name, 28)} ${row.detail}`);
  }
  out();
  out(`Summary: ${failCount} fail, ${warnCount} warn`);
  out(`Next: ${nextMessage}`);
  out();
  out("Next actions:");
  actions.forEach((action, i) => {
    out(`${i + 1}. ${action}`);
  });
  return code;
}
