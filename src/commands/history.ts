/**
 * history.ts — `ccr-history`. Faithful port of ccr-hook.py command_history
 * (2244-2287): list completed review rounds (most recent first).
 */
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

import { loadJson } from "../lib/io";
import { rootForCwd } from "../lib/paths";
import { cpCompare, ljust, rjust } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out, isPlainObject } from "./shared";

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function sortedChildren(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  names.sort(cpCompare);
  return names;
}

interface Entry {
  at: string;
  session: string;
  round: number;
  worker: string;
  reviewer: string;
  decision: string;
  review_file: string;
}

export function commandHistory(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const sessionsDir = join(root, "sessions");
  if (!isDir(sessionsDir)) {
    out("No sessions yet.");
    return 0;
  }
  const entries: Entry[] = [];
  for (const sname of sortedChildren(sessionsDir)) {
    const sdir = join(sessionsDir, sname);
    if (!isDir(sdir)) {
      continue;
    }
    if (args.session && sname !== args.session) {
      continue;
    }
    const roundsDir = join(sdir, "rounds");
    if (!isDir(roundsDir)) {
      continue;
    }
    for (const rname of sortedChildren(roundsDir)) {
      const rdir = join(roundsDir, rname);
      if (!isDir(rdir)) {
        continue;
      }
      const decisionPath = join(rdir, "decision.json");
      if (!isFile(decisionPath)) {
        continue;
      }
      const d = loadJson<Record<string, unknown>>(decisionPath, {});
      if (!isPlainObject(d)) {
        continue;
      }
      entries.push({
        at: String(d.updated_at || ""),
        session: sname,
        round: Math.trunc(Number(d.round || 0)),
        worker: String(d.worker || ""),
        reviewer: String(d.reviewer || ""),
        decision: String(d.decision || ""),
        review_file: String(d.review_file || ""),
      });
    }
  }
  // Stable sort by `at` descending (Python list.sort(reverse=True) keeps the
  // original order for equal keys; cpCompare(b,a) returns 0 on a tie -> stable).
  entries.sort((a, b) => cpCompare(b.at, a.at));
  const limit = args.limit && args.limit > 0 ? args.limit : 20;
  const shown = entries.slice(0, limit);
  if (shown.length === 0) {
    out("No completed rounds.");
    return 0;
  }
  out(`${ljust("time", 22)} ${rjust("r", 3)} ${rjust("worker", 7)} ${rjust("reviewer", 8)} ${ljust("decision", 14)} review`);
  for (const e of shown) {
    out(`${ljust(e.at, 22)} ${rjust(String(e.round), 3)} ${rjust(e.worker, 7)} ${rjust(e.reviewer, 8)} ${ljust(e.decision, 14)} ${e.review_file}`);
  }
  return 0;
}
