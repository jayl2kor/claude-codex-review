/**
 * git.ts — git invocation + diff collection layer, Phase 3 of the Python->Bun
 * migration (ccr-hook.py). The pure diff helpers (safeRelPath, diffPathspecs,
 * diffHasContent, countChangedLines, filesTouchedFromDiffText) were ported in
 * Phase 2a (diff.ts) and are reused here; this module adds the I/O shell.
 *
 * Ported from ccr-hook.py: git (501-509), inside_git (512-514),
 * read_untracked_patch (556-586), collect_diff (632-655), compute_delta_patch
 * (810-825).
 *
 * collect_diff's full text is byte-stable: its sha256 hex (diff_hash) only
 * matches the Python runtime if every section, header, and "+"-prefixed line is
 * reproduced exactly — which the differential/integration test pins against the
 * same temp git repo.
 *
 * Zero npm deps — node:child_process / node:crypto / node:fs / node:path + lib.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { writeFileAtomic } from "./io";
import {
  safeRelPath,
  diffPathspecs,
  diffHasContent,
  countChangedLines,
  filesTouchedFromDiffText,
} from "./diff";
import { joinSections, truncateSections } from "./text";
import { splitlinesKeepends, splitlines, strip, utf8ByteLength } from "./pycompat";
import { MAX_UNTRACKED_BYTES, MAX_DIFF_BYTES } from "./constants";

// git diffs routinely exceed Node's default 1 MB spawn buffer; Python has no
// such cap, so raise it well past CCR_MAX_DIFF_BYTES to avoid silent truncation.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Python `git` (501-509): run `git -C <cwd> <args...>`, capture stdout, discard
 * stderr, never raise on non-zero exit. Returns [returncode, stdout].
 */
export function git(cwd: string, args: string[]): [number, string] {
  const proc = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  return [proc.status === null ? -1 : proc.status, proc.stdout ?? ""];
}

/** Python `inside_git` (512-514). */
export function insideGit(cwd: string): boolean {
  const [code, out] = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return code === 0 && strip(out) === "true";
}

/**
 * Python `read_untracked_patch` (556-586): synthesize a unified-diff-ish patch
 * for safe untracked files, omitting oversized / binary ones, escaping the same
 * way the Python runtime does.
 */
export function readUntrackedPatch(cwd: string): string {
  const [code, out] = git(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
  ]);
  if (code !== 0) {
    return "";
  }
  const chunks: string[] = [];
  // Python uses Path(cwd).resolve(), which canonicalizes symlinks.
  let cwdPath: string;
  try {
    cwdPath = realpathSync(cwd);
  } catch {
    cwdPath = resolve(cwd);
  }
  for (const rel of splitlines(out)) {
    if (!safeRelPath(rel)) {
      continue;
    }
    // Python computes (cwd_path / rel).resolve() and checks containment on the
    // SYMLINK-RESOLVED path, so an untracked symlink pointing outside the
    // workspace is rejected. node:path.resolve is only lexical, so statSync /
    // readFileSync would follow such a link and leak an out-of-tree file into
    // the diff; realpathSync reproduces Python's symlink-resolving behavior.
    // (A dangling/vanished entry throws here -> skipped, same net result as
    // Python's resolve(strict=False) followed by a failed is_file() check.)
    let path: string;
    try {
      path = realpathSync(resolve(cwdPath, rel));
    } catch {
      continue;
    }
    if (!path.startsWith(cwdPath + sep)) {
      continue;
    }
    // Re-validate the SYMLINK-RESOLVED repo-relative path. An in-tree symlink
    // (e.g. alias.txt -> .env.local) passes safeRelPath on the LINK name yet
    // would read an excluded-sensitive TARGET; re-running safeRelPath on the
    // resolved repo-relative path closes that leak. (Mirrors ccr-hook.py.)
    if (!safeRelPath(path.slice(cwdPath.length + 1))) {
      continue;
    }
    let raw: Buffer;
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        continue;
      }
      if (st.size > MAX_UNTRACKED_BYTES) {
        chunks.push(
          `diff --git a/${rel} b/${rel}\n# Untracked file omitted: ${st.size} bytes exceeds CCR_MAX_UNTRACKED_BYTES\n`,
        );
        continue;
      }
      raw = readFileSync(path);
    } catch {
      continue;
    }
    if (raw.includes(0)) {
      chunks.push(`diff --git a/${rel} b/${rel}\n# Untracked binary file omitted\n`);
      continue;
    }
    const text = raw.toString("utf-8");
    chunks.push(
      `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`,
    );
    for (const line of splitlinesKeepends(text)) {
      chunks.push("+" + line);
    }
    if (text && !text.endsWith("\n")) {
      chunks.push("\n\\ No newline at end of file\n");
    }
  }
  return chunks.join("");
}

