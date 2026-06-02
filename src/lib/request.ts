/**
 * request.ts — PURE markdown builders for CCR review requests, ported from
 * ccr-hook.py:
 *   - request_markdown        (Python 918-1068)  -> requestMarkdown
 *   - scope_request_markdown  (Python 1071-1192) -> scopeRequestMarkdown
 *
 * Despite the migration plan classifying these under "FS-dependent" work, both
 * functions are in fact PURE string builders: the `Path` parameters (diff_file,
 * delta_file, scope_file) are only ever interpolated into the output via Python
 * f-strings (`str(path)`), never read or written. They therefore validate
 * cleanly against the existing oracle differential harness (no filesystem
 * oracle required) — see test/differential.test.ts and Known divergence D7 in
 * docs/ccr-js-migration-plan.md.
 *
 * Output must match the Python oracle byte-for-byte, so string semantics are
 * delegated to the already-validated pycompat (strip) and the previously ported
 * text.ts (truncateText, fencedMarkdownBlock) / intent.ts (renderIntentSection)
 * modules, and the large literal instruction blocks are transcribed verbatim
 * from ccr-hook.py.
 *
 * Zero dependencies beyond the already-validated foundation modules.
 */

import { strip } from "./pycompat";
import { renderIntentSection, type Intent } from "./intent";
import { truncateText, fencedMarkdownBlock } from "./text";

/**
 * Python dict.get(key, default): the default is returned ONLY when the key is
 * absent. A present key whose value is `null` returns `null` (mirroring an
 * explicit `None`). Mirrors `obj.get(key, default)`.
 */
function pyGet(obj: Record<string, unknown> | null | undefined, key: string, dflt: unknown = null): unknown {
  if (obj != null && Object.prototype.hasOwnProperty.call(obj, key)) {
    return (obj as Record<string, unknown>)[key];
  }
  return dflt;
}

/**
 * Mirror Python's str()/f-string formatting for the scalar types that flow
 * through these builders: None->"None", True->"True", False->"False",
 * everything else via String(). JS's `${null}`/`${undefined}`/`${true}` would
 * otherwise diverge ("null"/"undefined"/"true").
 */
/**
 * Mirror Python truthiness for a dict: `if d:` is falsy for None AND for an
 * empty dict, regardless of its values. JS `{}` is truthy, so a key-count check
 * is required to match `if previous_review:` / `if worker_followup:`.
 */
function pyTruthyObj(o: Record<string, unknown> | null | undefined): boolean {
  return o != null && Object.keys(o).length > 0;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) {
    return "None";
  }
  if (v === true) {
    return "True";
  }
  if (v === false) {
    return "False";
  }
  return String(v);
}

/**
 * Faithful port of Python `request_markdown` (918-1068).
 *
 * Builds the per-round automatic review request. Parameters are positional and
 * defaulted to mirror the Python signature exactly so the differential test can
 * spread a partial argument array (the Python oracle fills the same defaults).
 */
