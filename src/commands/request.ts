/**
 * request.ts — `ccr-request`. Faithful port of ccr-hook.py command_request
 * (2099-2206): build a manual, scoped review request (scope.json + request.md,
 * optional captured diff), send it to the reviewer surface, and record the
 * active_request.
 *
 * NOTE: the session id is `manual-<int(time.time())>-<worker>`, so it differs
 * run-to-run; the oracle test normalizes `manual-<digits>-` before comparing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeJson, now } from "../lib/io";
import { rootForCwd, sessionDir, workspaceId, surfaceId } from "../lib/paths";
import {
  workspaceEnabled, surfaceForRole, roleForCurrentSurface, sendToSurface, cmuxStatus, cmuxLog,
} from "../lib/cmux";
import { lockedState, writeStatus } from "../lib/lock";
import { opposite, sanitize } from "../lib/text";
import { collectDiff } from "../lib/git";
import { loadReviewInstructions } from "../lib/session";
import { scopeRequestMarkdown } from "../lib/request";
import { strip } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out, err, g } from "./shared";

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
function isAgentRole(role: string): boolean {
  return role === "claude" || role === "codex";
}

export function commandRequest(args: CcrArgs): number {
  const wid = workspaceId();
  if (!wid) {
    err("cmux workspace 안에서 실행해야 합니다.");
    return 1;
  }
  if (!workspaceEnabled()) {
    err("CCR is not enabled for this cmux workspace. Run ccr-enable first.");
    return 1;
  }
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const role = roleForCurrentSurface();
  let reviewer = args.reviewer;
  if (reviewer === "auto") {
    if (isAgentRole(role)) {
      reviewer = opposite(role);
    } else {
      err("--reviewer is required when the current surface is not registered as Claude or Codex.");
      return 1;
    }
  }
  const worker = isAgentRole(role) ? role : "manual";
  const workerSurface = isAgentRole(worker) ? surfaceForRole(worker) : surfaceId();
  const reviewerSurface = surfaceForRole(reviewer);
  if (!reviewerSurface) {
    err(`No registered ${reviewer} surface. Run cmux-setup-${reviewer} in that terminal.`);
    return 1;
  }
  // Self-routing guard: a review must go to the *other* agent, never loop back
  // to the worker. `--reviewer auto` already picks the opposite role, but an
  // explicit `--reviewer <same>` or a mis-registered surface (both
  // claude-surface and codex-surface pointing at this terminal) would otherwise
  // send the request to ourselves.
  if (isAgentRole(worker) && reviewer === worker) {
    err(`Refusing to route a review back to the worker (${worker}). Use --reviewer auto or the opposite agent.`);
    return 1;
  }
  if (reviewerSurface === workerSurface) {
    err(
      `Reviewer surface equals the worker surface (${reviewerSurface}); the review would loop back to this terminal. ` +
        `Check cmux-setup-claude / cmux-setup-codex registration.`,
    );
    return 1;
  }

  mkdirSync(root, { recursive: true });
  let rc = 0;
  lockedState(root, (state) => {
    if (state.active_request) {
      err("A CCR request is already active. Wait for it to finish or run ccr-reset.");
      rc = 1;
      return;
    }
    const roundNo = Math.trunc(Number(g(state, "review_count", 0) || 0)) + 1;
    const sessionId = `manual-${Math.trunc(Date.now() / 1000)}-${sanitize(worker)}`;
    const roundDir = join(sessionDir(root, sessionId), "rounds", pad4(roundNo));
    mkdirSync(roundDir, { recursive: true });
    const scopeFile = join(roundDir, "scope.json");
    const requestFile = join(roundDir, "request.md");
    const diffFile = join(roundDir, "diff.patch");

    let diffHash = "";
    let head = "";
    let diffPath: string | null = null;
    if (args.use_diff) {
      const [diffText, dh, hd] = collectDiff(cwd);
      diffHash = dh;
      head = hd;
      if (strip(diffText)) {
        writeFileSync(diffFile, diffText, "utf-8");
        diffPath = diffFile;
      }
    }

    const scope: Record<string, unknown> = {
      version: 1,
      type: args.type,
      title: args.title || args.type,
      worker,
      reviewer,
      cwd,
      workspace_id: wid,
      worker_surface: workerSurface,
      reviewer_surface: reviewerSurface,
      files: args.file ?? [],
      directories: args.dir ?? [],
      questions: args.question ?? [],
      notes: args.note ?? [],
      use_diff: Boolean(args.use_diff),
      diff_hash: diffHash,
      git_head: head,
      scope_file: scopeFile,
      diff_file: diffPath,
      instructions: loadReviewInstructions(root),
      intent: {
        purpose: strip(args.purpose || ""),
        non_goal: strip(args.non_goal || ""),
        invariant: strip(args.invariant || ""),
      },
      created_at: now(),
    };
    writeJson(scopeFile, scope);
    writeFileSync(requestFile, scopeRequestMarkdown(scope), "utf-8");

    const message =
      "CCR manual review request. Read request.md and scope.json, then perform the review only — do not edit files.\n\n" +
      `Request: ${requestFile}`;
    if (!sendToSurface(reviewerSurface, message)) {
      err(`Failed to send request to ${reviewer}.`);
      writeStatus(root, state, "error", `failed to send manual request to ${reviewer}`);
      rc = 1;
      return;
    }

    state.review_count = roundNo;
    if (diffHash) {
      state.last_diff_hash = diffHash;
    }
    state.active_request = {
      round: roundNo,
      worker,
      reviewer,
      worker_session_id: sessionId,
      worker_surface: workerSurface,
      reviewer_surface: reviewerSurface,
      request_file: requestFile,
      scope_file: scopeFile,
      diff_file: diffPath,
      diff_hash: diffHash,
      manual: true,
      created_at: now(),
    };
    writeStatus(root, state, "waiting_for_review", `manual ${args.type} sent to ${reviewer}`);
    cmuxStatus(`CCR manual r${roundNo}`, "#0A84FF");
    cmuxLog("progress", `manual ${args.type} request round ${roundNo} sent to ${reviewer}`);
    out(`Sent CCR ${args.type} request to ${reviewer}: ${requestFile}`);
    rc = 0;
  });
  return rc;
}
