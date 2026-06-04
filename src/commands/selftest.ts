/**
 * selftest.ts — `ccr-selftest`. Faithful port of ccr-hook.py _run_selftest_case
 * (3277-3282), _selftest_cases (3285-3637), and command_selftest (3640-3658):
 * 12 in-process smoke tests of the runtime, each re-exercising a TS lib function
 * that mirrors the Python case. selftestDoc() is also consumed by command_check.
 *
 * In a healthy build every case PASSes (detail ""), matching the Python oracle;
 * a regression in the port makes a case throw -> FAIL, which the oracle catches.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseDecision } from "../lib/decision";
import { shouldMarkDirtyForTool } from "../lib/tool";
import { isCcrHandoffPrompt, extractIntentFromMessage, renderIntentSection, type Intent } from "../lib/intent";
import { handleUserPromptSubmit } from "../lib/hooks";
import { truncateSections } from "../lib/text";
import { countChangedLines } from "../lib/diff";
import { loadSessionIntent } from "../lib/session";
import { markDirty, hasDirty } from "../lib/lock";
import { reapStaleActive } from "../lib/review";
import { appendJsonl, writeJson, now } from "../lib/io";
import { sessionDir, sessionIntentPath, skipMarkerPath, rootForCwd } from "../lib/paths";
import { MAX_ROUNDS, MAX_DIFF_BYTES } from "../lib/constants";
import { utf8ByteLength, ljust } from "../lib/pycompat";
import { parseArgs } from "../lib/args";
import { previewData } from "./preview";
import { pruneCandidates } from "./prune";
import { configDoc } from "./config";
import { readEvents } from "./events";
import { doctorDoc } from "./doctor";
import { readyChecks } from "./ready";
import { commandSupport } from "./support";
import { out, captureStdout } from "./shared";

export interface SelftestResult {
  name: string;
  status: string;
  detail: string;
}

function assert(cond: unknown, msg = "assertion failed"): void {
  if (!cond) {
    throw new Error(msg);
  }
}
function arraysEqual(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccr-selftest-"));
}

function cases(): Array<[string, () => void]> {
  const decisionParser = (): void => {
    assert(parseDecision("REVIEW_DECISION: PASS\nrest") === "PASS");
    assert(parseDecision("preamble\nREVIEW_DECISION: NEEDS_CHANGES") === "NEEDS_CHANGES");
    assert(parseDecision("REVIEW_DECISION:   NEEDS_HUMAN  ") === "NEEDS_HUMAN");
    const fenced = "```\nREVIEW_DECISION: PASS\n```\nREVIEW_DECISION: NEEDS_CHANGES\n";
    assert(parseDecision(fenced) === "NEEDS_CHANGES");
    const quoted = "> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n";
    assert(parseDecision(quoted) === "NEEDS_HUMAN");
  };

  const dirtyFilter = (): void => {
    assert(shouldMarkDirtyForTool({ tool_name: "Bash", tool_input: { command: "ccr-status" } }) === false);
    assert(shouldMarkDirtyForTool({ tool_name: "Bash", tool_input: { command: "pytest" } }) === false);
    assert(shouldMarkDirtyForTool({ tool_name: "Bash", tool_input: { command: "printf x > app.py" } }) === true);
    assert(shouldMarkDirtyForTool({ tool_name: "apply_patch" }) === true);
  };

  const handoffAndPrompt = (): void => {
    assert(isCcrHandoffPrompt("[ccr-handoff]\n자동 리뷰 요청입니다") === true);
    assert(isCcrHandoffPrompt("normal user prompt") === false);
    const td = tmp();
    try {
      const root = join(td, "ccr");
      const state: Record<string, unknown> = {
        review_count: 1,
        last_diff_hash: "hash-before",
        active_request: { round: 1, worker: "claude", reviewer: "codex" },
      };
      handleUserPromptSubmit(root, state, { session_id: "sid", prompt: "new user work" }, "claude", "claude");
      assert(state.review_count === 1);
      assert(state.last_diff_hash === "hash-before");
      assert(typeof state.active_request === "object" && state.active_request !== null);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  const truncationAndDiff = (): void => {
    const many = ("+" + "A".repeat(200) + "\n").repeat(50);
    const o = truncateSections([
      ["# Git HEAD", "abc"],
      ["# Staged Diff", many],
      ["# Unstaged Diff", many],
      ["# Untracked Files", many],
    ], 500);
    assert(utf8ByteLength(o) <= 500);
    assert(countChangedLines("--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other") === 2);
  };

  const doctorReadySupportJson = (): void => {
    const cwd = process.cwd();
    const root = rootForCwd(cwd);
    const dd = doctorDoc(cwd);
    assert(dd.code === 0 || dd.code === 1);
    assert(dd.doc.version === 1);
    assert(Array.isArray(dd.doc.checks) && (dd.doc.checks as unknown[]).length > 0);

    const checks = readyChecks(cwd, root);
    assert(Array.isArray(checks) && checks.length > 0);

    const td = tmp();
    const oldCwd = process.cwd();
    try {
      process.chdir(td);
      const sout = captureStdout(() => {
        const rc = commandSupport(parseArgs([]));
        assert(rc === 0);
      });
      const bundle = sout.split("\n")[0]!;
      assert(existsSync(bundle));
      assert(readFileSync(bundle).subarray(0, 2).toString("utf-8") === "PK");
    } finally {
      process.chdir(oldCwd);
      rmSync(td, { recursive: true, force: true });
    }
  };

  const reviewPreview = (): void => {
    const td = tmp();
    try {
      spawnSync("sh", ["-c", "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i >/dev/null 2>&1"], { cwd: td });
      const root = rootForCwd(td);
      const previewEmpty = previewData(td, root);
      assert(previewEmpty.eligible === false);
      assert(previewEmpty.blockers.includes("no reviewable git diff detected"));
      writeFileSync(join(td, "x.txt"), "hello\n", "utf-8");
      const preview = previewData(td, root);
      assert(preview.eligible === true);
      assert(preview.changed_lines >= 1);
      assert(arraysEqual(preview.files_touched, ["x.txt"]));
      mkdirSync(join(skipMarkerPath(root), ".."), { recursive: true });
      writeJson(skipMarkerPath(root), { at: now() });
      const previewSkip = previewData(td, root);
      assert(previewSkip.eligible === false);
      assert(previewSkip.blockers.some((b) => b.includes("ccr-skip-next")));
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  const retentionPrune = (): void => {
    const td = tmp();
    try {
      const root = join(td, "ccr");
      const sessions = join(root, "sessions");
      const support = join(root, "support");
      mkdirSync(sessions, { recursive: true });
      mkdirSync(support, { recursive: true });
      const nowTs = Date.now() / 1000;
      for (let idx = 0; idx < 3; idx++) {
        const sdir = join(sessions, `s${idx}`);
        mkdirSync(sdir);
        const ts = nowTs - idx * 86400;
        utimesSync(sdir, ts, ts);
      }
      const bundle = join(support, "ccr-support-old.zip");
      writeFileSync(bundle, "zip-ish", "utf-8");
      const oldTs = nowTs - 40 * 86400;
      utimesSync(bundle, oldTs, oldTs);
      const candidates = pruneCandidates(root, 1, 30);
      const names = new Set(candidates.map((item) => basename(String(item.path))));
      assert(names.has("s1") && names.has("s2"));
      assert(names.has("ccr-support-old.zip"));
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  const effectiveConfig = (): void => {
    const doc = configDoc(process.cwd());
    assert(doc.version === 1);
    const env = doc.environment as Record<string, Record<string, string>>;
    assert(env.CCR_MAX_ROUNDS!.value === String(MAX_ROUNDS));
    assert(env.CCR_MAX_DIFF_BYTES!.value === String(MAX_DIFF_BYTES));
    assert((doc.excluded_paths as string[]).includes(".cmux/ccr/"));
    assert((doc.generated_commands as string[]).includes("ccr-config"));
    assert((doc.generated_commands as string[]).includes("ccr-check"));
  };

  const eventLogViewer = (): void => {
    const td = tmp();
    try {
      const root = join(td, "ccr");
      mkdirSync(root, { recursive: true });
      appendJsonl(join(root, "events.jsonl"), { at: "2026-01-01T00:00:00Z", type: "dirty", session_id: "s1" });
      appendJsonl(join(root, "events.jsonl"), { at: "2026-01-01T00:01:00Z", type: "skipped", reason: "test" });
      const events = readEvents(root, 1);
      assert(events.length === 1);
      assert(events[0]!.type === "skipped");
      writeFileSync(join(root, "events.jsonl"), "{bad-json\n", "utf-8");
      const invalid = readEvents(root, 10);
      assert(invalid.length > 0 && invalid[0]!.type === "invalid_json");
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  const intentExtraction = (): void => {
    const msg =
      "Here's a summary.\n\n" +
      "PURPOSE: Refactor the auth middleware so token rotation does not lose existing sessions.\n" +
      "NON_GOAL: rewriting the legacy /v1/logout endpoint\n" +
      "INVARIANT: existing JWT cookies stay valid until natural expiry\n" +
      "Applied:\n- ...\n";
    const parsed = extractIntentFromMessage(msg);
    assert(parsed.purpose.includes("token rotation"));
    assert(parsed.non_goal.includes("legacy"));
    assert(parsed.invariant.includes("JWT cookies"));

    const msg2 =
      "- **Purpose**: keep the queue worker idempotent\n" +
      "  even when redelivery happens within 30s\n" +
      "- **Non-goal**: changing the retry backoff\n" +
      "- **Invariant**: at-most-once side-effects per message_id\n";
    const parsed2 = extractIntentFromMessage(msg2);
    assert(parsed2.purpose.includes("idempotent"));
    assert(parsed2.purpose.includes("redelivery"));
    assert(parsed2.non_goal.includes("backoff"));
    assert(parsed2.invariant.includes("at-most-once"));

    const parsed3 = extractIntentFromMessage("PURPOSE: only purpose given\n");
    assert(parsed3.purpose === "only purpose given");
    assert(parsed3.non_goal === "");
    assert(parsed3.invariant === "");

    const none = extractIntentFromMessage("just a normal commit message");
    assert(none.purpose === "" && none.non_goal === "" && none.invariant === "");

    const td = tmp();
    try {
      const root = join(td, "ccr");
      const sid = "sid-intent";
      mkdirSync(sessionDir(root, sid), { recursive: true });
      writeFileSync(sessionIntentPath(root, sid), "PURPOSE: from file\nNON_GOAL: also from file\nINVARIANT: must hold\n", "utf-8");
      const picked = loadSessionIntent(root, sid, "PURPOSE: from message\n");
      assert(picked.purpose === "from file");
      assert(picked.non_goal === "also from file");

      const sid2 = "sid-msg";
      mkdirSync(sessionDir(root, sid2), { recursive: true });
      const picked2 = loadSessionIntent(root, sid2, "PURPOSE: from message only\n");
      assert(picked2.purpose === "from message only");
    } finally {
      rmSync(td, { recursive: true, force: true });
    }

    assert(arraysEqual(renderIntentSection({ purpose: "", non_goal: "", invariant: "" } as Intent), []));
    const rendered = renderIntentSection({ purpose: "p", non_goal: "", invariant: "i" } as Intent);
    const joined = rendered.join("\n");
    assert(joined.includes("## Purpose / Non-goal / Invariant"));
    assert(joined.includes("**Purpose**: p"));
    assert(joined.includes("**Non-goal**: _(missing)_"));
    assert(joined.includes("**Invariant**: i"));
  };

  const handoffDetectionAndDirtyClear = (): void => {
    assert(isCcrHandoffPrompt("[ccr-handoff]\nanything") === true);
    assert(isCcrHandoffPrompt("CCR review: NEEDS_CHANGES (round 2, 1 must-fix). …") === true);
    assert(isCcrHandoffPrompt("CCR review result: PASS …") === true);
    assert(isCcrHandoffPrompt("CCR automatic review request. Read the request file …") === true);
    assert(isCcrHandoffPrompt("CCR manual review request. Read request.md …") === true);
    assert(isCcrHandoffPrompt("please review the auth module") === false);
    assert(isCcrHandoffPrompt("the CCR review went well yesterday") === false);
    assert(isCcrHandoffPrompt("hello\nCCR review: PASS") === false);

    const td = tmp();
    try {
      const root = join(td, "ccr");
      const sid = "sid-receiver";
      mkdirSync(root, { recursive: true });
      markDirty(root, { session_id: sid }, "claude", "claude");
      assert(hasDirty(root, sid) === true);
      const state: Record<string, unknown> = {};
      handleUserPromptSubmit(root, state, { session_id: sid, prompt: "CCR review: NEEDS_CHANGES (round 1, 2 must-fix). …" }, "claude", "claude");
      assert(hasDirty(root, sid) === false, "handoff should clear receiver dirty");
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  const staleActiveReaper = (): void => {
    const td = tmp();
    try {
      const root = join(td, "ccr");
      mkdirSync(root, { recursive: true });
      const oldActive = { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "sid-A", created_at: "2000-01-01T00:00:00Z" };
      const keepOld: Record<string, unknown> = { active_request: { ...oldActive } };
      assert(reapStaleActive(root, keepOld, "UserPromptSubmit", { session_id: "sid-A" }, "claude") === false, "age reap must not fire on UserPromptSubmit");
      assert(typeof keepOld.active_request === "object" && keepOld.active_request !== null);
      const oldState: Record<string, unknown> = { active_request: { ...oldActive } };
      assert(reapStaleActive(root, oldState, "SessionStart", { session_id: "sid-A" }, "claude") === true);
      assert(oldState.active_request === null);
      const events = readEvents(root, 5);
      assert(events.length > 0 && events[0]!.type === "stale_active_discarded");
      assert(events[0]!.trigger_event === "SessionStart");

      unlinkIfExists(join(root, "events.jsonl"));
      const fresh = now();
      const mismatch: Record<string, unknown> = { active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "sid-OLD", created_at: fresh } };
      assert(reapStaleActive(root, mismatch, "SessionStart", { session_id: "sid-NEW" }, "claude") === true);
      assert(mismatch.active_request === null);

      unlinkIfExists(join(root, "events.jsonl"));
      const keepState: Record<string, unknown> = { active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "sid-A", created_at: fresh } };
      assert(reapStaleActive(root, keepState, "UserPromptSubmit", { session_id: "sid-A" }, "claude") === false);
      assert(typeof keepState.active_request === "object" && keepState.active_request !== null);

      unlinkIfExists(join(root, "events.jsonl"));
      const reviewerState: Record<string, unknown> = { active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "sid-WORKER", created_at: fresh } };
      assert(reapStaleActive(root, reviewerState, "UserPromptSubmit", { session_id: "sid-REVIEWER" }, "codex") === false, "reviewer UserPromptSubmit must not reap");
      assert(typeof reviewerState.active_request === "object" && reviewerState.active_request !== null);
      assert(reapStaleActive(root, reviewerState, "SessionStart", { session_id: "sid-REVIEWER" }, "codex") === false, "reviewer SessionStart must not reap");
      assert(typeof reviewerState.active_request === "object" && reviewerState.active_request !== null);

      const manualState: Record<string, unknown> = { active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: "manual-123-claude", manual: true, created_at: fresh } };
      assert(reapStaleActive(root, manualState, "UserPromptSubmit", { session_id: "real-sid" }, "claude") === false, "manual/worker UserPromptSubmit mismatch must not reap");
      assert(typeof manualState.active_request === "object" && manualState.active_request !== null);

      const emptyState: Record<string, unknown> = {};
      assert(reapStaleActive(root, emptyState, "UserPromptSubmit", { session_id: "sid" }, "claude") === false);
      assert(Object.keys(emptyState).length === 0);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  };

  return [
    ["decision parser", decisionParser],
    ["dirty filter", dirtyFilter],
    ["handoff and prompt reset safety", handoffAndPrompt],
    ["diff truncation helpers", truncationAndDiff],
    ["doctor/ready/support JSON smoke", doctorReadySupportJson],
    ["review preview", reviewPreview],
    ["retention prune", retentionPrune],
    ["effective config", effectiveConfig],
    ["event log viewer", eventLogViewer],
    ["intent extraction", intentExtraction],
    ["handoff detection and dirty clear", handoffDetectionAndDirtyClear],
    ["stale active reaper", staleActiveReaper],
  ];
}

function unlinkIfExists(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* missing_ok */
  }
}

function runCase(name: string, fn: () => void): SelftestResult {
  try {
    fn();
    return { name, status: "PASS", detail: "" };
  } catch (exc) {
    return { name, status: "FAIL", detail: exc instanceof Error ? exc.message : String(exc) };
  }
}

export function selftestResults(): SelftestResult[] {
  return cases().map(([name, fn]) => runCase(name, fn));
}

/** Python `_selftest_doc_for_check` (2725-2733). */
export function selftestDoc(): { code: number; doc: Record<string, unknown> } {
  const results = selftestResults();
  const failed = results.filter((r) => r.status !== "PASS");
  return {
    code: failed.length === 0 ? 0 : 1,
    doc: { version: 1, passed: results.length - failed.length, failed: failed.length, results },
  };
}

export function commandSelftest(jsonOutput: boolean): number {
  const results = selftestResults();
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status !== "PASS");
  if (jsonOutput) {
    out(JSON.stringify({ version: 1, passed, failed: failed.length, results }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }
  out("CCR Self-Test");
  for (const result of results) {
    const detail = result.detail ? ` ${result.detail}` : "";
    out(`[${ljust(result.status, 4)}] ${result.name}${detail}`);
  }
  out();
  out(`Summary: ${passed} passed, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}
