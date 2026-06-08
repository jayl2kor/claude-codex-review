/**
 * constants.ts — module-level constants, regexes, and env-driven settings of
 * the CCR runtime (ccr-hook.py), ported to TypeScript.
 *
 * Regex translations from Python `re` to JS `RegExp` are the delicate part and
 * are kept here (single source of truth) so the leaf modules import them rather
 * than re-deriving them. IGNORECASE -> the "i" flag; Python `re.match` anchors
 * at the start of the string, which the leading `^` in each pattern reproduces.
 *
 * Zero dependencies.
 */

// ---------------------------------------------------------------------------
// Env-driven numeric settings (mirror int(os.environ.get(name, default))).
// ---------------------------------------------------------------------------
/**
 * Parse a base-10 integer with Python `int(str)` semantics: optional surrounding
 * whitespace and a single leading +/-, then digits only — the WHOLE string must
 * be a valid integer. "123abc", "", "1.0", "0x10", "- 5" all raise, matching
 * int(); JS `Number.parseInt` would silently accept "123abc" as 123 or yield
 * NaN. Throwing keeps the TS port equivalent to the Python runtime, which would
 * raise ValueError on a malformed env value.
 */
export function pyInt(value: string, context: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid integer for ${context}: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(trimmed, 10);
}

function envInt(name: string, def: string): number {
  const raw = process.env[name];
  return pyInt(raw === undefined ? def : raw, name);
}

export const MAX_ROUNDS = envInt("CCR_MAX_ROUNDS", "3");
export const MAX_UNTRACKED_BYTES = envInt("CCR_MAX_UNTRACKED_BYTES", "200000");
export const MAX_DIFF_BYTES = envInt("CCR_MAX_DIFF_BYTES", "300000");
export const MIN_DIFF_LINES = envInt("CCR_MIN_DIFF_LINES", "0");
export const STALE_ACTIVE_SECONDS = envInt("CCR_STALE_ACTIVE_SECONDS", "1800");

/**
 * Read an enum-valued env setting (trim + lowercase), throwing on an
 * unrecognized value — same fail-loud posture as pyInt/envInt rather than
 * silently falling back, so a typo surfaces immediately via ccr-doctor/selftest.
 */
function envEnum(name: string, def: string, allowed: string[]): string {
  const raw = process.env[name];
  const value = (raw === undefined ? def : raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(
      `invalid value for ${name}: ${JSON.stringify(raw)} (allowed: ${allowed.join("|")})`,
    );
  }
  return value;
}

/**
 * Effective CCR_PROMPT_GATE mode, read LIVE (not a module-eval const) so the
 * gate can be toggled per-process and per-test via process.env without the
 * frozen-constant problem. "on" = suppress non-review-worthy turns, "advisory"
 * = log-only (observe), "off" = feature disabled. Default "on".
 */
export type PromptGateMode = "on" | "off" | "advisory";
export function promptGateMode(): PromptGateMode {
  return envEnum("CCR_PROMPT_GATE", "on", ["on", "off", "advisory"]) as PromptGateMode;
}

export const CCR_DEFAULTS: Record<string, string> = {
  CCR_MAX_ROUNDS: "3",
  CCR_MAX_UNTRACKED_BYTES: "200000",
  CCR_MAX_DIFF_BYTES: "300000",
  CCR_MIN_DIFF_LINES: "0",
  CCR_STALE_ACTIVE_SECONDS: "1800",
  CCR_PROMPT_GATE: "on",
  CCR_ROOT: "<cwd>/.cmux/ccr",
};

export const RUNTIME_COMMANDS = ["cmux", "claude", "codex"];

export const GENERATED_BIN_NAMES = [
  "ccr-lib.sh", "ccr-cli.js", "ccr-hook-claude", "ccr-hook-codex",
  "cmux-setup-claude", "cmux-setup-codex",
  "ccr-help", "ccr-enable", "ccr-disable", "ccr-status", "ccr-request", "ccr-reset",
  "ccr-cancel", "ccr-history", "ccr-show", "ccr-skip-next", "ccr-report",
  "ccr-doctor", "ccr-support", "ccr-ready", "ccr-selftest", "ccr-preview",
  "ccr-prune", "ccr-config", "ccr-events", "ccr-check", "ccr-uninstall", "ccr-repair",
];

