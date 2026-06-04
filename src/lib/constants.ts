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

export const CCR_DEFAULTS: Record<string, string> = {
  CCR_MAX_ROUNDS: "3",
  CCR_MAX_UNTRACKED_BYTES: "200000",
  CCR_MAX_DIFF_BYTES: "300000",
  CCR_MIN_DIFF_LINES: "0",
  CCR_STALE_ACTIVE_SECONDS: "1800",
  CCR_ROOT: "<cwd>/.cmux/ccr",
};

export const RUNTIME_COMMANDS = ["cmux", "claude", "codex"];

export const GENERATED_BIN_NAMES = [
  "ccr-lib.sh", "ccr-cli.js", "ccr-hook-claude", "ccr-hook-codex",
  "cmux-setup-claude", "cmux-setup-codex",
  "ccr-help", "ccr-enable", "ccr-disable", "ccr-status", "ccr-request", "ccr-reset",
  "ccr-cancel", "ccr-history", "ccr-show", "ccr-skip-next", "ccr-report",
  "ccr-doctor", "ccr-support", "ccr-ready", "ccr-selftest", "ccr-preview",
  "ccr-prune", "ccr-config", "ccr-events", "ccr-check", "ccr-uninstall",
];

export const GENERATED_CLAUDE_COMMAND_FILES = [
  "ccr-request.md", "ccr-status.md", "ccr-history.md", "ccr-skip-next.md",
  "ccr-report.md", "ccr-doctor.md", "ccr-support.md", "ccr-ready.md",
  "ccr-selftest.md", "ccr-preview.md", "ccr-prune.md", "ccr-config.md",
  "ccr-events.md", "ccr-check.md",
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
  />>/,
  /(^|[^<])>[^&]/,
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

/** Sentinels meaning "no real must-fix item" (note Korean "없음"). */
export const MUST_FIX_SENTINELS = new Set([
  "none",
  "n/a",
  "na",
  "-",
  "(none)",
  "없음",
]);
