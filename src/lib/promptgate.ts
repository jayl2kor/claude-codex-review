/**
 * promptgate.ts — prompt-based review gating (CCR_PROMPT_GATE), pure/no-I/O.
 *
 * Two helpers feed the suppress-only gate in startReview:
 *  - promptWantsReview: a deterministic classification of the USER prompt
 *    (the runtime's own judgment when the agent emits no verdict).
 *  - suppressReason: the hybrid precedence combining the agent's verdict line
 *    (parseReviewVerdict) with promptWantsReview.
 *
 * Safety invariant: only an explicit read-only/opt-out signal (or an agent
 * "skip") ever yields suppression. "true"/"null"/"request" are inert and defer
 * to the existing diff gates, so the feature can only REMOVE an otherwise
 * eligible review, never create one.
 */
import { splitlines, strip } from "./pycompat";
import {
  PROMPT_NOREVIEW_RE,
  PROMPT_CHANGE_RE,
  PROMPT_CHANGE_KO_RE,
  PROMPT_READONLY_LEAD_RE,
  PROMPT_READONLY_KO_RE,
} from "./constants";

/** First non-empty (whitespace-stripped) line, or "" when none. */
function firstNonEmptyLine(text: string): string {
  for (const raw of splitlines(text)) {
    const line = strip(raw);
    if (line) {
      return line;
    }
  }
  return "";
}

/**
 * Classify whether the user prompt looks review-worthy.
 *   false -> read-only / explicit "no review" -> SUPPRESS
 *   true  -> a change/implement request          -> defer to diff gates
 *   null  -> ambiguous                           -> defer to diff gates
 *
 * Ordering matters: an explicit opt-out wins; then a change verb ANYWHERE wins
 * over a question-shaped lead (so "what does X do, then fix it" -> true); only
 * a clean read-only signal with no change verb yields false.
 *
 * English and Korean share this precedence. The English read-only signal is
 * LEAD-anchored (interrogatives open the sentence); the Korean one is searched
 * across the whole prompt, since Korean interrogatives/question endings fall at
 * the end (e.g. "…이는 왜인가요?").
 */
export function promptWantsReview(prompt: string): boolean | null {
  if (!prompt) {
    return null;
  }
  if (PROMPT_NOREVIEW_RE.some((re) => re.test(prompt))) {
    return false;
  }
  if (PROMPT_CHANGE_RE.some((re) => re.test(prompt)) || PROMPT_CHANGE_KO_RE.test(prompt)) {
    return true;
  }
  if (PROMPT_READONLY_LEAD_RE.test(firstNonEmptyLine(prompt)) || PROMPT_READONLY_KO_RE.test(prompt)) {
    return false;
  }
  return null;
}

/**
 * Hybrid suppress-only precedence. Returns a reason string to SUPPRESS the
 * outgoing review, or null to proceed.
 *   1. agent verdict "skip"            -> "agent_verdict_skip"
 *   2. agent verdict "request"         -> proceed (explicit override; rescues a
 *                                         review the prompt heuristic would skip)
 *   3. no verdict + prompt read-only   -> "prompt_gate_readonly"
 *   4. otherwise                       -> proceed
 */
export function suppressReason(
  verdict: "request" | "skip" | null,
  promptWants: boolean | null,
): string | null {
  if (verdict === "skip") {
    return "agent_verdict_skip";
  }
  if (verdict === "request") {
    return null;
  }
  if (promptWants === false) {
    return "prompt_gate_readonly";
  }
  return null;
}