export function requestMarkdown(
  worker: string,
  reviewer: string,
  roundNo: number,
  diffHash: string,
  head: string,
  diffFile: string,
  deltaFile: string | null = null,
  previousReview: Record<string, unknown> | null = null,
  workerFollowup: Record<string, unknown> | null = null,
  instructions: string = "",
  taskContext: string = "",
  iterationTable: string = "",
  intent: Record<string, unknown> | null = null,
): string {
  const parts: string[] = [
    "# CCR Review Request",
    "",
    `Worker: ${worker}`,
    `Reviewer: ${reviewer}`,
    `Round: ${roundNo}`,
    `Git HEAD: ${head || "unknown"}`,
    `Diff hash: ${diffHash}`,
    `Diff file: ${diffFile}`,
  ];
  if (deltaFile != null) {
    parts.push(`Delta file (changes since previous round): ${deltaFile}`);
  }
  parts.push("");
  const intentBlock = renderIntentSection((intent ?? {}) as unknown as Intent);
  if (intentBlock.length > 0) {
    parts.push(...intentBlock);
  }
  if (strip(taskContext)) {
    parts.push(
      "## Task Context",
      "",
      "What the worker is trying to accomplish in this CCR session. Use this to judge whether the diff actually serves the intent; flag scope drift.",
      "",
      strip(taskContext),
      "",
    );
  }
  if (strip(iterationTable)) {
    parts.push(
      "## Iteration So Far",
      "",
      `This is round ${roundNo}. Prior rounds in this session:`,
      "",
      strip(iterationTable),
      "",
      "Check whether Must-fix counts are trending toward 0. If they are flat or rising, the worker may be circling — say so in the Verdict.",
      "",
    );
  }
  if (strip(instructions)) {
    parts.push(
      "## Project Instructions",
      "",
      "Project-specific conventions and constraints. Treat as authoritative; the rules below take precedence over generic best-practice guesses.",
      "",
      strip(instructions),
      "",
    );
  }
  if (pyTruthyObj(previousReview)) {
    parts.push(
      "## Previous Review",
      "",
      `- File: ${pyStr(pyGet(previousReview, "review_file", ""))}`,
      `- Decision: ${pyStr(pyGet(previousReview, "decision", ""))}`,
      `- Must Fix items in previous round: ${pyStr(pyGet(previousReview, "must_fix_count", 0))}`,
      "",
      "Focus on whether the previous Must Fix items have been addressed; do not repeat the same comments verbatim if they are now resolved.",
      "",
    );
  }
  if (pyTruthyObj(workerFollowup)) {
    const files = (pyGet(workerFollowup, "files") || []) as unknown[];
    const message = pyStr(pyGet(workerFollowup, "message") || "");
    parts.push(
      "## Worker Follow-up Since Previous Review",
      "",
      "Use this section to understand what the worker says was applied and why any previous review items were not applied. Verify the claims against the diff; do not assume they are correct.",
      "",
    );
    if (pyGet(workerFollowup, "file")) {
      parts.push(`- Worker response file: ${pyStr(pyGet(workerFollowup, "file"))}`);
    }
    if (files.length > 0) {
      parts.push(`- Files touched in current diff: ${files.map(pyStr).join(", ")}`);
    }
    if (deltaFile != null) {
      parts.push(`- Incremental delta file: ${deltaFile}`);
    }
    if (!message) {
      parts.push(
        "- Worker did not provide an explicit applied/not-applied explanation in the last assistant message.",
        "",
      );
    } else {
      parts.push(
        "",
        "Worker's latest response:",
        "",
        ...fencedMarkdownBlock(truncateText(message)),
        "",
      );
    }
  }
  parts.push(
    "You are the reviewer in a two-agent cmux review loop. Do not edit files.",
    "",
    "What to review:",
    "- The diff above. If a delta file is listed, review only the incremental changes since the previous round.",
    "- If Worker Follow-up is listed, verify each claimed \"applied\" change against the diff. Do not trust the claim.",
    "",
    "Review process (multi-agent — required):",
    "- Run a parallel independent code review: spawn 8 read-only reviewer subagents in parallel, each given the same diff/context but a distinct lens, with no shared findings between them. One lens per subagent:",
    "  A1. Baseline correctness & regressions — logic bugs, broken behavior, off-by-one, error handling.",
    "  A2. User-visible regressions & requirements/intent fit — does the diff serve the stated Purpose/intent and Task Context? Flag scope drift and missing requirements.",
    "  A3. Edge cases & invalid states — boundary inputs, empty/null, unexpected ordering, partial failures.",
    "  A4. Security, auth, privacy & data safety — secrets, injection, unsafe defaults, permission boundaries, data loss/corruption.",
    "  A5. Data invariants & API/contract stability — schema/format guarantees, backward compatibility, serialization.",
    "  A6. Concurrency, lifecycle, async ordering, resources & error handling — race conditions, locks, leaks, blocking I/O.",
    "  A7. Tests, CI, deploy & migrations — missing or weak tests for changed behavior, untested edge cases, flaky or wrong assertions, migration/rollout risk.",
    "  A8. Architecture, integration impact & maintainability — boundaries, duplication, naming, readability, API clarity, needless complexity.",
    "- Each subagent must be read-only (no file edits, no git mutations, no recursive CCR review). It returns findings as `file:line` + concrete fix + trigger/impact; if its lens is clean it reports nothing.",
    "- If your runtime cannot spawn subagents, instead perform the 8 lenses as 8 separate sequential review passes and keep their findings distinct.",
    "- Aggregate the results yourself: cluster duplicates by ROOT CAUSE (not by title or line number); duplicate count is a confidence signal, not the primary ranking. Verify each finding's evidence locally before reporting and drop speculative ones. Preserve rare but verified single-agent findings — never bury a critical single-agent find under obvious medium ones.",
    "- Then YOU consolidate into ONE review and decide a single overall REVIEW_DECISION, classifying each kept finding by the Must Fix / Should Consider bar below. Emit only the consolidated review; do not paste the raw per-subagent reports.",
    "",
    "Reviewer constraints (strict):",
    "- Do not edit, create, or delete files.",
    "- Do not run any git mutation: `git add` / `commit` / `checkout` / `restore` / `stash` / `reset` / `push`. Read-only git commands (`git diff`, `git log`, `git show`) are fine.",
    "- Do not request another CCR review (no recursive `ccr-request`, no `[ccr-handoff]` sentinels).",
    "- Stay in reviewer mode until you have emitted the `REVIEW_DECISION:` line, then stop. Do not switch back to dev work in the same reply.",
    "",
    "Bar for findings (skip anything below the bar — do not pad):",
    "- Must Fix: bug, regression, broken requirement, missing critical test, security/data issue. Cite `file:line` and propose a concrete fix.",
    "- Should Consider: real maintainability or design risk worth raising. No pure style nits.",
    "- If nothing meets the bar, return PASS. Do not invent issues to justify NEEDS_CHANGES.",
    "",
    "Output exactly one decision line near the top:",
    "REVIEW_DECISION: PASS",
    "REVIEW_DECISION: NEEDS_CHANGES",
    "REVIEW_DECISION: NEEDS_HUMAN",
    "",
    "NEEDS_HUMAN is only for policy / security / business calls outside an agent's safe scope. Routine defects are NEEDS_CHANGES.",
    "",
    "Then use this Markdown structure (omit empty sections):",
    "",
    "# Review",
    "",
    "## Must Fix",
    "- `path/to/file.go:42` — what is wrong — proposed fix",
    "",
    "## Should Consider",
    "- `path/to/file.go:99` — observation",
    "",
    "## Verdict",
    "- One sentence.",
    "",
  );
  return parts.join("\n");
}

