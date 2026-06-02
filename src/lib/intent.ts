/**
 * intent.ts — PURE functions for PNI (Purpose / Non-goal / Invariant) intent
 * extraction, rendering, and CCR handoff detection.
 *
 * Ported faithfully (line-by-line) from ccr-hook.py:
 *   - extract_intent_from_message (Python 249-316)
 *   - render_intent_section       (Python 333-358)
 *   - is_ccr_handoff_prompt       (Python 488-498)
 *
 * No I/O, no subprocess, deterministic. Output must match the Python oracle
 * byte-for-byte, so string semantics are delegated to pycompat (splitlines /
 * strip / lstrip) and regexes/labels come from the constants module rather than
 * being re-derived here.
 *
 * Zero dependencies.
 */

import { splitlines, strip, lstrip } from "./pycompat";
import {
  INTENT_FIELDS,
  INTENT_LABELS,
  INTENT_LINE_RE,
  INTENT_HEAD_RE,
  CCR_HANDOFF_SENTINEL,
  CCR_HANDOFF_HEADER_RE,
  type IntentField,
} from "./constants";

export interface Intent {
  purpose: string;
  non_goal: string;
  invariant: string;
}

/**
 * Pull PURPOSE / NON_GOAL / INVARIANT lines from an assistant message.
 *
 * Accepts either `KEY: value` on its own line (single-line form) or a `KEY:`
 * header followed by indented / blank-separated lines until the next recognized
 * key or a blank line. Returns dict with all three fields, empty strings when
 * absent. Matching is case-insensitive on the key.
 *
 * Faithful port of Python `extract_intent_from_message` (249-316).
 */
export function extractIntentFromMessage(text: string): Intent {
  const result: Intent = { purpose: "", non_goal: "", invariant: "" };
  if (!text) {
    return result;
  }

  // Build canon_map from INTENT_LABELS: alias.toLowerCase() -> field.
  const canonMap: Record<string, IntentField> = {};
  for (const field of INTENT_FIELDS) {
    for (const alias of INTENT_LABELS[field]) {
      canonMap[alias.toLowerCase()] = field;
    }
  }

  const normKey = (raw: string): string =>
    raw.trim().toLowerCase().replace(/_/g, " ").replace(/-/g, " ");

  const lines = splitlines(text);
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i] ?? "";
    const stripped = strip(line);
    const m = INTENT_LINE_RE.exec(stripped);
    if (!m) {
      i += 1;
      continue;
    }
    const keyRaw = normKey(m[1] ?? "");
    const keyCompact = keyRaw.replace(/ /g, "");
    const field = canonMap[keyRaw] ?? canonMap[keyCompact];
    if (!field) {
      i += 1;
      continue;
    }
    let value = strip(m[2] ?? "");
    // Multi-line continuation: collect until next recognized key or blank gap.
    let j = i + 1;
    const cont: string[] = [];
    while (j < n) {
      const nxt = strip(lines[j] ?? "");
      if (!nxt) {
        // blank line: peek ahead; if next non-blank is a new key, stop.
        let k = j + 1;
        while (k < n && !strip(lines[k] ?? "")) {
          k += 1;
        }
        if (k >= n) {
          break;
        }
        const head = INTENT_HEAD_RE.exec(strip(lines[k] ?? ""));
        if (head) {
          const nxtRaw = normKey(head[1] ?? "");
          if (canonMap[nxtRaw] ?? canonMap[nxtRaw.replace(/ /g, "")]) {
            break;
          }
        }
        cont.push("");
        j += 1;
        continue;
      }
      const head = INTENT_HEAD_RE.exec(nxt);
      if (head) {
        const nxtRaw = normKey(head[1] ?? "");
        if (canonMap[nxtRaw] ?? canonMap[nxtRaw.replace(/ /g, "")]) {
          break;
        }
      }
      cont.push(nxt);
      j += 1;
    }
    if (cont.length > 0) {
      const tail = strip(cont.join("\n"));
      value = strip(value + (value && tail ? "\n" : "") + tail);
    }
    if (value && !result[field]) {
      result[field] = value;
    }
    i = j;
  }
  return result;
}

/**
 * Markdown block for `## Purpose / Non-goal / Invariant`. Empty list when intent
 * has no content.
 *
 * Faithful port of Python `render_intent_section` (333-358).
 */
export function renderIntentSection(intent: Intent | null | undefined): string[] {
  if (!intent || !INTENT_FIELDS.some((f) => intent[f])) {
    return [];
  }
  const rows: Array<[string, string]> = [
    ["Purpose", strip(intent.purpose ?? "")],
    ["Non-goal", strip(intent.non_goal ?? "")],
    ["Invariant", strip(intent.invariant ?? "")],
  ];
  const body: string[] = [
    "## Purpose / Non-goal / Invariant",
    "",
    'What this change is for and what is deliberately out of scope. Use this to judge whether the diff serves the intent and to flag scope drift. If any field is empty, treat the missing entry as a worker omission — surface it as the first Must Fix item ("intent.md is missing/incomplete"), do not return NEEDS_HUMAN for it.',
    "",
  ];
  for (const [label, value] of rows) {
    if (!value) {
      body.push(`- **${label}**: _(missing)_`);
    } else if (value.includes("\n")) {
      body.push(`- **${label}**:`);
      for (const ln of splitlines(value)) {
        body.push(`    ${ln}`);
      }
    } else {
      body.push(`- **${label}**: ${value}`);
    }
  }
  body.push("");
  return body;
}

/**
 * Detect whether a prompt is a CCR handoff message.
 *
 * Faithful port of Python `is_ccr_handoff_prompt` (488-498).
 */
export function isCcrHandoffPrompt(prompt: string): boolean {
  if (!prompt) {
    return false;
  }
  // first_line = prompt.lstrip().split("\n", 1)[0]
  const stripped = lstrip(prompt);
  const nl = stripped.indexOf("\n");
  const firstLine = nl === -1 ? stripped : stripped.slice(0, nl);
  if (firstLine.startsWith(CCR_HANDOFF_SENTINEL)) {
    return true;
  }
  // Defensive: recognize CCR's own outgoing messages by their first-line header
  // even if the `[ccr-handoff]` sentinel ever gets stripped by the transport.
  if (CCR_HANDOFF_HEADER_RE.test(firstLine)) {
    return true;
  }
  return false;
}
