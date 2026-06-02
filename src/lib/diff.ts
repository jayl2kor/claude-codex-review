/**
 * diff.ts — pure (no I/O, deterministic) diff-analysis helpers of the CCR
 * runtime (ccr-hook.py), ported to TypeScript for the Python->Bun migration.
 *
 * Every function mirrors its Python counterpart so the differential test can
 * compare TS output to the Python oracle byte-for-byte. The load-bearing
 * primitives (splitlines, strip, byte/codepoint lengths, posix path parts) are
 * imported from the already-validated foundation and are NOT reimplemented here.
 *
 * Zero dependencies — only the local foundation modules.
 */

import {
  splitlines,
  strip,
  splitWhitespace,
  cpCompare,
  posixParts,
  posixName,
} from "./pycompat.ts";
import { SENSITIVE_BASENAMES, SENSITIVE_SUFFIXES } from "./constants.ts";

// ---------------------------------------------------------------------------
// _diff_has_content (Python 658-666)
// ---------------------------------------------------------------------------

/**
 * Mirror of Python `_diff_has_content`. True if the combined diff text contains
 * any real change content: a "diff --git"/"@@" header, an added line ("+" but
 * not the "+++" file header), or a removed line ("-" but not the "---" header).
 */
export function diffHasContent(text: string): boolean {
  for (const line of splitlines(text)) {
    if (line.startsWith("diff --git") || line.startsWith("@@")) {
      return true;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return true;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// count_changed_lines (Python 669-676)
// ---------------------------------------------------------------------------

/**
 * Mirror of Python `count_changed_lines`. Counts added/removed lines in the
 * diff, skipping the "+++"/"---" file-header lines.
 */
export function countChangedLines(text: string): number {
  let count = 0;
  for (const line of splitlines(text)) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// _files_touched_from_diff_text (Python 834-841)
// ---------------------------------------------------------------------------

/**
 * Mirror of Python `_files_touched_from_diff_text`. Collects the set of files
 * named by "diff --git " header lines (using the "a/" side), returning them
 * sorted and de-duplicated.
 *
 * Python uses `line.split()` (no arg) — split on whitespace runs, drop empties
 * (splitWhitespace). Sorting uses Python codepoint ordering (cpCompare), which
 * diverges from JS default sort for astral-plane characters in path names.
 */
export function filesTouchedFromDiffText(text: string): string[] {
  const files = new Set<string>();
  for (const line of splitlines(text)) {
    if (line.startsWith("diff --git ")) {
      const parts = splitWhitespace(line);
      if (parts.length >= 3 && parts[2]!.startsWith("a/")) {
        files.add(parts[2]!.slice(2));
      }
    }
  }
  return Array.from(files).sort(cpCompare);
}

// ---------------------------------------------------------------------------
// safe_rel_path (Python 517-533)
// ---------------------------------------------------------------------------

const SAFE_REL_EXCLUDED_PARTS = new Set([
  "dist",
  "build",
  ".next",
  ".venv",
  "DerivedData",
]);

/**
 * Mirror of Python `safe_rel_path`. Decides whether a repo-relative path is
 * safe to include in an untracked-file patch (excludes CCR internals, VCS dirs,
 * build outputs, and sensitive credential files).
 */
export function safeRelPath(rel: string): boolean {
  rel = strip(rel);
  const parts = posixParts(rel);
  if (rel === "" || rel.startsWith("/") || parts.includes("..")) {
    return false;
  }
  if (parts[0] === ".cmux" && parts[1] === "ccr") {
    return false;
  }
  if (parts[0] === ".open-research" && parts[1] === "logs") {
    return false;
  }
  if (parts.includes(".git") || parts.includes("node_modules")) {
    return false;
  }
  if (parts.some((part) => SAFE_REL_EXCLUDED_PARTS.has(part))) {
    return false;
  }
  const base = posixName(rel);
  if (SENSITIVE_BASENAMES.has(base) || base.startsWith(".env")) {
    return false;
  }
  return !SENSITIVE_SUFFIXES.some((suffix) => rel.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// diff_pathspecs (Python 536-553)
// ---------------------------------------------------------------------------

/**
 * Mirror of Python `diff_pathspecs`. The exact, static list of git pathspecs
 * used to scope CCR diffs (the ".(exclude)..." entries keep credentials and
 * build/VCS noise out of the review payload).
 */
export function diffPathspecs(): string[] {
  return [
    ".",
    ":(exclude).cmux/ccr/**",
    ":(exclude).git/**",
    ":(exclude).env*",
    ":(exclude)**/*.pem",
    ":(exclude)**/*.key",
    ":(exclude)**/*.p12",
    ":(exclude)**/*.pfx",
    ":(exclude)node_modules/**",
    ":(exclude)dist/**",
    ":(exclude)build/**",
    ":(exclude).next/**",
    ":(exclude).venv/**",
    ":(exclude)DerivedData/**",
    ":(exclude).open-research/logs/**",
  ];
}
