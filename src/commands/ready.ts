/**
 * ready.ts — `ccr-ready`. Faithful port of ccr-hook.py _ready_checks
 * (3132-3231) + command_ready (3234-3274): is everything wired up for automatic
 * review? Exit 0 when all checks pass, else 1. _ready_checks is also consumed by
 * command_check.
 */
import { join } from "node:path";

import { loadJson } from "../lib/io";
import { rootForCwd, workspaceId, surfaceId } from "../lib/paths";
import { workspaceEnabled, surfaceForRole, roleForCurrentSurface } from "../lib/cmux";
import { insideGit } from "../lib/git";
import { RUNTIME_COMMANDS, GENERATED_BIN_NAMES } from "../lib/constants";
import { ljust } from "../lib/pycompat";
import { which, isExecutable, jsonFileContains, installLayout } from "./diag";
import { out, g, isPlainObject } from "./shared";

export interface ReadyCheck {
  ok: boolean;
  name: string;
  detail: string;
  action: string;
}

/** Python `_ready_checks` (3132-3231). */
export function readyChecks(cwd: string, root: string): ReadyCheck[] {
  const { binRoot, claudeSettings, codexHooks } = installLayout();
  const checks: ReadyCheck[] = [];
  const add = (ok: boolean, name: string, detail: string, action: string): void => {
    checks.push({ ok, name, detail, action: ok ? "" : action });
  };

  const missingRuntime = RUNTIME_COMMANDS.filter((name) => !which(name));
  add(
    missingRuntime.length === 0,
    "runtime commands",
    missingRuntime.length === 0 ? "all runtime commands found" : "missing: " + missingRuntime.join(", "),
    "Install missing runtime commands or expose them in PATH: " + missingRuntime.join(", "),
  );

  const missingGenerated = GENERATED_BIN_NAMES.filter((name) => !isExecutable(join(binRoot, name)));
  add(
    missingGenerated.length === 0,
    "installed CCR commands",
    missingGenerated.length === 0 ? "all generated commands are executable" : "missing/not executable: " + missingGenerated.join(", "),
    "Run `bash ccr.sh` from the CCR repository to reinstall generated commands.",
  );

  const claudeHook = join(binRoot, "ccr-hook-claude");
  const codexHook = join(binRoot, "ccr-hook-codex");
  const claudeHas = jsonFileContains(claudeSettings, claudeHook);
  add(
    claudeHas,
    "Claude hook installed",
    claudeHas ? `${claudeSettings} contains ${claudeHook}` : `${claudeSettings} missing CCR hook entry`,
    "Run `bash ccr.sh` from the CCR repository to merge Claude hook entries.",
  );
  const codexHas = jsonFileContains(codexHooks, codexHook);
  add(
    codexHas,
    "Codex hook installed",
    codexHas ? `${codexHooks} contains ${codexHook}` : `${codexHooks} missing CCR hook entry`,
    "Run `bash ccr.sh` from the CCR repository to merge Codex hook entries.",
  );

  const wid = workspaceId();
  const sid = surfaceId();
  add(
    Boolean(wid && sid),
    "inside cmux surface",
    wid && sid ? `workspace=${wid} surface=${sid}` : "not running inside a cmux surface",
    "Open the target project in cmux and run `ccr-ready` inside a Claude or Codex surface.",
  );

  const role = roleForCurrentSurface();
  const roleKnown = role === "claude" || role === "codex";
  add(
    roleKnown,
    "current surface registered",
    roleKnown ? role : "current surface is not registered as Claude or Codex",
    "Run `cmux-setup-claude` in the Claude surface or `cmux-setup-codex` in the Codex surface.",
  );

  const claudeSurface = surfaceForRole("claude");
  const codexSurface = surfaceForRole("codex");
  add(Boolean(claudeSurface), "Claude surface registered", claudeSurface || "not registered", "Run `cmux-setup-claude` in the Claude terminal surface.");
  add(Boolean(codexSurface), "Codex surface registered", codexSurface || "not registered", "Run `cmux-setup-codex` in the Codex terminal surface.");

  const enabled = workspaceEnabled();
  add(enabled, "workspace enabled", enabled ? "enabled" : "not enabled for this cmux workspace", "Run `ccr-enable` from the target repository directory.");
  const inGit = insideGit(cwd);
  add(inGit, "git repository", inGit ? cwd : "current directory is not inside a git worktree", "Change directory to the target git repository before running CCR commands.");

  const stateDoc = loadJson<Record<string, unknown>>(join(root, "state.json"), {});
  const active = isPlainObject(stateDoc) ? stateDoc.active_request : null;
  add(
    !isPlainObject(active),
    "no active review request",
    !isPlainObject(active) ? "none" : `round ${g(active, "round", "?")} ${g(active, "worker", "?")}->${g(active, "reviewer", "?")}`,
    "Wait for the reviewer to finish, or run `ccr-cancel` if the request is stale.",
  );
  return checks;
}

export function readyDoc(cwd: string, root: string): Record<string, unknown> {
  const checks = readyChecks(cwd, root);
  const ready = checks.every((c) => Boolean(c.ok));
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    const action = String(check.action || "");
    if (action && !seen.has(action)) {
      seen.add(action);
      actions.push(action);
    }
  }
  return { version: 1, ready, cwd, ccr_root: root, checks, actions };
}

export function commandReady(jsonOutput: boolean): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const doc = readyDoc(cwd, root);
  const ready = Boolean(doc.ready);
  const checks = doc.checks as ReadyCheck[];
  const actions = doc.actions as string[];

  if (jsonOutput) {
    out(JSON.stringify(doc, null, 2));
    return ready ? 0 : 1;
  }

  out("CCR Ready Check");
  out(`Cwd: ${cwd}`);
  out(`CCR root: ${root}`);
  out();
  for (const check of checks) {
    const status = check.ok ? "OK" : "FAIL";
    out(`[${ljust(status, 4)}] ${ljust(check.name, 28)} ${check.detail}`);
  }
  out();
  if (ready) {
    out("Ready: yes");
    out("Next: start work normally; the next mutating worker turn can trigger CCR review.");
    return 0;
  }
  out("Ready: no");
  out("Next actions:");
  actions.forEach((action, i) => {
    out(`${i + 1}. ${action}`);
  });
  return 1;
}
