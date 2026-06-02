/**
 * phase4.test.ts — ORACLE integration test for the Phase 4a FS helpers
 * (src/lib/session.ts, review.ts, report.ts), driven against the Python runtime
 * via test/phase3-probe.py.
 *
 * Read-only helpers run on a SHARED fixture root so any absolute paths embedded
 * in their output match between Python and TS. Writers either produce
 * path-independent file content (context.md / ledger.md / worker-followup.md) or
 * are run on a shared dir, with wall-clock timestamps normalized to <TS>.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureSessionContext,
  loadSessionContext,
  loadSessionIntent,
  appendLedger,
  buildIterationTable,
  loadReviewInstructions,
} from "../src/lib/session.ts";
import {
  findPreviousRoundDir,
  parsePreviousReview,
  buildWorkerFollowup,
} from "../src/lib/review.ts";
import { latestSessionId, roundMustFixCount, roundFilesTouched } from "../src/lib/report.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "phase3-probe.py");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p4-${label}-`));
  TMP.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Run the Python oracle probe; throw on failure. Returns stdout. */
function probe(args: string[]): string {
  const proc = spawnSync("python3", [PROBE, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (proc.status !== 0) {
    throw new Error(`probe ${args[0]} exited ${proc.status}\n${proc.stdout}\n${proc.stderr}`);
  }
  return proc.stdout;
}
// Returns `any` so structured comparisons (toEqual) against typed TS results
// don't trip the overload checker; call sites cast where a shape is needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function probeJson(args: string[]): any {
  return JSON.parse(probe(args).trim());
}
function normTs(s: string): string {
  return s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>");
}
function read(p: string): string {
  return readFileSync(p, "utf-8");
}

// ===========================================================================
// Writers (separate roots; path-independent content / shared dir).
// ===========================================================================
describe("session.captureSessionContext", () => {
  for (const [name, prompt] of [
    ["plain", "Implement the widget and add tests."],
    ["multibyte", "위젯 구현 💥\nและเพิ่มการทดสอบ"],
    ["long", "x".repeat(13000)],
  ] as const) {
    test(name, () => {
      const py = freshTmp("cc-py");
      const ts = freshTmp("cc-ts");
      probe(["capture-context", py, "s1", prompt]);
      captureSessionContext(ts, "s1", prompt);
      const pyc = read(join(py, "sessions", "s1", "context.md"));
      const tsc = read(join(ts, "sessions", "s1", "context.md"));
      expect(normTs(tsc)).toBe(normTs(pyc));
    });
  }

  test("empty prompt is a no-op (no file written)", () => {
    const ts = freshTmp("cc-empty");
    captureSessionContext(ts, "s1", "   ");
    const py = freshTmp("cc-empty-py");
    probe(["capture-context", py, "s1", "   "]);
    // Neither side wrote context.md.
    expect(() => read(join(ts, "sessions", "s1", "context.md"))).toThrow();
    expect(() => read(join(py, "sessions", "s1", "context.md"))).toThrow();
  });
});

describe("session.appendLedger", () => {
  test("header on first append, rows thereafter (byte-identical)", () => {
    const py = freshTmp("led-py");
    const ts = freshTmp("led-ts");
    const reviewFile = "/p/r/0001/review.md";
    for (const [round, decision, mustfix] of [
      [1, "NEEDS_CHANGES", 3],
      [2, "PASS", 0],
    ] as const) {
      probe(["append-ledger", py, "sx", String(round), decision, String(mustfix), reviewFile]);
      appendLedger(ts, "sx", round, decision, mustfix, reviewFile);
    }
    const lp = join(py, "sessions", "sx", "ledger.md");
    const lt = join(ts, "sessions", "sx", "ledger.md");
    expect(read(lt)).toBe(read(lp));
  });

  test("blank decision renders INVALID", () => {
    const py = freshTmp("led2-py");
    const ts = freshTmp("led2-ts");
    probe(["append-ledger", py, "sy", "1", "", "1", "/r.md"]);
    appendLedger(ts, "sy", 1, "", 1, "/r.md");
    expect(read(join(ts, "sessions", "sy", "ledger.md"))).toBe(
      read(join(py, "sessions", "sy", "ledger.md")),
    );
  });
});

describe("review.buildWorkerFollowup", () => {
  const cases: Array<{ name: string; files: string[]; input: Record<string, unknown> }> = [
    { name: "message+files", files: ["b.ts", "a.ts", "a.ts"], input: { last_assistant_message: "Applied 1-3.\nItem 4 deferred." } },
    { name: "files-only-no-message", files: ["only.ts"], input: {} },
    { name: "empty -> null", files: [], input: {} },
    { name: "message-only", files: [], input: { last_assistant_message: "  done  " } },
    { name: "multibyte", files: [`${"한"}.ts`], input: { last_assistant_message: "수정 💥" } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const dir = freshTmp("wf"); // shared round dir -> embedded `file` path matches
      const pyOut = probeJson(["build-worker-followup", dir, JSON.stringify(c.files), JSON.stringify(c.input)]);
      const tsOut = buildWorkerFollowup(dir, c.files, c.input);
      expect(tsOut).toEqual(pyOut);
    });
  }
});