export const GENERATED_CLAUDE_COMMAND_FILES = [
  "ccr-request.md", "ccr-status.md", "ccr-history.md", "ccr-skip-next.md",
  "ccr-report.md", "ccr-doctor.md", "ccr-support.md", "ccr-ready.md",
  "ccr-selftest.md", "ccr-preview.md", "ccr-prune.md", "ccr-config.md",
  "ccr-events.md", "ccr-check.md", "ccr-repair.md",
];

// ---------------------------------------------------------------------------
// Tool / path classification.
// ---------------------------------------------------------------------------
export const MUTATING_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

export const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
];

export const SENSITIVE_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
]);

/**
 * Patterns that flag a Bash command as mutating. Mirror of MUTATING_BASH_PATTERNS,
 * each compiled with the "i" flag (the Python code passes re.IGNORECASE) and used
 * with `.test()` (search semantics, not anchored).
 */
export const MUTATING_BASH_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)rm\s+/i,
  /(^|[;&|]\s*)mv\s+/i,
  /(^|[;&|]\s*)cp\s+/i,
  /(^|[;&|]\s*)chmod\s+/i,
  /(^|[;&|]\s*)chown\s+/i,
  /(^|[;&|]\s*)git\s+(add|commit|checkout|switch|reset|clean|rebase|merge|pull|push)\b/i,
  /(^|[;&|]\s*)sed\s+-i\b/i,
  /(^|[;&|]\s*)perl\s+-pi\b/i,
  /(^|[;&|]\s*)npm\s+(install|i|update|audit\s+fix)\b/i,
  /(^|[;&|]\s*)pnpm\s+(install|add|update)\b/i,
  /(^|[;&|]\s*)yarn\s+(add|install|upgrade)\b/i,
  /(^|[;&|]\s*)pip(?:3)?\s+install\b/i,
  /(^|[;&|]\s*)cargo\s+(add|update)\b/i,
  /(^|[;&|]\s*)go\s+get\b/i,
  // Output redirection that writes to a real file (creates/overwrites → mutating).
  // Deliberately excludes read-only idioms: a /dev/null sink (`>/dev/null`,
  // `2>/dev/null`) and file-descriptor duplication (`2>&1`, `&>&1`) change no
  // files, so they must not arm an automatic review.
  />>?\s*(?!&|\/dev\/null\b)[^\s&|;>]/i,
];

// ---------------------------------------------------------------------------
// Intent (PNI) extraction.
// ---------------------------------------------------------------------------
export const INTENT_FIELDS = ["purpose", "non_goal", "invariant"] as const;
export type IntentField = (typeof INTENT_FIELDS)[number];

export const INTENT_LABELS: Record<IntentField, string[]> = {
  purpose: ["purpose", "purposes"],
  non_goal: ["non-goal", "non_goal", "nongoal", "non goal", "non-goals", "non_goals"],
  invariant: ["invariant", "invariants"],
};

/**
 * Full key:value line matcher (captures key + value). Mirrors the Python
 * pattern used with re.match; the trailing `$` anchors the end of the (already
 * stripped, single) line.
 */
export const INTENT_LINE_RE =
  /^\s*(?:[-*]\s+)?\*?\*?([A-Za-z][A-Za-z _-]*?)\*?\*?\s*:\s*(.*?)\s*$/;

/** Header-only matcher (key, no end anchor) — used to detect the next key. */
export const INTENT_HEAD_RE =
  /^\s*(?:[-*]\s+)?\*?\*?([A-Za-z][A-Za-z _-]*?)\*?\*?\s*:\s*/;

// ---------------------------------------------------------------------------
// CCR handoff detection.
// ---------------------------------------------------------------------------
export const CCR_HANDOFF_SENTINEL = "[ccr-handoff]";

export const CCR_HANDOFF_HEADER_RE =
  /^CCR\s+(?:review(?:\s+result)?\s*:|automatic\s+review\s+request\b|manual\s+review\s+request\b)/i;

// ---------------------------------------------------------------------------
// Review decision parsing & must-fix counting.
// ---------------------------------------------------------------------------
export const DECISION_RE =
  /^\s*REVIEW_DECISION:\s*(PASS|NEEDS_CHANGES|NEEDS_HUMAN)\b/i;

