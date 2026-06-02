/**
 * Review decision parsing & must-fix counting.
 *
 * Pure (no I/O, deterministic) functions ported from the CCR runtime
 * (templates/bin/ccr-hook.py) for the Python->Bun migration.
 *
 * Fidelity-critical: mirrors the Python oracle byte-for-byte. Uses pycompat
 * helpers for splitlines/strip semantics and the shared constants module for
 * the (already-translated) regex and sentinel set.
 */

import { splitlines, strip, rstrip, lstrip } from "./pycompat";
import { DECISION_RE, MUST_FIX_SENTINELS } from "./constants";

/**
 * Parse a review message and return the decision token.
 *
 * Mirrors parse_decision (ccr-hook.py 1687-1701):
 * iterate splitlines of (message or ""), toggling a fenced-code state when a
 * left-stripped line starts with "```" or "~~~", skipping lines inside a
 * fence and blockquote lines (left-stripped line starts with ">"), then match
 * DECISION_RE against the raw (un-stripped) line. Returns the uppercased
 * capture group, else "INVALID".
 */
export function parseDecision(message: string): string {
  let inFence = false;
  for (const raw of splitlines(message || "")) {
    const stripped = lstrip(raw);
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (stripped.startsWith(">")) {
      continue;
    }
    const m = DECISION_RE.exec(raw);
    if (m) {
      return m[1].toUpperCase();
    }
  }
  return "INVALID";
}

/**
 * Whether a must-fix body is a "no real item" sentinel.
 *
 * Mirrors _is_sentinel_must_fix (ccr-hook.py 860-862):
 * normalized = strip(text).toLowerCase() with trailing ".!?" stripped, then
 * stripped again of surrounding whitespace. Returns true when normalized is
 * empty or is one of the sentinel tokens.
 */
export function isSentinelMustFix(text: string): boolean {
  const normalized = strip(rstrip(strip(text).toLowerCase(), ".!?"));
  return !normalized || MUST_FIX_SENTINELS.has(normalized);
}

/**
 * Count the real must-fix items in a review report.
 *
 * Mirrors _count_must_fix_in_text (ccr-hook.py 865-880):
 * scan splitlines; enter the section after a stripped line whose lowercase
 * form starts with "## must fix"; break on the next stripped line starting
 * with "## "; while in-section, count stripped lines starting with "- " whose
 * body (codepoints after the leading "- ") is not a sentinel.
 */
export function countMustFixInText(text: string): number {
  let count = 0;
  let inSection = false;
  for (const raw of splitlines(text)) {
    const stripped = strip(raw);
    if (stripped.toLowerCase().startsWith("## must fix")) {
      inSection = true;
      continue;
    }
    if (inSection && stripped.startsWith("## ")) {
      break;
    }
    if (inSection && stripped.startsWith("- ")) {
      const body = stripped.slice(2);
      if (isSentinelMustFix(body)) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}
