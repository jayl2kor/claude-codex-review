/**
 * review.ts — review-flow FS helpers, Phase 4a of the Python->Bun migration
 * (ccr-hook.py). The review-REQUEST markdown builders live in request.ts; this
 * module holds the small FS helpers that feed the review loop.
 *
 * Ported from ccr-hook.py: find_previous_round_dir (826-830),
 * parse_previous_review (916-933), build_worker_followup (936-948).
 *
 * Faithful port: worker-followup.md is written with a plain overwrite mirroring
 * Python's write_text (byte-identical), verified against the oracle.
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadJson } from "./io";
import { countMustFixInText } from "./decision";
import { sessionDir } from "./paths";
import { strip, cpCompare } from "./pycompat";

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

export interface PreviousReview {
  review_file: string;
  decision: string;
  must_fix_count: number;
}

export interface WorkerFollowup {
  file: string;
  message: string;
  files: string[];
}

/** Python `find_previous_round_dir` (826-830). Returns the dir path or null. */
export function findPreviousRoundDir(root: string, sid: string, roundNo: number): string | null {
  if (roundNo <= 1) {
    return null;
  }
  const prev = join(sessionDir(root, sid), "rounds", String(roundNo - 1).padStart(4, "0"));
  return isDir(prev) ? prev : null;
}

/** Python `parse_previous_review` (916-933). null when no decision.json. */
export function parsePreviousReview(prevDir: string | null): PreviousReview | null {
  if (prevDir === null) {
    return null;
  }
  const decisionPath = join(prevDir, "decision.json");
  const reviewPath = join(prevDir, "review.md");
  if (!isFile(decisionPath)) {
    return null;
  }
  const decision = (loadJson<Record<string, unknown>>(decisionPath, {}) || {}) as Record<string, unknown>;
  let mustFix = 0;
  if (isFile(reviewPath)) {
    mustFix = countMustFixInText(readFileSync(reviewPath, "utf-8"));
  }
  return {
    review_file: isFile(reviewPath) ? reviewPath : "",
    decision: String(decision.decision || ""),
    must_fix_count: mustFix,
  };
}

/**
 * Python `build_worker_followup` (936-948): persist the worker's last message as
 * worker-followup.md (only when non-empty) and return the follow-up context.
 * null when there is neither a message nor any touched files.
 */
export function buildWorkerFollowup(
  roundDir: string,
  filesTouched: string[],
  inputData: Record<string, unknown>,
): WorkerFollowup | null {
  const message = strip(String((inputData.last_assistant_message as unknown) || ""));
  const files = [...new Set(filesTouched)].sort(cpCompare);
  if (!message && files.length === 0) {
    return null;
  }
  const followupPath = join(roundDir, "worker-followup.md");
  if (message) {
    writeFileSync(followupPath, message + "\n", "utf-8");
  }
  return {
    file: message ? followupPath : "",
    message,
    files,
  };
}
