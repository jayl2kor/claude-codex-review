/**
 * review.ts — review-flow FS helpers + stale-request reaper, Phase 4a/4b-2 of
 * the Python->Bun migration (ccr-hook.py). The review-REQUEST markdown builders
 * live in request.ts.
 *
 * Ported from ccr-hook.py: find_previous_round_dir (826-830),
 * parse_previous_review (916-933), build_worker_followup (936-948) [4a];
 * consume_skip_marker (1513-1524), _active_request_age_seconds (1527-1538),
 * reap_stale_active (1541-1605) [4b-2a].
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import { readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadJson, writeJson, now, appendJsonl } from "./io";
import { countMustFixInText, parseDecision, parseReviewVerdict } from "./decision";
import { sessionDir, sessionLedgerPath, skipMarkerPath } from "./paths";
import { writeStatus, clearDirty, hasDirty, readPromptGate, clearPromptGate } from "./lock";
import { cmuxLog, cmuxStatus, cmuxNotify, sendToSurface, surfaceForRole } from "./cmux";
import { MAX_ROUNDS, MIN_DIFF_LINES, STALE_ACTIVE_SECONDS, promptGateMode } from "./constants";
import { suppressReason } from "./promptgate";
import { opposite } from "./text";
import { collectDiff, computeDeltaPatch } from "./git";
import { requestMarkdown } from "./request";
import {
  appendLedger,
  buildIterationTable,
  loadReviewInstructions,
  loadSessionContext,
  loadSessionIntent,
} from "./session";
import { tryGenerateReport } from "./report";
import { strip, cpCompare } from "./pycompat";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface PreviousReview {
  review_file: string;
  decision: string;
  must_fix_count: number;
}

export interface WorkerFollowup {
  file: string;
  message: string;
  files: string[];
}

/** Python `find_previous_round_dir` (826-830). Returns the dir path or null. */
export function findPreviousRoundDir(root: string, sid: string, roundNo: number): string | null {
  if (roundNo <= 1) {
    return null;
  }
  const prev = join(sessionDir(root, sid), "rounds", String(roundNo - 1).padStart(4, "0"));
  return isDir(prev) ? prev : null;
}

/** Python `parse_previous_review` (916-933). null when no decision.json. */
export function parsePreviousReview(prevDir: string | null): PreviousReview | null {
  if (prevDir === null) {
    return null;
  }
  const decisionPath = join(prevDir, "decision.json");
  const reviewPath = join(prevDir, "review.md");
  if (!isFile(decisionPath)) {
    return null;
  }
  const decision = (loadJson<Record<string, unknown>>(decisionPath, {}) || {}) as Record<string, unknown>;
  let mustFix = 0;
  if (isFile(reviewPath)) {
    mustFix = countMustFixInText(readFileSync(reviewPath, "utf-8"));
  }
  return {
    review_file: isFile(reviewPath) ? reviewPath : "",
    decision: String(decision.decision || ""),
    must_fix_count: mustFix,
  };
}

/**
 * Find the most recently reviewed round across ALL sessions under `root` (the
 * newest decision.json by mtime), optionally excluding one session id. Returns
 * the round dir + its diff.patch path, or null when none exists.
 *
 * The automatic loop accumulates rounds under one stable session id and uses
 * findPreviousRoundDir; the manual `ccr-request --follow-up` path cannot, because
 * each manual request lands in a fresh `manual-<ts>` session, so the previous
 * review lives in a DIFFERENT session dir. This cross-session lookup bridges that.
 */