// ===========================================================================
// Read-only helpers (shared fixture root).
// ===========================================================================
describe("read-only Phase 4a helpers (shared fixture root)", () => {
  let root: string;
  const sid = "sess-fixture";

  beforeAll(() => {
    root = freshTmp("ro");
    const sdir = join(root, "sessions", sid);
    mkdirSync(join(sdir, "rounds", "0001"), { recursive: true });
    mkdirSync(join(sdir, "rounds", "0002"), { recursive: true });
    writeFileSync(join(sdir, "context.md"), "# Task Context\n\nbuild it\n");
    writeFileSync(
      join(sdir, "intent.md"),
      "PURPOSE: ship phase 4a\nNON_GOAL: no subprocess\nINVARIANT: byte parity\n",
    );
    // round 1
    writeFileSync(join(sdir, "rounds", "0001", "decision.json"), JSON.stringify({ decision: "NEEDS_CHANGES" }));
    writeFileSync(join(sdir, "rounds", "0001", "review.md"), "## Must Fix\n- a real one\n- another\n");
    writeFileSync(
      join(sdir, "rounds", "0001", "diff.patch"),
      "diff --git a/src/x.ts b/src/x.ts\n@@\n+hi\ndiff --git a/src/y.ts b/src/y.ts\n@@\n-bye\n",
    );
    // round 2
    writeFileSync(join(sdir, "rounds", "0002", "decision.json"), JSON.stringify({ decision: "PASS" }));
    writeFileSync(join(sdir, "rounds", "0002", "review.md"), "## Must Fix\n- None.\n");
    // project review instructions
    writeFileSync(join(root, "instructions.md"), "Use tabs.\nNo TODOs.\n");
  });

  test("loadSessionContext matches oracle", () => {
    const ts = loadSessionContext(root, sid);
    const py = (probeJson(["load-context", root, sid]) as { value: string }).value;
    expect(ts).toBe(py);
    expect(ts).toContain("build it");
  });

  test("loadSessionIntent (file wins) matches oracle", () => {
    const ts = loadSessionIntent(root, sid, "fallback");
    const py = probeJson(["load-intent", root, sid, "fallback"]);
    expect(ts).toEqual(py);
    expect((ts as { purpose: string }).purpose).toBe("ship phase 4a");
  });

  test("loadSessionIntent (fallback when no file) matches oracle", () => {
    const ts = loadSessionIntent(root, "no-such-session", "PURPOSE: from fallback");
    const py = probeJson(["load-intent", root, "no-such-session", "PURPOSE: from fallback"]);
    expect(ts).toEqual(py);
  });

  test("buildIterationTable matches oracle", () => {
    const ts = buildIterationTable(root, sid, 3);
    const py = (probeJson(["iteration-table", root, sid, "3"]) as { value: string }).value;
    expect(ts).toBe(py);
    expect(ts).toContain("| 0001 | NEEDS_CHANGES | 2 |");
    expect(ts).toContain("| 0002 | PASS | 0 |");
  });

  test("buildIterationTable returns '' for round 1", () => {
    expect(buildIterationTable(root, sid, 1)).toBe("");
    expect((probeJson(["iteration-table", root, sid, "1"]) as { value: string }).value).toBe("");
  });

  test("loadReviewInstructions matches oracle (embedded paths match on shared root)", () => {
    const ts = loadReviewInstructions(root);
    const py = (probeJson(["review-instructions", root]) as { value: string }).value;
    expect(ts).toBe(py);
    expect(ts).toContain("Use tabs.");
  });

  test("findPreviousRoundDir matches oracle", () => {
    const ts = findPreviousRoundDir(root, sid, 3);
    const py = (probeJson(["find-prev-round", root, sid, "3"]) as { value: string | null }).value;
    expect(ts).toBe(py);
    expect(ts).toContain(join("rounds", "0002"));
    // round 1 -> null on both
    expect(findPreviousRoundDir(root, sid, 1)).toBeNull();
    expect((probeJson(["find-prev-round", root, sid, "1"]) as { value: string | null }).value).toBeNull();
  });

  test("parsePreviousReview matches oracle", () => {
    const prev = join(root, "sessions", sid, "rounds", "0001");
    const ts = parsePreviousReview(prev);
    const py = probeJson(["parse-prev-review", prev]);
    expect(ts).toEqual(py);
    expect((ts as { must_fix_count: number }).must_fix_count).toBe(2);
  });

  test("latestSessionId matches oracle", () => {
    const ts = latestSessionId(root);
    const py = (probeJson(["latest-session-id", root]) as { value: string | null }).value;
    expect(ts).toBe(py);
    expect(ts).toBe(sid);
  });

  test("roundMustFixCount matches oracle", () => {
    const r1 = join(root, "sessions", sid, "rounds", "0001");
    expect(roundMustFixCount(r1)).toBe((probeJson(["round-must-fix", r1]) as { value: number }).value);
    expect(roundMustFixCount(r1)).toBe(2);
  });

  test("roundFilesTouched matches oracle", () => {
    const r1 = join(root, "sessions", sid, "rounds", "0001");
    const ts = roundFilesTouched(r1);
    const py = (probeJson(["round-files-touched", r1]) as { value: string[] }).value;
    expect(ts).toEqual(py);
    expect(ts).toEqual(["src/x.ts", "src/y.ts"]);
  });
});
