/**
 * prune.ts — `ccr-prune`. Faithful port of ccr-hook.py _prune_candidates
 * (2534-2584) + command_prune (2587-2638): list (or with --apply, delete) old
 * sessions and support bundles by keep/days retention.
 *
 * NOTE: `age_days` is now()-derived; the JSON renders it as a JS number, so a
 * value that rounds to a whole number prints "2" where Python prints "2.0"
 * (json.dumps float). This is cosmetic and inherently non-deterministic; the
 * oracle test normalizes age_days. Everything else is byte-faithful.
 */
import { existsSync, readdirSync, statSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { rootForCwd } from "../lib/paths";
import type { CcrArgs } from "../lib/args";
import { out, err } from "./shared";

interface Candidate {
  type: string;
  path: string;
  age_days: number;
  reasons: string[];
}

function mtimeSec(p: string): number {
  return statSync(p).mtimeMs / 1000;
}
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Children of `dir` (full paths) matching `pred`, sorted by mtime DESC. */
function byMtimeDesc(dir: string, pred: (name: string, full: string) => boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items = names
    .map((n) => join(dir, n))
    .filter((full, i) => pred(names[i]!, full));
  return items
    .map((full) => ({ full, m: mtimeSec(full) }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.full);
}

export function pruneCandidates(root: string, keep: number, days: number): Candidate[] {
  const nowTs = Date.now() / 1000;
  const cutoff = days && days > 0 ? nowTs - days * 86400 : null;
  const candidates: Candidate[] = [];

  const sessionDirs = byMtimeDesc(join(root, "sessions"), (_n, full) => {
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });
  sessionDirs.forEach((sdir, idx) => {
    const ageDays = Math.max(0, (nowTs - mtimeSec(sdir)) / 86400);
    const reasons: string[] = [];
    if (keep >= 0 && idx >= keep) {
      reasons.push(`beyond keep=${keep}`);
    }
    if (cutoff !== null && mtimeSec(sdir) < cutoff) {
      reasons.push(`older than ${days} days`);
    }
    if (reasons.length > 0) {
      candidates.push({ type: "session", path: sdir, age_days: round2(ageDays), reasons });
    }
  });

  const supportFiles = byMtimeDesc(join(root, "support"), (name, full) => {
    try {
      return statSync(full).isFile() && name.startsWith("ccr-support-");
    } catch {
      return false;
    }
  });
  supportFiles.forEach((path, idx) => {
    const ageDays = Math.max(0, (nowTs - mtimeSec(path)) / 86400);
    const reasons: string[] = [];
    if (keep >= 0 && idx >= keep) {
      reasons.push(`beyond keep=${keep}`);
    }
    if (cutoff !== null && mtimeSec(path) < cutoff) {
      reasons.push(`older than ${days} days`);
    }
    if (reasons.length > 0) {
      candidates.push({ type: "support_bundle", path, age_days: round2(ageDays), reasons });
    }
  });
  return candidates;
}

export function commandPrune(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const keep = Math.trunc(args.keep !== null ? args.keep : 20);
  const days = Math.trunc(args.days !== null ? args.days : 30);
  if (keep < 0 && days <= 0) {
    err("Refusing prune with no retention rule: use --keep N or --days N.");
    return 2;
  }
  const candidates = pruneCandidates(root, keep, days);
  const removed: string[] = [];
  if (args.apply) {
    for (const item of candidates) {
      const path = item.path;
      if (item.type === "session") {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } else {
        try {
          unlinkSync(path);
          removed.push(path);
        } catch (e) {
          if ((e as { code?: string }).code !== "ENOENT") {
            throw e;
          }
        }
      }
    }
  }

  if (args.json_output) {
    out(JSON.stringify({
      version: 1,
      cwd,
      ccr_root: root,
      mode: args.apply ? "apply" : "dry-run",
      keep,
      days,
      candidates,
      removed,
    }, null, 2));
    return 0;
  }

  out("CCR Prune");
  out(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  out(`CCR root: ${root}`);
  out(`Retention: keep=${keep}, days=${days}`);
  out();
  if (candidates.length === 0) {
    out("No sessions or support bundles match the retention rule.");
    return 0;
  }
  out("Candidates:");
  for (const item of candidates) {
    out(`- [${item.type}] ${item.path} (${item.age_days} days; ${item.reasons.join(", ")})`);
  }
  if (args.apply) {
    out();
    out(`Removed: ${removed.length}`);
  } else {
    out();
    out("Dry run only. Add --apply to remove these paths.");
  }
  return 0;
}
