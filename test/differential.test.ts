/**
 * differential.test.ts — ORACLE-BASED differential test for the CCR leaf modules.
 *
 * Purpose: prove the ported TypeScript leaf modules (src/lib/{text,diff,decision,
 * intent,tool,misc}.ts) behave IDENTICALLY to the Python runtime in
 * templates/bin/ccr-hook.py, which is the single source of truth.
 *
 * Design:
 *   - For each ported function we define a RICH corpus of input cases covering
 *     edge cases (empty/whitespace, CJK + astral emoji, \r\n / bare \r / \v / \f,
 *     trailing newlines, code fences, blockquotes, sentinels, sensitive paths,
 *     mutating bash variants, byte-budget extremes, etc.).
 *   - Each case is sent to the Python oracle via test/golden-probe.py (spawnSync
 *     python3, parsing {result} from stdout only — robust to noisy shell stderr)
 *     AND to the TS function. We assert deepEqual(tsResult, oracleResult).
 *   - The expected value is ALWAYS produced by the probe at runtime; nothing is
 *     hardcoded. The oracle decides; if TS disagrees, the TS (src/lib) is wrong.
 *
 * Constraints honored:
 *   - Read-only w.r.t. ccr.sh / README / templates/bin/ccr-hook.py.
 *   - Zero npm runtime deps: only Bun built-ins + node:* stdlib.
 *
 * Run with: `bun test test/differential.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sanitize,
  opposite,
  joinSections,
  truncateSections,
  truncateText,
  fencedMarkdownBlock,
  formatDuration,
} from "../src/lib/text.ts";
import {
  diffHasContent,
  countChangedLines,
  filesTouchedFromDiffText,
  safeRelPath,
  diffPathspecs,
} from "../src/lib/diff.ts";
import {
  parseDecision,
  isSentinelMustFix,
  countMustFixInText,
} from "../src/lib/decision.ts";
import {
  extractIntentFromMessage,
  renderIntentSection,
  isCcrHandoffPrompt,
} from "../src/lib/intent.ts";
import {
  toolName,
  toolCommand,
  bashLooksMutating,
  shouldMarkDirtyForTool,
} from "../src/lib/tool.ts";
import {
  defaultState,
  reviewerBlockResponse,
  doctorNextMessage,
  doctorActionItems,
} from "../src/lib/misc.ts";
import { requestMarkdown, scopeRequestMarkdown } from "../src/lib/request.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "golden-probe.py");

// Importing the runtime via the probe would otherwise drop __pycache__/*.pyc
// next to templates/bin/ccr-hook.py and pollute the working tree; suppress
// bytecode at the process level — every spawnSync below inherits this env.
process.env.PYTHONDONTWRITEBYTECODE = "1";

/**
 * Extract the JSON payload from probe stdout. The user's shell profile can emit
 * noise on stderr (and conceivably a stray line on stdout) during python3
 * startup, but the probe writes its JSON object as the final stdout line. Try
 * the whole string first, then fall back to the last line that parses as JSON.
 * (Mirrors the robust approach in test/golden.test.ts.)
 */
function parseProbeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to line-by-line recovery.
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning upward
    }
  }
  throw new Error(`no JSON found in probe stdout:\n${stdout}`);
}

