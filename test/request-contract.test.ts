/**
 * request-contract.test.ts — CONTENT-level assertions for the reviewer prompt
 * built by requestMarkdown / scopeRequestMarkdown.
 *
 * The differential test only proves the TS builders match the Python oracle
 * byte-for-byte (parity). This file additionally pins the prompt's *contract*:
 * the parallel 8-lens (A1-A8) review procedure, the duplicate-clustering /
 * local-verification / rare-finding methodology, the UNCHANGED decision output
 * (REVIEW_DECISION + Must Fix / Should Consider / Verdict), and the absence of
 * the old "Spawn 6" wording and the removed severity->bucket mapping.
 *
 * The FULL contract is asserted against BOTH builders; only the lens-marker
 * spelling differs (requestMarkdown uses "A1." ... "A8."; scopeRequestMarkdown
 * uses "A1 " ... "A8 " inline).
 */
import { describe, expect, test } from "bun:test";
import { requestMarkdown, scopeRequestMarkdown } from "../src/lib/request.ts";

const BUILDERS: Array<{ name: string; md: string; lens: (n: number) => string }> = [
  {
    name: "requestMarkdown",
    md: requestMarkdown("claude", "codex", 2, "abc123", "headrev", "/p/diff.patch"),
    lens: (n) => `A${n}.`,
  },
  {
    name: "scopeRequestMarkdown",
    md: scopeRequestMarkdown({ type: "code_review", files: ["a.ts"] }),
    lens: (n) => `A${n} `,
  },
];

for (const { name, md, lens } of BUILDERS) {
  describe(`${name} reviewer-prompt contract`, () => {
    test("frames a parallel independent 8-agent review", () => {
      expect(md).toContain("parallel independent code review");
      expect(md).toContain("spawn 8 read-only reviewer subagents");
    });

    test("lists all eight lenses A1-A8", () => {
      for (let n = 1; n <= 8; n += 1) {
        expect(md).toContain(lens(n));
      }
    });

    test("carries the aggregation methodology", () => {
      expect(md).toContain("cluster duplicates by ROOT CAUSE");
      expect(md).toContain("duplicate count is a confidence signal, not the primary ranking");
      expect(md).toContain("Verify each finding's evidence locally before reporting");
      expect(md).toContain("Preserve rare but verified single-agent findings");
    });

    test("preserves the decision contract unchanged", () => {
      expect(md).toContain("classifying each kept finding by the Must Fix / Should Consider bar");
      expect(md).toContain("REVIEW_DECISION: PASS");
      expect(md).toContain("REVIEW_DECISION: NEEDS_CHANGES");
      expect(md).toContain("REVIEW_DECISION: NEEDS_HUMAN");
      expect(md).toContain("## Must Fix");
      expect(md).toContain("## Should Consider");
      expect(md).toContain("## Verdict");
    });

    test("drops the old 6-subagent wording and the severity->bucket mapping", () => {
      expect(md).not.toContain("Spawn 6 independent");
      expect(md).not.toContain("6 distinct lenses");
      expect(md).not.toContain("Map urgency to the buckets");
      expect(md).not.toContain("Critical/High -> Must Fix");
    });
  });
}

// The decision line must stand alone (parse_decision matches it at line start),
// which is only guaranteed for the per-round request builder.
test("requestMarkdown emits the decision line at column 0", () => {
  const md = requestMarkdown("claude", "codex", 1, "h", "head", "/p/d");
  expect(md).toMatch(/^REVIEW_DECISION: PASS$/m);
});

describe("scopeRequestMarkdown --follow-up block", () => {
  test("absent by default (no previous_review) — output unchanged", () => {
    const md = scopeRequestMarkdown({ type: "code_review", files: ["a.ts"] });
    expect(md).not.toContain("## Previous Review");
    expect(md).not.toContain("follow-up request");
  });

  test("renders the prior review pointer, delta, and verify-claims guidance", () => {
    const md = scopeRequestMarkdown({
      type: "code_review",
      files: ["a.ts"],
      notes: ["applied null-check at parser.ts:42"],
      previous_review: { review_file: "/p/r/review.md", decision: "NEEDS_CHANGES", must_fix_count: 3 },
      delta_file: "/p/r2/delta.patch",
    });
    expect(md).toContain("## Previous Review");
    expect(md).toContain("- File: /p/r/review.md");
    expect(md).toContain("- Decision: NEEDS_CHANGES");
    expect(md).toContain("- Must Fix items in previous round: 3");
    expect(md).toContain("Incremental delta file (changes since previous round): /p/r2/delta.patch");
    expect(md).toContain("verify each claim against the diff/delta");
    // the block precedes the scope sections
    expect(md.indexOf("## Previous Review")).toBeLessThan(md.indexOf("## Scope Files"));
  });

  test("omits the delta line when no delta_file is supplied", () => {
    const md = scopeRequestMarkdown({
      type: "code_review",
      previous_review: { review_file: "/p/r/review.md", decision: "NEEDS_CHANGES", must_fix_count: 1 },
    });
    expect(md).toContain("## Previous Review");
    expect(md).not.toContain("Incremental delta file");
  });
});