/**
 * Python `collect_diff` (632-655). Returns
 *   [combined, diff_hash, head, has_content, full_changed_lines, files_touched].
 * diff_hash is the sha256 hex of the UN-truncated joined sections.
 */
export function collectDiff(
  cwd: string,
): [string, string, string, boolean, number, string[]] {
  if (!insideGit(cwd)) {
    return ["", "", "", false, 0, []];
  }
  const [, head] = git(cwd, ["rev-parse", "--short", "HEAD"]);
  const pathspecs = diffPathspecs();
  const [stagedCode, staged] = git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", ...pathspecs]);
  const [unstagedCode, unstaged] = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--", ...pathspecs]);
  // A spawn-level failure — git missing, or stdout exceeding GIT_MAX_BUFFER
  // (ENOBUFS, surfaced by git() as status === null -> -1) — yields TRUNCATED
  // stdout. Hashing/reviewing a truncated diff as if it were complete is worse
  // than skipping: bail so the round is a no-op instead of emitting a wrong-hash
  // or partial review. (git diff has no positive non-zero "success" code here.)
  if (stagedCode < 0 || unstagedCode < 0) {
    return ["", "", "", false, 0, []];
  }
  const untracked = readUntrackedPatch(cwd);
  const sections: Array<[string, string]> = [
    ["# Git HEAD", strip(head) || "unknown"],
    ["# Staged Diff", staged || ""],
    ["# Unstaged Diff", unstaged || ""],
    ["# Untracked Files", untracked || ""],
  ];
  const full = joinSections(sections);
  const hasContent = diffHasContent(full);
  const fullChangedLines = countChangedLines(full);
  const filesTouched = filesTouchedFromDiffText(full);
  const diffHash = createHash("sha256").update(full, "utf-8").digest("hex");
  let combined: string;
  if (MAX_DIFF_BYTES > 0 && utf8ByteLength(full) > MAX_DIFF_BYTES) {
    combined = truncateSections(sections, MAX_DIFF_BYTES);
  } else {
    combined = full;
  }
  return [combined, diffHash, strip(head), hasContent, fullChangedLines, filesTouched];
}

/**
 * Python `compute_delta_patch` (810-825): write a `diff -u prev current` patch to
 * dest. Returns false when either input is missing, diff errored (returncode>1),
 * or the patch is empty.
 */
export function computeDeltaPatch(
  prevDiff: string,
  currentDiff: string,
  dest: string,
): boolean {
  if (!isFile(prevDiff) || !isFile(currentDiff)) {
    return false;
  }
  const proc = spawnSync("diff", ["-u", prevDiff, currentDiff], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  const code = proc.status === null ? -1 : proc.status;
  if (code > 1) {
    return false;
  }
  const stdout = proc.stdout ?? "";
  if (!strip(stdout)) {
    return false;
  }
  // Atomic, no-follow write: a hostile pre-existing `dest` symlink is replaced
  // (renameSync replaces the name) rather than followed and clobbered.
  writeFileAtomic(dest, stdout);
  return true;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