// ---------------------------------------------------------------------------
// Prompt-based review gating (CCR_PROMPT_GATE). Two suppress signals:
//   1. an agent-emitted final-message verdict line, and
//   2. a deterministic classification of the user prompt.
// Both can only SUPPRESS an otherwise-eligible review (never force one).
// ---------------------------------------------------------------------------

/**
 * Agent-emitted review verdict (worker's final message). Mirrors DECISION_RE's
 * shape ("i" flag, leading ^\s* anchor, \b after the token). The underscore in
 * CCR_REVIEW deliberately avoids CCR_HANDOFF_HEADER_RE's "CCR\s+" prefix, and
 * the label differs from REVIEW_DECISION:, so a verdict line is never mistaken
 * for a handoff prompt nor the reviewer's decision line.
 */
export const REVIEW_VERDICT_RE = /^\s*CCR_REVIEW:\s*(request|skip)\b/i;

/**
 * Explicit "do not review" opt-out anywhere in the prompt — strongest skip
 * signal. Includes Korean opt-out phrasings (리뷰 하지마 / 보내지마 / 필요 없 / 스킵).
 */
export const PROMPT_NOREVIEW_RE: RegExp[] = [
  /\bno\s+review\b/i,
  /\b(?:don['’]?t|do\s+not|do\s*n['’]?t)\s+review\b/i,
  /\bskip\s+(?:the\s+)?(?:ccr\s+)?review\b/i,
  /(?:리뷰|review|검토)\s*(?:는|은|를|을)?\s*(?:하지\s*마|보내지\s*마|필요\s*없|안\s*해도|생략|스킵|skip)/i,
];

/** Change/implement intent (review-worthy) — searched anywhere in the prompt. */
export const PROMPT_CHANGE_RE: RegExp[] = [
  /\b(?:implement|add|create|build|write|refactor|fix|repair|patch|change|modif(?:y|ies)|update|edit|rename|delete|remove|migrate|rewrite|convert|optimi[sz]e|improve|replace|introduce|extract|inline|bump|upgrade|downgrade|revert|disable|enable|support|set\s+up|wire\s+up|hook\s+up)\b/i,
  /\bmake\s+(?:it|the|this|them|sure)\b/i,
];

/**
 * Korean change/implement intent — searched anywhere in the prompt. Korean verbs
 * attach endings (수정해줘 / 수정하다 / 수정할), so matching the stem suffices.
 * Checked BEFORE the read-only signal so a change request still wins over a
 * question-shaped phrasing (parity with the English precedence).
 */
export const PROMPT_CHANGE_KO_RE =
  /(수정|추가|구현|변경|고쳐|고치|만들어|만들기|작성|생성|삭제|제거|교체|치환|리팩터|리팩토링|반영|적용|개선|최적화|업데이트|갱신|되돌려|롤백|병합|마이그레이션|설치|도입|바꿔|바꾸)/;

/** Question / read-only lead — matched against the FIRST non-empty line only. */
export const PROMPT_READONLY_LEAD_RE =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|hey,?\s+)?(?:what|why|how|when|where|which|who|whose|explain|describe|summar(?:y|ize|ise)|show|list|read|print|display|tell\s+me|walk\s+me\s+through|is|are|was|were|does|do|did|can|should|would|could|will|review)\b/i;

/**
 * Korean question / read-only intent — searched ANYWHERE (not lead-anchored).
 * Korean interrogatives (왜, 무엇, 어떻게 …) and polite question endings
 * (…인가요?, …나요?, …습니까?) typically fall at the END of the sentence, so an
 * English-style lead anchor would miss e.g. "…이는 왜인가요?". Only consulted
 * after the change-intent check, so it can suppress a review but never force one.
 */
export const PROMPT_READONLY_KO_RE =
  /(?:왜|어째서|무엇|뭐|뭔|무슨|어떻게|어떤|어느|언제|어디|누가|누구|설명|알려|보여|읽어|출력|확인|궁금)|(?:인가요|일까요|ㄹ까요|을까요|나요|가요|습니까|ㅂ니까|는가|은가)\s*[?？]?\s*$/m;

/** Sentinels meaning "no real must-fix item" (note Korean "없음"). */
export const MUST_FIX_SENTINELS = new Set([
  "none",
  "n/a",
  "na",
  "-",
  "(none)",
  "없음",
]);