export function findLatestReviewedRound(
  root: string,
  excludeSessionId: string = "",
): { roundDir: string; sessionId: string; diffFile: string } | null {
  const sessionsDir = join(root, "sessions");
  if (!isDir(sessionsDir)) {
    return null;
  }
  let sessionNames: string[];
  try {
    sessionNames = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let best: { roundDir: string; sessionId: string; mtime: number } | null = null;
  for (const sid of sessionNames) {
    if (sid === excludeSessionId) {
      continue;
    }
    const roundsDir = join(sessionsDir, sid, "rounds");
    if (!isDir(roundsDir)) {
      continue;
    }
    let roundNames: string[];
    try {
      roundNames = readdirSync(roundsDir);
    } catch {
      continue;
    }
    for (const r of roundNames) {
      const roundDir = join(roundsDir, r);
      try {
        const st = statSync(join(roundDir, "decision.json"));
        if (!st.isFile()) {
          continue;
        }
        if (best === null || st.mtimeMs > best.mtime) {
          best = { roundDir, sessionId: sid, mtime: st.mtimeMs };
        }
      } catch {
        /* no decision.json in this round */
      }
    }
  }
  if (best === null) {
    return null;
  }
  return { roundDir: best.roundDir, sessionId: best.sessionId, diffFile: join(best.roundDir, "diff.patch") };
}

/**
 * Python `build_worker_followup` (936-948): persist the worker's last message as
 * worker-followup.md (only when non-empty) and return the follow-up context.
 * null when there is neither a message nor any touched files.
 */
export function buildWorkerFollowup(
  roundDir: string,
  filesTouched: string[],
  inputData: Record<string, unknown>,
): WorkerFollowup | null {
  const message = strip(String((inputData.last_assistant_message as unknown) || ""));
  const files = [...new Set(filesTouched)].sort(cpCompare);
  if (!message && files.length === 0) {
    return null;
  }
  const followupPath = join(roundDir, "worker-followup.md");
  if (message) {
    writeFileSync(followupPath, message + "\n", "utf-8");
  }
  return {
    file: message ? followupPath : "",
    message,
    files,
  };
}

// ---------------------------------------------------------------------------
// Phase 4b-2a: stale-request reaper + skip marker
// ---------------------------------------------------------------------------

/** Python `consume_skip_marker` (1513-1524): read+remove skip-next.json, or null. */
export function consumeSkipMarker(root: string): Record<string, unknown> | null {
  const path = skipMarkerPath(root);
  if (!isFile(path)) {
    return null;
  }
  let data = loadJson<unknown>(path, {});
  if (!isPlainObject(data)) {
    data = {};
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  }
  return data as Record<string, unknown>;
}

/**
 * Python `_active_request_age_seconds` (1527-1538): seconds since the active
 * request's `created_at` (ISO-8601 UTC), or null if absent/unparseable.
 */
export function activeRequestAgeSeconds(active: Record<string, unknown>): number | null {
  const raw = strip(String(active.created_at ?? ""));
  if (!raw) {
    return null;
  }
  const ms = Date.parse(raw.replace("Z", "+00:00"));
  if (Number.isNaN(ms)) {
    return null;
  }
  return (Date.now() - ms) / 1000;
}

/**
 * Python `reap_stale_active` (1541-1605): clear state.active_request when stale
 * (age-based on SessionStart) or orphaned (SessionStart from the worker surface
 * whose session_id differs from the active worker_session_id). Mutates `state`
 * in place; returns true when cleared.
 */
export function reapStaleActive(
  root: string,
  state: Record<string, unknown>,
  event: string,
  inputData: Record<string, unknown>,
  role: string,
): boolean {
  const active = state.active_request;
  if (!isPlainObject(active)) {
    return false;
  }
  const age = activeRequestAgeSeconds(active);
  const sid = strip(String(inputData.session_id ?? ""));
  const activeSid = strip(String(active.worker_session_id ?? ""));

  let reason: string | null = null;
  if (
    event === "SessionStart" &&
    STALE_ACTIVE_SECONDS > 0 &&
    age !== null &&
    age >= STALE_ACTIVE_SECONDS
  ) {
    reason = `age=${Math.trunc(age)}s >= ${STALE_ACTIVE_SECONDS}s`;
  } else if (
    event === "SessionStart" &&
    role === active.worker &&
    sid &&
    activeSid &&
    sid !== activeSid
  ) {
    const ageLabel = age !== null ? `age=${Math.trunc(age)}s` : "age=unknown";
    reason = `session mismatch (incoming=${sid} active=${activeSid}, ${ageLabel})`;
  }

  if (reason === null) {
    return false;
  }

  cmuxLog("warning", `discarding stale active_request: ${reason}`);
  appendJsonl(join(root, "events.jsonl"), {
    at: now(),
    type: "stale_active_discarded",
    trigger_event: event,
    reason,
    age_seconds: age !== null ? Math.trunc(age) : null,
    threshold: STALE_ACTIVE_SECONDS,
    round: Number(active.round || 0),
    worker: active.worker ?? null,
    reviewer: active.reviewer ?? null,
    session_id: sid,
    active_session_id: activeSid,
  });
  state.active_request = null;
  writeStatus(root, state, "ready", `stale active discarded (${reason})`);
  cmuxStatus("CCR ready", "#34C759");
  return true;
}

// ---------------------------------------------------------------------------
// Phase 4b-2b: review orchestration (start_review / finish_review)
// ---------------------------------------------------------------------------

/** Python f"{n:04d}" — zero-pad to >= 4 digits (never truncates). */
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Mirror Python `int(state.get("review_count", 0))`: 0 when absent. */
function reviewCount(state: Record<string, unknown>): number {
  const v = Object.prototype.hasOwnProperty.call(state, "review_count") ? state.review_count : 0;
  return Math.trunc(Number(v || 0));
}

/**
 * Python `start_review` (1608-1727): on the worker's Stop, collect the diff and
 * (subject to the active/max-rounds/no-diff/min-lines/same-hash/skip-marker
 * guards) open a new outgoing review round — writing diff.patch + request.md,
 * sending the handoff to the reviewer surface, and recording `active_request`.
 * Mutates `state` in place to match Python's locked_state contract.
 */
export function startReview(
  root: string,
  state: Record<string, unknown>,
  inputData: Record<string, unknown>,
  role: string,
): void {
  const sid = String((inputData.session_id as unknown) || "");
  const cwd = String((inputData.cwd as unknown) || "");
  if (!sid || !cwd || !hasDirty(root, sid)) {
    return;
  }
  if (isPlainObject(state.active_request)) {
    cmuxLog("progress", "review already active; worker stop ignored");
    return;
  }
  if (reviewCount(state) >= MAX_ROUNDS) {
    clearDirty(root, sid);
    writeStatus(root, state, "stopped", `max rounds reached (${MAX_ROUNDS})`);
    cmuxStatus("CCR max rounds", "#FF9500");
    cmuxNotify("CCR stopped", `Maximum review rounds reached: ${MAX_ROUNDS}`);
    tryGenerateReport(root, sid, "max_rounds");
    return;
  }
  const [diffText, diffHash, head, hasContent, fullChanged, filesTouched] = collectDiff(cwd);
  if (!hasContent) {
    clearDirty(root, sid);
    writeStatus(root, state, "idle", "no diff");
    cmuxStatus("CCR idle", "#34C759");
    return;
  }
  if (MIN_DIFF_LINES > 0) {
    const changed = fullChanged;
    if (changed < MIN_DIFF_LINES) {
      clearDirty(root, sid);
      const reason = `diff has ${changed} changed lines (< CCR_MIN_DIFF_LINES=${MIN_DIFF_LINES})`;
      writeStatus(root, state, "skipped", reason);
      cmuxStatus("CCR skipped", "#8E8E93");
      cmuxLog("progress", `diff below threshold (${changed} < ${MIN_DIFF_LINES})`);
      appendJsonl(join(root, "events.jsonl"), {
        at: now(),
        type: "skipped",
        reason: "below_min_diff_lines",
        changed_lines: changed,
        threshold: MIN_DIFF_LINES,
        session_id: sid,
      });
      return;
    }
  }
  if (diffHash === state.last_diff_hash) {
    clearDirty(root, sid);
    writeStatus(root, state, "stopped", "same diff hash");
    cmuxStatus("CCR same diff", "#FF9500");
    cmuxNotify("CCR stopped", "Same diff hash detected; automatic loop stopped.");
    tryGenerateReport(root, sid, "same_hash");
    return;
  }

  const marker = consumeSkipMarker(root);
  if (marker !== null) {
    clearDirty(root, sid);
    writeStatus(root, state, "skipped", "ccr-skip-next consumed");
    cmuxStatus("CCR skipped", "#8E8E93");
    cmuxLog("progress", "ccr-skip-next consumed; outgoing review skipped");
    appendJsonl(join(root, "events.jsonl"), {
      at: now(),
      type: "skipped",
      reason: "ccr-skip-next",
      session_id: sid,
      by_surface: Object.prototype.hasOwnProperty.call(marker, "by_surface") ? marker.by_surface : "",
    });
    return;
  }

  // Prompt-based gate (CCR_PROMPT_GATE), suppress-only: an agent CCR_REVIEW:skip
  // verdict, or a read-only-classified prompt with no overriding verdict, drops
  // this otherwise-eligible review. Placed last so the deterministic diff gates
  // (no-diff / min-lines / same-hash / ccr-skip-next) keep precedence and their
  // own reasons; this only matters when there IS a genuine, novel diff.
  const gateMode = promptGateMode();
  if (gateMode !== "off") {
    const verdict = parseReviewVerdict(String((inputData.last_assistant_message as unknown) || ""));
    const promptWants = readPromptGate(root, sid);
    clearPromptGate(root, sid); // per-turn marker: always consume
    const reason = suppressReason(verdict, promptWants);
    if (gateMode === "advisory") {
      appendJsonl(join(root, "events.jsonl"), {
        at: now(),
        type: "review_gate_advisory",
        reason: reason ?? "proceed",
        session_id: sid,
      });
    } else if (reason) {
      clearDirty(root, sid);
      writeStatus(root, state, "skipped", reason);
      cmuxStatus("CCR skipped", "#8E8E93");
      cmuxLog("progress", `prompt gate: ${reason}; outgoing review suppressed`);
      appendJsonl(join(root, "events.jsonl"), {
        at: now(),
        type: "skipped",
        reason,
        session_id: sid,
      });
      return;
    }
  }

  const roundNo = reviewCount(state) + 1;
  const reviewer = opposite(role);
  const reviewerSurface = surfaceForRole(reviewer);
  const workerSurface = surfaceForRole(role);
  const roundDir = join(sessionDir(root, sid), "rounds", pad4(roundNo));
  mkdirSync(roundDir, { recursive: true });
  const diffFile = join(roundDir, "diff.patch");
  const requestFile = join(roundDir, "request.md");
  writeFileSync(diffFile, diffText, "utf-8");

  const prevDir = findPreviousRoundDir(root, sid, roundNo);
  let deltaFile: string | null = null;
  let previousReview: PreviousReview | null = null;
  if (prevDir !== null) {
    previousReview = parsePreviousReview(prevDir);
    const candidate = join(roundDir, "delta.patch");
    if (computeDeltaPatch(join(prevDir, "diff.patch"), diffFile, candidate)) {
      deltaFile = candidate;
    }
  }
  const workerFollowup = prevDir !== null ? buildWorkerFollowup(roundDir, filesTouched, inputData) : null;

  const instructions = loadReviewInstructions(root);
  const taskContext = loadSessionContext(root, sid);
  const iterationTable = buildIterationTable(root, sid, roundNo);
  const lastMessageForIntent = String((inputData.last_assistant_message as unknown) || "");
  const intent = loadSessionIntent(root, sid, lastMessageForIntent);
  writeFileSync(
    requestFile,
    requestMarkdown(
      role,
      reviewer,
      roundNo,
      diffHash,
      head,
      diffFile,
      deltaFile,
      previousReview as unknown as Record<string, unknown> | null,
      workerFollowup as unknown as Record<string, unknown> | null,
      instructions,
      taskContext,
      iterationTable,
      intent as unknown as Record<string, unknown>,
    ),
    "utf-8",
  );

  const message =
    "CCR automatic review request. Read the request file and perform the review only — do not edit files.\n\n" +
    `Request: ${requestFile}`;
  if (!sendToSurface(reviewerSurface, message)) {
    clearDirty(root, sid);
    writeStatus(root, state, "error", `failed to send to ${reviewer}`);
    cmuxStatus("CCR send failed", "#FF3B30");
    cmuxNotify("CCR send failed", `Could not send review request to ${reviewer}.`);
    return;
  }

  state.review_count = roundNo;
  state.last_diff_hash = diffHash;
  state.active_request = {
    round: roundNo,
    worker: role,
    reviewer,
    worker_session_id: sid,
    worker_surface: workerSurface,
    reviewer_surface: reviewerSurface,
    request_file: requestFile,
    diff_file: diffFile,
    diff_hash: diffHash,
    created_at: now(),
  };
  clearDirty(root, sid);
  writeStatus(root, state, "waiting_for_review", `round ${roundNo} sent to ${reviewer}`);
  cmuxStatus(`CCR r${roundNo} review`, "#0A84FF");
  cmuxLog("progress", `round ${roundNo} sent from ${role} to ${reviewer}`);
}

/**
 * Python `finish_review` (1753-1860): on the reviewer's Stop, finalize the
 * active review reply — write review.md + decision.json, append the ledger row,
 * send the decision-specific handoff back to the worker, update state, and
 * (except for NEEDS_CHANGES) generate the session report. Returns true when an
 * active_request was finalized (so the Stop dispatcher suppresses a following
 * start_review from the same firing). Mutates `state` in place.
 */
export function finishReview(
  root: string,
  state: Record<string, unknown>,
  inputData: Record<string, unknown>,
  role: string,
): boolean {
  const active = state.active_request;
  if (!isPlainObject(active) || active.reviewer !== role) {
    return false;
  }
  const lastMessage = String((inputData.last_assistant_message as unknown) || "");
  if (!strip(lastMessage)) {
    return false;
  }
  const reviewerSid = String((inputData.session_id as unknown) || "");
  const workerSessionId = String((active.worker_session_id as unknown) || "");
  const roundNo = Math.trunc(Number(active.round || 0));
  const roundDir = join(sessionDir(root, workerSessionId), "rounds", pad4(roundNo));
  const reviewFile = join(roundDir, "review.md");
  const decisionFile = join(roundDir, "decision.json");
  writeFileSync(reviewFile, lastMessage + "\n", "utf-8");
  const decision = parseDecision(lastMessage);
  const mustFixCount = countMustFixInText(lastMessage);
  writeJson(decisionFile, {
    decision,
    reviewer: role,
    worker: active.worker ?? null,
    round: roundNo,
    review_file: reviewFile,
    must_fix_count: mustFixCount,
    updated_at: now(),
  });
  appendLedger(root, workerSessionId, roundNo, decision, mustFixCount, reviewFile);
  const ledgerFile = sessionLedgerPath(root, workerSessionId);

  const workerSurface = String((active.worker_surface as unknown) || "");
  if (decision === "PASS") {
    const message =
      "CCR review result: PASS. " +
      'Skim the review for any "Should Consider" notes, then finish the task ' +
      "(commit, push, or hand back to the user as appropriate). " +
      "Do not start unrelated changes.\n\n" +
      `Review: ${reviewFile}\n` +
      `Ledger (full session arc): ${ledgerFile}`;
    sendToSurface(workerSurface, message);
    state.last_completed = { round: roundNo, decision, at: now() };
    state.active_request = null;
    if (reviewerSid) {
      clearDirty(root, reviewerSid);
    }
    writeStatus(root, state, "passed", `round ${roundNo}`);
    cmuxStatus("CCR pass", "#34C759");
    cmuxLog("success", `round ${roundNo} review passed`);
    tryGenerateReport(root, workerSessionId, "passed");
    return true;
  }

  if (decision === "NEEDS_CHANGES") {
    const message =
      `CCR review: NEEDS_CHANGES (round ${roundNo}, ${mustFixCount} must-fix). Read the review, then:\n` +
      "1) Apply the Must Fix items you agree with. If you disagree with an item, push back explicitly — do not silently skip it.\n" +
      "2) Touch only what the review calls out. No unrelated cleanup or refactors this round.\n" +
      '3) End your reply with an "Applied / Not applied (reason)" list, one bullet per review item. ' +
      "This list is forwarded to the reviewer next round, so cite `file:line` and be specific.\n\n" +
      `Review: ${reviewFile}\n` +
      `Ledger (full session arc): ${ledgerFile}`;
    sendToSurface(workerSurface, message);
    state.active_request = null;
    if (reviewerSid) {
      clearDirty(root, reviewerSid);
    }
    writeStatus(root, state, "changes_requested", `round ${roundNo}`);
    cmuxStatus(`CCR r${roundNo} changes`, "#FF9500");
    cmuxLog("warning", `round ${roundNo} changes requested`);
    return true;
  }

  if (decision === "NEEDS_HUMAN") {
    const message =
      "CCR review: NEEDS_HUMAN. The reviewer flagged a policy / security / business decision " +
      "outside an agent's safe scope. Do not auto-apply any changes. " +
      "Surface the review to the user, summarize the decision they need to make, and wait for their call.\n\n" +
      `Review: ${reviewFile}\n` +
      `Ledger (full session arc): ${ledgerFile}`;
    sendToSurface(workerSurface, message);
    state.last_completed = { round: roundNo, decision, at: now() };
    state.active_request = null;
    if (reviewerSid) {
      clearDirty(root, reviewerSid);
    }
    writeStatus(root, state, "manual_intervention", `round ${roundNo} needs human`);
    cmuxStatus(`CCR r${roundNo} needs human`, "#FF9500");
    cmuxLog("warning", `round ${roundNo} needs human review`);
    cmuxNotify("CCR needs human", `Round ${roundNo} review requires human decision: ${reviewFile}`);
    tryGenerateReport(root, workerSessionId, "needs_human");
    return true;
  }

  state.active_request = null;
  if (reviewerSid) {
    clearDirty(root, reviewerSid);
  }
  writeStatus(root, state, "manual_intervention", `invalid decision in round ${roundNo}`);
  cmuxStatus("CCR manual", "#FF3B30");
  cmuxNotify("CCR needs manual review", `Invalid review decision in ${reviewFile}`);
  tryGenerateReport(root, workerSessionId, "invalid");
  return true;
}