const SCOPE_FOCUS: Record<string, string[]> = {
  code_review: [
    "actual bugs and regressions",
    "requirements gaps",
    "missing or weak tests",
    "unnecessary complexity",
  ],
  architecture_review: [
    "boundaries and responsibilities",
    "state flow and failure modes",
    "concurrency and recovery risks",
    "observability and extensibility",
  ],
  design_review: [
    "fit with the current codebase",
    "API and data-flow clarity",
    "edge cases and constraints",
    "implementation risks",
  ],
  test_plan_review: [
    "coverage gaps",
    "high-risk scenarios",
    "testability and maintainability",
    "acceptance criteria",
  ],
  security_review: [
    "secrets and sensitive data exposure",
    "input validation and injection risks",
    "permission boundaries",
    "unsafe defaults",
  ],
  general_review: [
    "correctness",
    "maintainability",
    "risks and missing context",
    "next practical improvements",
  ],
};

/**
 * Faithful port of Python `scope_request_markdown` (1071-1192).
 *
 * Builds the manual (scoped) review request from a `scope` object. Pure: the
 * `scope_file` / `diff_file` entries are interpolated as strings only.
 */
export function scopeRequestMarkdown(scope: Record<string, unknown>): string {
  const reviewType = (pyGet(scope, "type") || "general_review") as string;
  const title = pyGet(scope, "title") || reviewType;
  const files = (pyGet(scope, "files") || []) as unknown[];
  const directories = (pyGet(scope, "directories") || []) as unknown[];
  const questions = (pyGet(scope, "questions") || []) as unknown[];
  const notes = (pyGet(scope, "notes") || []) as unknown[];
  const scopeFile = pyGet(scope, "scope_file");
  const diffFile = pyGet(scope, "diff_file");
  const focus = SCOPE_FOCUS[String(reviewType)] ?? [
    "correctness",
    "risks",
    "missing context",
    "practical improvements",
  ];

  const bullets = (items: unknown[]): string =>
    items && items.length > 0 ? items.map((item) => `- ${pyStr(item)}`).join("\n") : "- None";

  const instructions = strip(pyStr(pyGet(scope, "instructions") || ""));
  const instructionsBlock = instructions
    ? `\n## Project Instructions\n\n` +
      `Project-specific conventions and constraints. Treat as authoritative; the rules below take precedence over generic best-practice guesses.\n\n` +
      `${instructions}\n`
    : "";

  const intentRaw = pyGet(scope, "intent");
  const intentDict =
    intentRaw !== null && typeof intentRaw === "object" && !Array.isArray(intentRaw)
      ? (intentRaw as Record<string, unknown>)
      : {};
  const normIntent: Record<string, string> = {};
  for (const [k, v] of Object.entries(intentDict)) {
    normIntent[String(k)] = String(v || "");
  }
  const intentLines = renderIntentSection(normIntent as unknown as Intent);
  const intentBlock = intentLines.length > 0 ? "\n" + intentLines.join("\n") : "";

  return `# CCR Manual Review Request

Title: ${pyStr(title)}
Review type: ${pyStr(reviewType)}
Worker: ${pyStr(pyGet(scope, "worker"))}
Reviewer: ${pyStr(pyGet(scope, "reviewer"))}
Scope file: ${pyStr(scopeFile)}
Diff file: ${pyStr(diffFile || "not included")}
${intentBlock}
## Scope Files
${bullets(files)}

## Scope Directories
${bullets(directories)}

## Questions
${bullets(questions)}

## Notes
${bullets(notes)}
${instructionsBlock}
## Review Focus
${bullets(focus)}

Review process (multi-agent — required):
- Run a parallel independent code review: spawn 8 read-only reviewer subagents in parallel, each given the same scope/context but a distinct lens, with no shared findings between them. Cover the Review Focus items above first, then fill the remaining slots until you have 8 distinct lenses: A1 baseline correctness & regressions, A2 user-visible regressions & requirements/intent fit, A3 edge cases & invalid states, A4 security/auth/privacy & data safety, A5 data invariants & API/contract stability, A6 concurrency/lifecycle/async ordering/resources & error handling, A7 tests/CI/deploy/migrations & coverage, A8 architecture/integration impact & maintainability.
- Each subagent must be read-only (no file edits, no git mutations, no recursive CCR review). It returns findings as \`file:line\` + concrete fix + trigger/impact; if its lens is clean it reports nothing.
- If your runtime cannot spawn subagents, instead perform the 8 lenses as 8 separate sequential review passes and keep their findings distinct.
- Aggregate the results yourself: cluster duplicates by ROOT CAUSE (not by title or line number); duplicate count is a confidence signal, not the primary ranking. Verify each finding's evidence locally before reporting and drop speculative ones. Preserve rare but verified single-agent findings — never bury a critical single-agent find under obvious medium ones.
- Then YOU consolidate into ONE review and decide a single overall REVIEW_DECISION, classifying each kept finding by the Must Fix / Should Consider bar below. Emit only the consolidated review; do not paste the raw per-subagent reports.

Reviewer constraints (strict):
- Do not edit, create, or delete files.
- Do not run any git mutation: \`git add\` / \`commit\` / \`checkout\` / \`restore\` / \`stash\` / \`reset\` / \`push\`. Read-only git commands (\`git diff\`, \`git log\`, \`git show\`) are fine.
- Do not request another CCR review (no recursive \`ccr-request\`, no \`[ccr-handoff]\` sentinels).
- Stay in reviewer mode until you have emitted the \`REVIEW_DECISION:\` line, then stop.

Bar for findings:
- Review only the files, directories, and questions listed in scope.json. The diff (if any) is supporting context, not the source of truth.
- For each finding, cite \`file:line\` and propose a concrete fix.
- If nothing meets the Must Fix / Should Consider bar, return PASS without padding.

Output exactly one decision line near the top:
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES
REVIEW_DECISION: NEEDS_HUMAN

NEEDS_HUMAN is only for policy / security / business calls outside an agent's safe scope. Routine defects are NEEDS_CHANGES.

Then use this Markdown structure (omit empty sections):

# Review

## Must Fix
- \`path/to/file.go:42\` — what is wrong — proposed fix

## Should Consider
- \`path/to/file.go:99\` — observation

## Verdict
- One sentence.
`;
}