/** Call the Python oracle with a function name + args, return parsed `result`. */
function oracle(fn: string, args: unknown[]): unknown {
  const proc = spawnSync("python3", [PROBE, fn, JSON.stringify(args)], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (proc.error) {
    throw new Error(`failed to spawn python3: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(
      `probe exited ${proc.status} for ${fn}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }
  const parsed = parseProbeJson(proc.stdout) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  if (!parsed.ok) {
    throw new Error(`probe reported failure for ${fn}: ${parsed.error}`);
  }
  return parsed.result;
}

/**
 * One differential case: a Python oracle name, the args array (shared by both
 * sides), and the TS function to call. We register one Bun `test` per case so a
 * failure pinpoints the exact offending input.
 */
interface Case {
  pyName: string;
  args: unknown[];
  ts: (...args: any[]) => unknown;
}

// ---------------------------------------------------------------------------
// Shared edge-case string fragments (constructed so the source stays readable).
// ---------------------------------------------------------------------------
const CJK = "한국어 리뷰 자동화";
const EMOJI = "💥🧨👩‍👩‍👧‍👦"; // astral + ZWJ sequence
const CRLF = "\r\n";
const CR = "\r";
const VT = ""; // \v
const FF = ""; // \f
const NEL = "\u0085";
const LSEP = " ";
const PSEP = " ";

let CASES: Case[] = [];
const add = (pyName: string, ts: Case["ts"], ...args: unknown[]): void => {
  CASES.push({ pyName, args, ts });
};

// ===========================================================================
// text.ts
// ===========================================================================

// sanitize — strip()-or-"unknown", then replace non [A-Za-z0-9_.-] with "_".
for (const s of [
  "",
  "   ",
  "\t\n\v\f\r ",
  "hello world",
  "a/b\\c:d*e?f",
  "Repo Name 2.0",
  "..--__",
  CJK,
  EMOJI,
  "  trim me  ",
  "no-break space",
  "tab\tsep",
  "newline\nin\nmiddle",
  "已经-OK.v1",
  "!@#$%^&*()",
  // Path-control segments: all-dots must be remapped to underscores so a
  // sanitized id can never escape its parent dir.
  ".",
  "..",
  "...",
  "  ..  ",
]) {
  add("sanitize", sanitize, s);
}

// opposite
for (const s of ["claude", "codex", "Claude", "CLAUDE", "", "other", " claude "]) {
  add("opposite", opposite, s);
}

// _join_sections / joinSections — list of [label, body] tuples.
const sectionSets: Array<Array<[string, string]>> = [
  [],
  [["# A", "body a"]],
  [
    ["# A", "body a"],
    ["# B", "body b"],
  ],
  [
    ["# Diff", `line1\nline2${CRLF}line3`],
    ["# Git HEAD", "abc123"],
    ["# Notice", ""],
  ],
  [
    ["# CJK", CJK],
    ["# Emoji", EMOJI],
  ],
  [["", ""]],
  [["label\nwith\nnewline", "body"]],
];
for (const secs of sectionSets) {
  add("_join_sections", joinSections, secs);
}

// _truncate_sections / truncateSections — byte-budget edge cases incl multibyte.
const truncSecs: Array<Array<[string, string]>> = [
  [
    ["# A", "aaaa"],
    ["# B", "bbbb"],
  ],
  [
    ["# Diff", "x".repeat(500)],
    ["# Git HEAD", "deadbeef"],
    ["# Context", "y".repeat(500)],
    ["# Intent", "z".repeat(500)],
  ],
  [
    ["# Diff", CJK.repeat(50)],
    ["# Git HEAD", "abc"],
    ["# More", EMOJI.repeat(40)],
  ],
  [
    ["# OnlyOne", "x".repeat(100)],
    ["# Two", "y".repeat(100)],
  ],
  [
    ["# Notice", "n".repeat(200)],
    ["# Git HEAD", "g".repeat(200)],
  ],
  [
    ["# Diff", "多字节内容".repeat(30)],
    ["# Git HEAD", "h"],
    ["# Extra1", "a".repeat(100)],
    ["# Extra2", "b".repeat(100)],
    ["# Extra3", "c".repeat(100)],
  ],
];
for (const secs of truncSecs) {
  for (const maxBytes of [0, 1, 5, 10, 20, 50, 100, 200, 500, 1000, 5000]) {
    add("_truncate_sections", truncateSections, secs, maxBytes);
  }
}

// _truncate_text / truncateText — codepoint-based slicing, multibyte/astral.
const truncTextInputs = [
  "",
  "short",
  "x".repeat(50),
  CJK.repeat(20),
  EMOJI.repeat(20),
  `${CJK}\n${EMOJI}\n${"z".repeat(40)}`,
  "trailing newline\n",
];
for (const t of truncTextInputs) {
  for (const maxChars of [0, 1, 2, 3, 5, 10, 12, 25, 12000]) {
    add("_truncate_text", truncateText, t, maxChars);
  }
}
// Also exercise the default max_chars (single-arg form).
add("_truncate_text", (t: string) => truncateText(t), "tiny");

// _fenced_markdown_block / fencedMarkdownBlock — backtick runs + rstrip.
const fenceInputs = [
  "",
  "plain text",
  "a`b",
  "a``b",
  "a```b",
  "````````",
  "```\ncode\n```",
  "trailing whitespace   \n\t  ",
  `${CJK} \`\`\` ${EMOJI}`,
  "ends with ticks ```",
  "no ticks but \v vertical tab",
  "tilde ~~~ not a backtick",
];
for (const t of fenceInputs) {
  add("_fenced_markdown_block", fencedMarkdownBlock, t);
  add("_fenced_markdown_block", fencedMarkdownBlock, t, "python");
}

// _format_duration / formatDuration — integer division across boundaries.
for (const sec of [
  -1, -100, 0, 1, 30, 59, 60, 61, 90, 119, 120, 3599, 3600, 3601, 3660, 7199,
  7200, 86399, 90061,
]) {
  add("_format_duration", formatDuration, sec);
}

// ===========================================================================
// diff.ts
// ===========================================================================

const diffTexts = [
  "",
  "   ",
  "no diff markers here",
  "--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other",
  "diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new",
  `+added${CRLF}-removed${CR}+more`,
  "+++ header only\n--- header only",
  "@@ hunk @@\n context",
  `+${CJK}\n-${EMOJI}`,
  "+\n-\n+++\n---",
  `line with ${VT} vtab\n+real add`,
  "diff --git a/path/with space b/path\n+x",
  "----\n++++\n-x\n+y",
  "trailing newline diff\n+a\n",
];
for (const t of diffTexts) {
  add("_diff_has_content", diffHasContent, t);
  add("count_changed_lines", countChangedLines, t);
}

// _files_touched_from_diff_text / filesTouchedFromDiffText
const filesDiffTexts = [
  "",
  "diff --git a/foo b/foo\n@@\n+x",
  "diff --git a/z.txt b/z.txt\ndiff --git a/a.txt b/a.txt\ndiff --git a/m.txt b/m.txt",
  "diff --git b/only b/only\n+x", // not a/ prefixed -> skipped
  "diff --git a/foo b/foo\ndiff --git a/foo b/foo", // dup -> de-dup
  "diff --git    a/spaced   b/spaced\n+y", // whitespace runs
  `diff --git a/${CJK}.md b/${CJK}.md\n+z`,
  "diff --git a/dir/sub/file.ts b/dir/sub/file.ts",
  "diff --git\n+incomplete header (too few parts)",
  "diff --git a/B.txt b/B.txt\ndiff --git a/a.txt b/a.txt", // sort order B vs a (ASCII)
  "diff --git a/Z b/Z\ndiff --git a/_ b/_\ndiff --git a/A b/A",
  // codepoint vs UTF-16 sort: U+E000 (BMP PUA) must sort BEFORE U+1F4A5 (astral),
  // which only holds with cpCompare (default JS sort would flip them).
  "diff --git a/\u{1F4A5}.txt b/\u{1F4A5}.txt\ndiff --git a/\uE000.txt b/\uE000.txt",
  // Python str.split() whitespace set: FS (U+001C) and NEL (U+0085) separate the
  // header fields; JS \s-based split would NOT treat these as separators.
  "diff --git\u001Ca/fs.txt\u0085b/fs.txt\n+x",
];
for (const t of filesDiffTexts) {
  add("_files_touched_from_diff_text", filesTouchedFromDiffText, t);
}

// safe_rel_path / safeRelPath — sensitive/sneaky paths.
const relPaths = [
  "",
  "   ",
  "src/app.ts",
  "/etc/passwd",
  "a/../b",
  "../escape",
  "./.cmux/ccr",
  ".cmux/ccr/state.json",
  ".cmux/other.json",
  ".open-research/logs/run.log",
  ".open-research/notes.md",
  ".git/config",
  "node_modules/x",
  "deep/node_modules/pkg/index.js",
  "dist/bundle.js",
  "build/out",
  ".next/cache",
  ".venv/lib",
  "DerivedData/x",
  "foo/.env.local",
  ".env",
  ".env.production",
  "config.env", // basename "config.env" does NOT start with .env
  "secret.pem",
  "x.pem",
  "certs/server.key",
  "a.p12",
  "a.pfx",
  "a.crt",
  "a.cer",
  "id_rsa",
  "ssh/id_ed25519",
  "known_hosts",
  "authorized_keys",
  "src/./nested/file.js",
  "trailing/slash/",
  "a//b//c",
  "PEM.txt", // ends with neither, fine
  "file.PEM", // case-sensitive suffix check
  `${CJK}/파일.ts`,
];
for (const p of relPaths) {
  add("safe_rel_path", safeRelPath, p);
}

// diff_pathspecs / diffPathspecs — static list (no args).
add("diff_pathspecs", diffPathspecs);

// ===========================================================================
// decision.ts
// ===========================================================================

const decisionInputs = [
  "",
  "   ",
  "REVIEW_DECISION: PASS\nrest",
  "preamble\nREVIEW_DECISION: NEEDS_CHANGES",
  "REVIEW_DECISION: pass",
  "REVIEW_DECISION:   NEEDS_HUMAN  ",
  "no decision here",
  "Example format:\n```\nREVIEW_DECISION: PASS\n```\nActual verdict:\nREVIEW_DECISION: NEEDS_CHANGES\n",
  "> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n",
  "~~~\nREVIEW_DECISION: PASS\n~~~\nREVIEW_DECISION: NEEDS_CHANGES",
  "```python\nREVIEW_DECISION: PASS\n```", // fenced only -> INVALID
  "   ```\nREVIEW_DECISION: PASS\n   ```\nREVIEW_DECISION: NEEDS_HUMAN", // indented fences
  ">    REVIEW_DECISION: PASS", // blockquote only
  "REVIEW_DECISION: PASSING", // \b boundary: "PASS" then "ING" -> no \b after PASS
  "REVIEW_DECISION: PASS.",
  "REVIEW_DECISION:PASS", // no space after colon
  "  REVIEW_DECISION: needs_changes extra",
  "review_decision: pass", // case-insensitive whole pattern
  `REVIEW_DECISION: PASS${CR}REVIEW_DECISION: NEEDS_HUMAN`, // bare CR splits
  `line1${VT}REVIEW_DECISION: PASS`, // \v is a line boundary in splitlines
  "unterminated fence ```\nREVIEW_DECISION: PASS", // opens fence, never closes
  "REVIEW_DECISION: NEEDS_CHANGES\nREVIEW_DECISION: PASS", // first wins
  "text\n```\nfenced\n```\nmore\n```\nREVIEW_DECISION: PASS\n```", // PASS inside 2nd fence
  `${CJK}\nREVIEW_DECISION: NEEDS_HUMAN`,
];
for (const m of decisionInputs) {
  add("parse_decision", parseDecision, m);
}

// _is_sentinel_must_fix / isSentinelMustFix
const sentinelInputs = [
  "",
  "   ",
  "None",
  "none",
  "None.",
  "None!?",
  "N/A",
  "n/a",
  "na",
  "NA",
  "-",
  "(none)",
  "없음",
  "없음.",
  "  없음  ",
  "a real one",
  "none of the above", // not a sentinel (extra words)
  "...",
  ".!?",
  "PASS.",
  "n/a.....",
  `${EMOJI}`,
  "  -  ",
  "(NONE)",
];
for (const t of sentinelInputs) {
  add("_is_sentinel_must_fix", isSentinelMustFix, t);
}

// _count_must_fix_in_text / countMustFixInText
const mustFixInputs = [
  "",
  "## Must Fix\n- None.\n\n## Looks Good\n- ok\n",
  "## Must Fix\n- N/A\n- -\n- (none)\n- 없음\n",
  "## Must Fix\n- a real one\n- another\n",
  "## Must Fix\n- None.\n- a real one\n",
  "## MUST FIX\n- item one\n- item two\n", // case-insensitive heading
  "##   must fix details\n- only one\n", // heading prefix match
  "no section here\n- not counted\n",
  "## Must Fix\n  - indented item\n", // stripped before "- " check
  "## Must Fix\n- item\n## Next Section\n- not counted\n", // break on next "## "
  "## Must Fix\n-no space after dash\n- valid\n", // "-x" not "- x"
  "## Must Fix\n- 없음\n- real\n- none\n- another real\n",
  `## Must Fix\n- ${CJK}\n- ${EMOJI}\n`,
  "## Must Fix\r\n- crlf item\r\n- second\r\n",
  "## must fix\n- a\n\n- b\n\n## done", // blank lines between items
  "intro\n## Must Fix\n- x\nmid text\n- y\n",
  "## Must Fixing things\n- counts since prefix matches\n", // "## must fix" is a prefix
];
for (const t of mustFixInputs) {
  add("_count_must_fix_in_text", countMustFixInText, t);
}

// ===========================================================================
// intent.ts
// ===========================================================================

const intentInputs = [
  "",
  "   ",
  "just a normal commit message",
  "PURPOSE: x\nNON-GOAL: y\nINVARIANT: z",
  "purpose: lower\nnongoal: also\ninvariants: plural",
  "Purpose: single line value here",
  "**Purpose:** bold marker value", // bold ** markers
  "- Purpose: list-prefixed value",
  "* Invariant: star-prefixed",
  "- invariant: keep API stable", // list-prefixed invariant
  "PURPOSE:\n  continued line one\n  continued line two\nNON-GOAL: stop",
  "Purpose: first\n\nstill purpose after blank\n\nNON_GOAL: ng", // blank-gapped block
  "Purpose:\n\n\n  deep after blanks\nINVARIANT: i",
  "Purpose: p\nUnknownKey: ignored\nInvariant: i",
  "purpose: dup1\npurpose: dup2", // first non-empty wins
  "Purpose:   \nNON-GOAL: real", // empty purpose value, then continuation
  `Purpose: ${CJK}\nNon-goal: ${EMOJI}\nInvariant: 불변식`,
  "Non goal: spaced key\nInvariant: i", // "non goal" alias
  "PURPOSES: plural purpose\nNON-GOALS: plural ng",
  "Purpose: line1\nline2\nline3\nNON-GOAL: ng", // multiline continuation until next key
  "  **Invariant:**\n    must hold\n    also this",
  "Purpose: a\r\nNon-goal: b\r\nInvariant: c", // CRLF
  "random\nPurpose: mid\nrandom2\nNon-goal: ng2\n",
  "Purpose: trailing\n", // trailing newline
  "nongoal:compact\ninvariant:tight", // no space after colon
  "Purpose: with: embedded colon",
  "Purpose:\nfollowing\n\n\n\nNon-goal: after big gap",
  `Purpose: p1${VT}Non-goal: vt-separated`, // \v boundary
];
for (const t of intentInputs) {
  add("extract_intent_from_message", extractIntentFromMessage, t);
}

// render_intent_section / renderIntentSection — pass intent dicts.
const intentDicts = [
  { purpose: "", non_goal: "", invariant: "" },
  { purpose: "p", non_goal: "", invariant: "i" },
  { purpose: "only purpose", non_goal: "", invariant: "" },
  { purpose: "line1\nline2", non_goal: "ng", invariant: "inv" }, // multiline value
  { purpose: `${CJK}`, non_goal: `${EMOJI}`, invariant: "불변" },
  { purpose: "  spaces around  ", non_goal: "", invariant: "" }, // stripped
  { purpose: "a\nb\nc", non_goal: "", invariant: "" },
  {},
  { purpose: "p" },
];
for (const d of intentDicts) {
  add("render_intent_section", renderIntentSection as (...a: any[]) => unknown, d);
}

// is_ccr_handoff_prompt / isCcrHandoffPrompt
const handoffInputs = [
  "",
  "[ccr-handoff]\n...",
  "[ccr-handoff]\n자동 리뷰 요청입니다",
  "please [ccr-handoff] later",
  "normal",
  "  [ccr-handoff] leading spaces", // lstrip then first line
  "\n\n[ccr-handoff]\nafter blank lines",
  "CCR review: something",
  "CCR Review Result: PASS",
  "CCR automatic review request for foo",
  "CCR manual review request",
  "ccr review: lower-case header",
  "Not CCR review",
  `[ccr-handoff]${CRLF}windows`,
  "CCR  review:  extra spaces",
  `CCR review result : ${CJK}`,
  "[ccr-handoff]", // sentinel only, no newline
];
for (const p of handoffInputs) {
  add("is_ccr_handoff_prompt", isCcrHandoffPrompt, p);
}

// ===========================================================================
// tool.ts
// ===========================================================================

const toolInputs: unknown[] = [
  {},
  { tool_name: "Edit" },
  { tool_name: "Write" },
  { tool_name: "MultiEdit" },
  { tool_name: "NotebookEdit" },
  { tool_name: "apply_patch" },
  { tool_name: "Read" },
  { tool_name: "" },
  { tool: { name: "Edit" } },
  { tool: { name: "Bash" }, tool_input: { command: "rm -rf x" } },
  { tool_name: "Bash", tool_input: { command: "pytest" } },
  { tool_name: "Bash", tool_input: { command: "ls -la" } },
  { tool_name: "Bash", tool_input: { command: "echo hi" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
  { tool_name: "Bash", tool_input: { command: "a && rm x" } },
  { tool_name: "Bash", tool_input: { command: "mv a b" } },
  { tool_name: "Bash", tool_input: { command: "cp a b" } },
  { tool_name: "Bash", tool_input: { command: "chmod +x f" } },
  { tool_name: "Bash", tool_input: { command: "chown me f" } },
  { tool_name: "Bash", tool_input: { command: "git add ." } },
  { tool_name: "Bash", tool_input: { command: "git commit -m x" } },
  { tool_name: "Bash", tool_input: { command: "git status" } }, // not mutating subcommand
  { tool_name: "Bash", tool_input: { command: "git push origin main" } },
  { tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' f" } },
  { tool_name: "Bash", tool_input: { command: "sed s/a/b/ f" } }, // no -i
  { tool_name: "Bash", tool_input: { command: "perl -pi -e x f" } },
  { tool_name: "Bash", tool_input: { command: "npm install" } },
  { tool_name: "Bash", tool_input: { command: "npm i lodash" } },
  { tool_name: "Bash", tool_input: { command: "npm run build" } }, // not mutating
  { tool_name: "Bash", tool_input: { command: "npm audit fix" } },
  { tool_name: "Bash", tool_input: { command: "pnpm add react" } },
  { tool_name: "Bash", tool_input: { command: "pnpm install" } },
  { tool_name: "Bash", tool_input: { command: "yarn add foo" } },
  { tool_name: "Bash", tool_input: { command: "yarn upgrade" } },
  { tool_name: "Bash", tool_input: { command: "pip install requests" } },
  { tool_name: "Bash", tool_input: { command: "pip3 install requests" } },
  { tool_name: "Bash", tool_input: { command: "cargo add serde" } },
  { tool_name: "Bash", tool_input: { command: "cargo build" } }, // not mutating
  { tool_name: "Bash", tool_input: { command: "go get ./..." } },
  { tool_name: "Bash", tool_input: { command: "echo x >> f" } }, // >> redirect
  { tool_name: "Bash", tool_input: { command: "echo x > y" } }, // > redirect
  { tool_name: "Bash", tool_input: { command: "printf x > app.py" } },
  { tool_name: "Bash", tool_input: { command: "cmd 2>&1" } }, // >& should NOT match >[^&]
  { tool_name: "Bash", tool_input: { command: "diff <(a) <(b)" } }, // < then > guard
  { tool_name: "Bash", tool_input: { command: "ccr-reset" } },
  { tool_name: "Bash", tool_input: { command: "ccr-status" } },
  { tool_name: "Bash", tool_input: { command: "RM lower guard" } }, // case-insensitive
  { tool_name: "Bash", tool_input: { command: "GIT COMMIT -m x" } },
  { tool_name: "Bash", tool_input: { command: "" } },
  { tool_name: "Bash" }, // no tool_input
  { tool_name: "Bash", tool_input: { command: `rm ${CJK}` } },
  { tool: { input: { command: "rm x" }, name: "Bash" } }, // tool.input.command path
  { tool: { name: "Bash" } }, // tool present, no input
  { tool_input: { command: "rm x" } }, // no tool_name, no tool -> name ""
  { tool_name: null, tool: { name: "Write" } }, // falsy tool_name falls through
  { tool_name: 0, tool: { name: "Edit" } }, // falsy numeric
  { tool_name: "Bash", tool_input: { command: "true; rm x" } }, // separator ;
  { tool_name: "Bash", tool_input: { command: "a | rm x" } }, // pipe separator
];
for (const d of toolInputs) {
  add("tool_name", toolName as (...a: any[]) => unknown, d);
  add("tool_command", toolCommand as (...a: any[]) => unknown, d);
  add("should_mark_dirty_for_tool", shouldMarkDirtyForTool as (...a: any[]) => unknown, d);
}

// bash_looks_mutating — direct command strings (string-only inputs).
const bashCommands = [
  "",
  "ls",
  "pytest",
  "rm x",
  "rm",
  "  rm x", // leading spaces (no separator before rm) -> ^ fails, [;&|] fails
  "echo rm x", // "rm" not at start/after separator
  "a && rm x",
  "a&&rm x", // no space before rm after &
  "a ; rm x",
  "a|rm x",
  "git rebase main",
  "git merge feature",
  "git pull",
  "git log", // not mutating
  "sed -i.bak s/a/b/ f", // -i.bak -> \b after -i? "-i." boundary
  "npm update",
  "pip install -r req.txt",
  "go get example.com/x",
  "cargo update -p foo",
  "echo a > b",
  "echo a >> b",
  "cmd 1>&2", // >& guard
  "cmd > out 2> err",
  ">redirect at start",
  "echo done",
  `mv ${EMOJI} dest`,
];
for (const c of bashCommands) {
  add("bash_looks_mutating", bashLooksMutating, c);
}

// ===========================================================================
// misc.ts
// ===========================================================================

add("default_state", defaultState);

for (const agent of ["codex", "claude", "", "Codex", "other"]) {
  for (const reason of ["blocked", "", `multi\nline ${CJK}`, EMOJI]) {
    add("reviewer_block_response", reviewerBlockResponse, agent, reason);
  }
}

for (const fail of [0, 1, 5]) {
  for (const warn of [0, 1, 3]) {
    add("_doctor_next_message", doctorNextMessage, fail, warn);
  }
}

// _doctor_action_items / doctorActionItems — varied row shapes.
const doctorRowSets: Array<Array<Record<string, string>>> = [
  [],
  [{ status: "ok", name: "PATH", detail: "" }],
  [{ status: "fail", name: "command: cmux", detail: "missing" }],
  [{ status: "warn", name: "command: claude code", detail: "" }], // split on first ": "
  [{ status: "fail", name: "PATH", detail: "" }],
  [
    { status: "fail", name: "installed command files", detail: "" },
    { status: "fail", name: "Claude hooks", detail: "" },
    { status: "fail", name: "Codex hooks", detail: "" },
  ], // all map to same action -> de-dup to 1
  [{ status: "warn", name: "cmux surface", detail: "" }],
  [{ status: "warn", name: "registered current surface", detail: "" }],
  [{ status: "warn", name: "registered Claude surface", detail: "" }],
  [{ status: "warn", name: "registered Codex surface", detail: "" }],
  [{ status: "fail", name: "workspace enabled", detail: "" }],
  [{ status: "fail", name: "git repository", detail: "" }],
  [{ status: "fail", name: "CCR runtime root", detail: "" }],
  [{ status: "warn", name: "active request", detail: "" }],
  [{ status: "warn", name: "skip-next marker", detail: "/path/to/marker" }],
  [{ status: "fail", name: "unknown thing", detail: "some detail" }], // else branch
  [{ status: "ok", name: "everything ok", detail: "" }], // only ok -> fallback message
  [
    { status: "fail", name: "command: tool-a", detail: "" },
    { status: "fail", name: "command: tool-a", detail: "" }, // dup action de-dup
    { status: "fail", name: "command: tool-b", detail: "" },
    { status: "ok", name: "command: skip", detail: "" }, // ok skipped
  ],
  [
    { status: "warn", name: "skip-next marker", detail: `${CJK}/mark` },
    { status: "fail", name: "another", detail: `${EMOJI}` },
  ],
  [{ name: "no status field", detail: "x" }], // missing status -> "" != ok
];
for (const rows of doctorRowSets) {
  add("_doctor_action_items", doctorActionItems as (...a: any[]) => unknown, rows);
}

// ===========================================================================
// request.ts — requestMarkdown / scopeRequestMarkdown (Phase 2b pure builders)
// ===========================================================================

// request_markdown — positional args mirror the Python signature:
//   (worker, reviewer, round_no, diff_hash, head, diff_file,
//    delta_file?, previous_review?, worker_followup?, instructions?,
//    task_context?, iteration_table?, intent?)
// Partial arrays exercise the defaults on BOTH sides (probe `fn(*args)` and the
// TS defaults), so the optional tail is covered incrementally.
const ITER_TABLE =
  "| Round | Decision | Must-fix | Review |\n" +
  "| ----- | -------- | -------- | ------ |\n" +
  "| 0001 | NEEDS_CHANGES | 3 | /p/r/0001/review.md |";
const requestArgSets: unknown[][] = [
  // Minimal (6 required args), empty head -> "unknown".
  ["claude", "codex", 1, "deadbeef", "", "/p/diff.patch"],
  ["claude", "codex", 1, "abc123", "f00ba4", "/p/diff.patch"],
  // delta_file present.
  ["codex", "claude", 2, "h2", "head2", "/p/diff.patch", "/p/delta.patch"],
  // intent only (must pass the whole positional tail up to intent).
  [
    "claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "", "",
    { purpose: "ship CCR phase 2b", non_goal: "no FS port", invariant: "byte parity" },
  ],
  // intent with empty/missing fields -> some "(missing)".
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "", "", { purpose: "only purpose" }],
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "", "", {}],
  // multiline intent value -> indented rendering.
  [
    "claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "", "",
    { purpose: "line1\nline2\nline3", non_goal: "ng", invariant: `${CJK}` },
  ],
  // task_context only.
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "  build the markdown builder  ", ""],
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", `${CJK}\n${EMOJI}`, ""],
  // task_context whitespace-only -> section omitted.
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "", "   \n\t ", ""],
  // iteration_table only.
  ["claude", "codex", 3, "h", "head", "/p/d", "/p/delta", null, null, "", "", ITER_TABLE],
  // instructions only.
  ["claude", "codex", 1, "h", "head", "/p/d", null, null, null, "Use tabs.\nNo console.log.", "", ""],
  // previous_review only.
  [
    "claude", "codex", 2, "h", "head", "/p/d", null,
    { review_file: "/p/r/0001/review.md", decision: "NEEDS_CHANGES", must_fix_count: 3 },
  ],
  // previous_review with missing keys -> defaults ("" / 0).
  ["claude", "codex", 2, "h", "head", "/p/d", null, {}],
  ["claude", "codex", 2, "h", "head", "/p/d", null, { decision: "PASS" }],
  // worker_followup: message present + file + files + delta.
  [
    "claude", "codex", 2, "h", "head", "/p/d", "/p/delta", null,
    { file: "/p/r/0002/worker-followup.md", message: "Applied items 1-3.\nItem 4 not applied because X.", files: ["b.ts", "a.ts", "a.ts"] },
  ],
  // worker_followup: no message -> "did not provide" line; no delta.
  [
    "claude", "codex", 2, "h", "head", "/p/d", null, null,
    { file: "", message: "", files: ["only.ts"] },
  ],
  // worker_followup: empty -> just header (no file/files/message lines).
  ["claude", "codex", 2, "h", "head", "/p/d", null, null, {}],
  // worker_followup: message with backtick runs -> fence escalation.
  [
    "claude", "codex", 2, "h", "head", "/p/d", null, null,
    { file: "/p/f.md", message: "see ```js\ncode\n``` and ````longer```` fence", files: [] },
  ],
  // worker_followup: long message -> truncateText (>12000 cp) kicks in.
  [
    "claude", "codex", 2, "h", "head", "/p/d", null, null,
    { file: "/p/f.md", message: "x".repeat(13000), files: ["f.ts"] },
  ],
  // worker_followup: CJK + emoji message.
  [
    "claude", "codex", 2, "h", "head", "/p/d", null, null,
    { file: "/p/f.md", message: `${CJK}\n${EMOJI}`, files: [`${CJK}.ts`] },
  ],
  // Everything at once.
  [
    "claude", "codex", 4, "hash4", "headrev", "/p/diff.patch", "/p/delta.patch",
    { review_file: "/p/r/0003/review.md", decision: "NEEDS_CHANGES", must_fix_count: 2 },
    { file: "/p/r/0004/worker-followup.md", message: "Reworked the parser.", files: ["x.ts", "y.ts"] },
    "Prefer const.\nWrite tests first.",
    "Finish the migration without breaking parity.",
    ITER_TABLE,
    { purpose: "p", non_goal: "n", invariant: "i" },
  ],
];
for (const a of requestArgSets) {
  add("request_markdown", requestMarkdown as (...x: any[]) => unknown, ...a);
}

// scope_request_markdown — single scope object.
const scopeSets: Record<string, unknown>[] = [
  {},
  { type: "code_review" },
  { type: "architecture_review", title: "Protocol robustness" },
  { type: "design_review" },
  { type: "test_plan_review" },
  { type: "security_review" },
  { type: "general_review" },
  { type: "unknown_kind" }, // -> default focus list
  {
    type: "code_review",
    title: "Round 1",
    worker: "claude",
    reviewer: "codex",
    scope_file: "/p/scope.json",
    diff_file: "/p/diff.patch",
    files: ["a.ts", "b.ts"],
    directories: ["src/lib"],
    questions: ["Is the lock safe?", "Any race?"],
    notes: ["context here"],
  },
  // empty lists -> "- None" for each section.
  { type: "code_review", files: [], directories: [], questions: [], notes: [] },
  // worker/reviewer/scope_file absent -> "None"; diff_file absent -> "not included".
  { type: "general_review", files: ["x"] },
  // instructions block present.
  { type: "code_review", instructions: "Use 2-space indent.\nNo TODOs.", files: ["m.ts"] },
  // instructions whitespace-only -> block omitted.
  { type: "code_review", instructions: "   \n  ", files: ["m.ts"] },
  // intent dict present.
  {
    type: "code_review",
    intent: { purpose: "scoped review", non_goal: "no rewrite", invariant: "no data loss" },
    files: ["s.ts"],
  },
  // intent dict with falsy values -> normalized to "" -> "(missing)".
  { type: "code_review", intent: { purpose: "", non_goal: null, invariant: "keep" }, files: ["s.ts"] },
  // intent NOT a dict -> treated as {} (no intent block).
  { type: "code_review", intent: ["not", "a", "dict"], files: ["s.ts"] },
  { type: "code_review", intent: "string-intent", files: ["s.ts"] },
  // numeric items in lists -> str() formatting.
  { type: "code_review", files: [1, 2, 3], questions: [42] },
  // title falsy -> falls back to review_type.
  { type: "security_review", title: "" },
  // multibyte content throughout.
  {
    type: "architecture_review",
    title: `${CJK} 검토`,
    worker: "claude",
    reviewer: "codex",
    files: [`${CJK}.ts`, `파일/${EMOJI}.md`],
    questions: [`${EMOJI} 안전한가?`],
    notes: [CJK],
    intent: { purpose: CJK, non_goal: EMOJI, invariant: "불변식 유지" },
    instructions: `${CJK} 규칙`,
  },
  // diff_file falsy ("") -> "not included".
  { type: "code_review", diff_file: "", scope_file: "/p/s.json" },
];
for (const s of scopeSets) {
  add("scope_request_markdown", scopeRequestMarkdown as (...x: any[]) => unknown, s);
}

// ===========================================================================
// Registration: presence guard + one test per case.
// ===========================================================================

describe("differential test infrastructure", () => {
  test("golden-probe.py exists (Python oracle source)", () => {
    expect(existsSync(PROBE)).toBe(true);
  });
  test("corpus is non-trivially large", () => {
    expect(CASES.length).toBeGreaterThan(200);
  });
});

describe("TS leaf modules == Python oracle (differential)", () => {
  for (let idx = 0; idx < CASES.length; idx++) {
    const c = CASES[idx]!;
    const label = `[${idx}] ${c.pyName}(${JSON.stringify(c.args).slice(0, 120)})`;
    test(label, () => {
      const expected = oracle(c.pyName, c.args);
      const actual = c.ts(...c.args);
      expect(actual).toEqual(expected as never);
    });
  }
});

// Exported for the report: total case count (referenced by the harness logs).
export const TOTAL_CASES = () => CASES.length;
