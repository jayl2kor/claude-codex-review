/**
 * report.ts — session-report FS helpers, Phase 4a of the Python->Bun migration
 * (ccr-hook.py). The full report GENERATOR (generate_session_report) is Phase 4b;
 * this module ports the small read-only helpers it builds on.
 *
 * Ported from ccr-hook.py: _latest_session_id (1232-1239),
 * _round_must_fix_count (1252-1256), _round_files_touched (1259-1273).
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { countMustFixInText } from "./decision";
import { filesTouchedFromDiffText } from "./diff";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Python `_latest_session_id` (1232-1239): the session dir (that has a rounds/
 * subdir) with the greatest mtime, or null. On a tie, the first-encountered
 * candidate is kept (matching Python's max()), so callers should rely on
 * distinct mtimes for a deterministic result.
 */
export function latestSessionId(root: string): string | null {
  const sessionsDir = join(root, "sessions");
  if (!isDir(sessionsDir)) {
    return null;
  }
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const name of names) {
    const d = join(sessionsDir, name);
    if (!isDir(d) || !isDir(join(d, "rounds"))) {
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(d).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtime > best.mtime) {
      best = { name, mtime };
    }
  }
  return best === null ? null : best.name;
}

/** Python `_round_must_fix_count` (1252-1256). */
export function roundMustFixCount(rdir: string): number {
  const reviewPath = join(rdir, "review.md");
  if (!isFile(reviewPath)) {
    return 0;
  }
  return countMustFixInText(readFileSync(reviewPath, "utf-8"));
}

/**
 * Python `_round_files_touched` (1259-1273): files named in a round's
 * diff.patch. Python returns a set; this returns a sorted array (the report
 * uses it order-independently). filesTouchedFromDiffText is the shared parser.
 */
export function roundFilesTouched(rdir: string): string[] {
  const diffPath = join(rdir, "diff.patch");
  if (!isFile(diffPath)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(diffPath, "utf-8");
  } catch {
    return [];
  }
  return filesTouchedFromDiffText(text);
}
