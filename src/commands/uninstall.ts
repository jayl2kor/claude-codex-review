/**
 * uninstall.ts — `ccr-uninstall`. Faithful port of ccr-hook.py command_uninstall
 * (3661-3745): list (and with --apply, perform) removal of the generated bins +
 * Claude command files, strip CCR hook entries from settings.json / hooks.json,
 * and optionally (--purge) remove the config/state dirs. ~/.zshrc is untouched.
 */
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { CONFIG_ROOT } from "../lib/paths";
import { GENERATED_BIN_NAMES, GENERATED_CLAUDE_COMMAND_FILES } from "../lib/constants";
import type { CcrArgs } from "../lib/args";
import { out, isPlainObject } from "./shared";

function exists(p: string): boolean {
  return existsSync(p);
}

export function commandUninstall(args: CcrArgs): number {
  const home = homedir();
  const binRoot = join(home, ".local", "bin");
  const cmdRoot = join(home, ".claude", "commands");
  const settings = join(home, ".claude", "settings.json");
  const codexHooks = join(home, ".codex", "hooks.json");
  // Legacy bins from a pre-5f (Python runtime) install: removed if still present
  // so an upgrade-then-uninstall does not orphan them. NOT part of
  // GENERATED_BIN_NAMES, so a current install never flags them as "missing".
  const LEGACY_BIN_NAMES = ["ccr-hook.py"];
  const targetsBin = [...GENERATED_BIN_NAMES, ...LEGACY_BIN_NAMES]
    .map((f) => join(binRoot, f))
    .filter(exists);
  const targetsCmd = GENERATED_CLAUDE_COMMAND_FILES.map((f) => join(cmdRoot, f)).filter(exists);
  const purgeDirs: string[] = [];
  if (args.purge) {
    for (const d of [CONFIG_ROOT, join(home, ".local", "state", "claude-codex-review")]) {
      if (exists(d)) {
        purgeDirs.push(d);
      }
    }
  }

  out(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  out("Files to remove:");
  for (const p of [...targetsBin, ...targetsCmd]) {
    out(`  ${p}`);
  }
  if (purgeDirs.length > 0) {
    out("Directories to remove (--purge):");
    for (const d of purgeDirs) {
      out(`  ${d}`);
    }
  }
  out("Hook entries to strip from:");
  for (const p of [settings, codexHooks]) {
    if (exists(p)) {
      out(`  ${p}`);
    }
  }
  out("Note: ~/.zshrc PATH line is left untouched.");

  if (!args.apply) {
    out("\nDry run only. Add --apply to perform removal.");
    return 0;
  }

  const ccrBins = new Set([join(binRoot, "ccr-hook-claude"), join(binRoot, "ccr-hook-codex")]);
  const isCcrHookGroup = (group: unknown): boolean => {
    if (!isPlainObject(group)) {
      return false;
    }
    const hooksList = group.hooks;
    if (!Array.isArray(hooksList)) {
      return false;
    }
    for (const h of hooksList) {
      if (!isPlainObject(h)) {
        continue;
      }
      const cmd = String(h.command || "");
      const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length > 0 && ccrBins.has(tokens[0]!)) {
        return true;
      }
    }
    return false;
  };

  for (const path of [settings, codexHooks]) {
    if (!exists(path)) {
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const hooks = isPlainObject(doc) ? doc.hooks : null;
    if (!isPlainObject(hooks)) {
      continue;
    }
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) {
        continue;
      }
      const filtered: unknown[] = [];
      for (const group of groups) {
        if (isCcrHookGroup(group)) {
          changed = true;
          continue;
        }
        filtered.push(group);
      }
      hooks[event] = filtered;
    }
    if (changed) {
      writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf-8");
    }
  }

  for (const p of [...targetsBin, ...targetsCmd]) {
    try {
      unlinkSync(p);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") {
        throw e;
      }
    }
  }
  for (const d of purgeDirs) {
    rmSync(d, { recursive: true, force: true });
  }

  out("Removed.");
  return 0;
}
