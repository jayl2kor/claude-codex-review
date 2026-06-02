/**
 * session.ts — FS-dependent session context / PNI-intent / ledger helpers,
 * Phase 4a of the Python->Bun migration (ccr-hook.py).
 *
 * The migration plan groups these under intent.ts, but they are kept in this
 * separate module so intent.ts stays PURE (oracle/differential-tested); the pure
 * PNI extraction is reused here via intent.ts. Output (file bytes / return
 * values) must match the Python runtime on the same temp-dir state — verified by
 * the phase4 oracle integration test.
 *
 * Ported from ccr-hook.py: capture_session_context (219-242), load_session_context
 * (245-252), load_session_intent (337-348), append_ledger (379-395),
 * build_iteration_table (398-439), load_review_instructions (442-460).
 *
 * Faithful port: capture/ledger writes mirror Python's write_text / open("a")
 * exactly (byte-identical files); they are intentionally NOT symlink-hardened
 * here (Python's are not either) so parity holds — hardening those paths in both
 * languages is a separate concern.
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

import { now, loadJson } from "./io";
import {
  sessionDir,
  sessionContextPath,
  sessionLedgerPath,
  sessionIntentPath,
  CONFIG_ROOT,
} from "./paths";
import { truncateText } from "./text";
import { countMustFixInText } from "./decision";
import { extractIntentFromMessage, type Intent } from "./intent";
import { INTENT_FIELDS } from "./constants";
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

/** Python f"{n:04d}" — zero-pad to >= 4 digits (never truncates). */
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Python int(name): strict integer parse (strips surrounding whitespace), else null. */
function parseRoundInt(name: string): number | null {
  const t = name.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : null;
}

/**
 * Python `capture_session_context` (219-242): overwrite context.md with the
 * worker's first prompt (truncated). No-op for an empty prompt.
 */
export function captureSessionContext(root: string, sessionId: string, prompt: string): void {
  const text = strip(prompt || "");
  if (!text) {
    return;
  }
  const path = sessionContextPath(root, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const body = [
    `<!-- captured: ${now()} -->`,
    "# Task Context",
    "",
    "Auto-captured from the worker's first user prompt of this CCR session.",
    "Edit this file freely; it is read on every review request.",
    "",
    "## Original Prompt",
    "",
    truncateText(text),
    "",
  ].join("\n");
  writeFileSync(path, body, "utf-8");
}

/** Python `load_session_context` (245-252). */
export function loadSessionContext(root: string, sessionId: string): string {
  const path = sessionContextPath(root, sessionId);
  if (!isFile(path)) {
    return "";
  }
  try {
    return strip(readFileSync(path, "utf-8"));
  } catch {
    return "";
  }
}

/**
 * Python `load_session_intent` (337-348): file-based intent.md wins (if it has
 * any field), else heuristic-extract from `fallbackMessage`.
 */
export function loadSessionIntent(
  root: string,
  sessionId: string,
  fallbackMessage: string = "",
): Intent {
  const path = sessionIntentPath(root, sessionId);
  if (isFile(path)) {
    let text = "";
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      text = "";
    }
    const parsed = extractIntentFromMessage(text);
    if (INTENT_FIELDS.some((f) => parsed[f])) {
      return parsed;
    }
  }
  return extractIntentFromMessage(fallbackMessage);
}

/** Python `append_ledger` (379-395): append a row (with header on first write). */
export function appendLedger(
  root: string,
  sessionId: string,
  roundNo: number,
  decision: string,
  mustFix: number,
  reviewFile: string,
): void {
  const path = sessionLedgerPath(root, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const headerNeeded = !isFile(path);
  const lines: string[] = [];
  if (headerNeeded) {
    lines.push(
      "# CCR Iteration Ledger",
      "",
      `Session: ${sessionId}`,
      "",
      "| Round | Decision | Must-fix | Review |",
      "| ----- | -------- | -------- | ------ |",
    );
  }
  lines.push(`| ${pad4(roundNo)} | ${decision || "INVALID"} | ${mustFix} | ${reviewFile} |`);
  appendFileSync(path, lines.join("\n") + "\n", "utf-8");
}

/**
 * Python `build_iteration_table` (398-439): compact markdown table of prior
 * rounds. "" when there is no history (first round / no rounds dir / no rows).
 */
export function buildIterationTable(root: string, sessionId: string, currentRound: number): string {
  if (currentRound <= 1) {
    return "";
  }
  const roundsDir = join(sessionDir(root, sessionId), "rounds");
  if (!isDir(roundsDir)) {
    return "";
  }
  let names: string[];
  try {
    names = readdirSync(roundsDir);
  } catch {
    return "";
  }
  names.sort(cpCompare);
  const rows: Array<[number, string, number, string]> = [];
  for (const name of names) {
    const child = join(roundsDir, name);
    if (!isDir(child)) {
      continue;
    }
    const n = parseRoundInt(name);
    if (n === null || n >= currentRound) {
      continue;
    }
    const decisionPath = join(child, "decision.json");
    const reviewPath = join(child, "review.md");
    let decision = "";
    let mustFix = 0;
    if (isFile(decisionPath)) {
      const data = (loadJson<Record<string, unknown>>(decisionPath, {}) || {}) as Record<string, unknown>;
      decision = String(data.decision || "");
    }
    if (isFile(reviewPath)) {
      try {
        mustFix = countMustFixInText(readFileSync(reviewPath, "utf-8"));
      } catch {
        /* OSError -> keep 0 */
      }
    }
    rows.push([n, decision || "INVALID", mustFix, isFile(reviewPath) ? reviewPath : ""]);
  }
  if (rows.length === 0) {
    return "";
  }
  const parts = ["| Round | Decision | Must-fix | Review |", "| ----- | -------- | -------- | ------ |"];
  for (const [n, decision, mustFix, reviewPath] of rows) {
    parts.push(`| ${pad4(n)} | ${decision} | ${mustFix} | ${reviewPath || "-"} |`);
  }
  return parts.join("\n");
}

/**
 * Python `load_review_instructions` (442-460): concatenate global
 * ($CONFIG_ROOT/instructions.md) then project (<root>/instructions.md) text.
 */
export function loadReviewInstructions(root: string): string {
  const sources: Array<[string, string]> = [
    ["global", join(CONFIG_ROOT, "instructions.md")],
    ["project", join(root, "instructions.md")],
  ];
  const sections: string[] = [];
  for (const [label, path] of sources) {
    try {
      if (isFile(path)) {
        const text = strip(readFileSync(path, "utf-8"));
        if (text) {
          sections.push(`<!-- ${label}: ${path} -->\n${text}`);
        }
      }
    } catch {
      continue;
    }
  }
  return sections.join("\n\n");
}
