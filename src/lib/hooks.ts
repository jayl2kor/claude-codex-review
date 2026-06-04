/**
 * hooks.ts — per-event hook dispatch, Phase 4b-2b of the Python->Bun migration
 * (ccr-hook.py).
 *
 * Ported from ccr-hook.py: handle_pre_tool (1875-1885), handle_user_prompt_submit
 * (1888-1924), handle_hook (1927-1972), ensure_info_exclude (1975-1991).
 *
 * handle_hook returns the hook RESULT dict (or null) with Python key order; the
 * byte-exact stdout serialization of that result (print(json.dumps(...))) is a
 * Phase 5 CLI concern. Because lockedState's callback is void-returning, the
 * dispatch result is captured via a closure variable and returned after the
 * locked section writes state back — matching Python's `with locked_state` where
 * each branch's `return` triggers __exit__ (state writeback) on the way out.
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { getOrNull, now, appendJsonl } from "./io";
import { rootForCwd, sessionContextPath } from "./paths";
import { lockedState, writeStatus, ensureSession, markDirty, clearDirty, writePromptGate, clearPromptGate } from "./lock";
import { cmuxLog, cmuxStatus, roleForCurrentSurface, workspaceEnabled } from "./cmux";
import { toolName, toolCommand, bashLooksMutating, shouldMarkDirtyForTool } from "./tool";
import { reviewerBlockResponse } from "./misc";
import { reapStaleActive, startReview, finishReview } from "./review";
import { captureSessionContext } from "./session";
import { isCcrHandoffPrompt } from "./intent";
import { promptWantsReview } from "./promptgate";
import { insideGit, git } from "./git";
import { MUTATING_TOOL_NAMES, promptGateMode } from "./constants";
import { strip } from "./pycompat";

type HookResult = Record<string, unknown> | null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Python `handle_pre_tool` (1875-1885): while a review is active and this surface
 * is the reviewer, block mutating tools and return the agent-specific block
 * response; otherwise null.
 */
export function handlePreTool(
  root: string,
  state: Record<string, unknown>,
  inputData: Record<string, unknown>,
  agent: string,
  role: string,
): HookResult {
  const active = state.active_request;
  if (!isPlainObject(active) || active.reviewer !== role) {
    return null;
  }
  const name = toolName(inputData);
  const command = toolCommand(inputData);
  const shouldBlock = MUTATING_TOOL_NAMES.has(name) || (name === "Bash" && bashLooksMutating(command));
  if (!shouldBlock) {
    return null;
  }
  cmuxLog("warning", `blocked mutating reviewer tool: ${role}/${name}`);
  return reviewerBlockResponse(
    agent,
    "CCR reviewer-only mode is active. Review the request file without modifying files.",
  );
}

/**
 * Python `handle_user_prompt_submit` (1888-1924): handle a fresh user prompt —
 * clear the receiver's dirty marker on a CCR handoff, ignore prompts while a
 * review is active, capture first-prompt context, and otherwise reset the round
 * counter for a new worker request. Mutates `state` in place.
 */
export function handleUserPromptSubmit(
  root: string,
  state: Record<string, unknown>,
  inputData: Record<string, unknown>,
  agent: string,
  role: string,
): void {
  const sid = String((inputData.session_id as unknown) || "");
  const prompt = String((inputData.prompt as unknown) || "");
  if (isCcrHandoffPrompt(prompt)) {
    if (sid) {
      clearDirty(root, sid);
      // A handoff prompt must never influence the gate: clear any stale marker
      // and write none (it returns before classification below).
      clearPromptGate(root, sid);
    }
    cmuxLog("progress", "UserPromptSubmit: CCR handoff received; cleared receiver dirty marker");
    return;
  }
  if (isPlainObject(state.active_request)) {
    cmuxLog("progress", "UserPromptSubmit ignored while review is active");
    return;
  }
  // Classify this turn's prompt for the suppress-only review gate (CCR_PROMPT_GATE).
  // Per-turn marker, consumed+cleared at the worker Stop (mirrors dirty.json).
  const gateOn = promptGateMode() !== "off";
  const promptWants = gateOn && sid ? promptWantsReview(prompt) : null;
  const prevCount = Math.trunc(
    Number((Object.prototype.hasOwnProperty.call(state, "review_count") ? state.review_count : 0) || 0),
  );
  if (prevCount === 0 && !state.last_diff_hash) {
    if (sid && prompt && !isFile(sessionContextPath(root, sid))) {
      captureSessionContext(root, sid, prompt);
    }
    if (gateOn && sid) {
      writePromptGate(root, sid, promptWants, prompt.slice(0, 120));
    }
    return;
  }
  state.review_count = 0;
  state.last_diff_hash = "";
  if (sid && prompt) {
    captureSessionContext(root, sid, prompt);
  }
  if (gateOn && sid) {
    writePromptGate(root, sid, promptWants, prompt.slice(0, 120));
  }
  writeStatus(root, state, "ready", `new ${role} request (round counter reset)`);
  cmuxStatus("CCR ready", "#34C759");
  cmuxLog("progress", `user prompt: review_count reset (was ${prevCount})`);
  appendJsonl(join(root, "events.jsonl"), {
    at: now(),
    type: "user_prompt",
    agent,
    role,
    session_id: sid,
    prev_review_count: prevCount,
  });
}

/**
 * Python `handle_hook` (1927-1972): gate on workspace-enabled + known role, then
 * run the per-event dispatch under the state lock. Returns the hook result dict
 * (or null) with Python key order.
 */
export function handleHook(agent: string, event: string, inputData: Record<string, unknown>): HookResult {
  const cwd = String(getOrNull(inputData, "cwd") || process.cwd());
  const role = roleForCurrentSurface();
  if (!workspaceEnabled() || role === "unknown") {
    return agent === "codex" && event === "Stop" ? {} : null;
  }

  const root = rootForCwd(cwd);
  // Default mirrors the post-with fallback (line 1972): only an unhandled event
  // reaches it, and for those event !== "Stop", so this resolves to null.
  let result: HookResult = agent === "codex" && event === "Stop" ? {} : null;
  lockedState(root, (state) => {
    ensureSession(root, agent, role, inputData);
    reapStaleActive(root, state, event, inputData, role);
    if (event === "SessionStart") {
      writeStatus(root, state, "idle", "session started");
      cmuxStatus("CCR idle", "#34C759");
      result = null;
      return;
    }
    if (event === "UserPromptSubmit") {
      handleUserPromptSubmit(root, state, inputData, agent, role);
      result = null;
      return;
    }
    if (event === "PreToolUse") {
      result = handlePreTool(root, state, inputData, agent, role);
      return;
    }
    if (event === "PostToolUse") {
      const active = state.active_request;
      if (isPlainObject(active) && active.reviewer === role) {
        result = null;
        return;
      }
      if (!shouldMarkDirtyForTool(inputData)) {
        cmuxLog("progress", `PostToolUse ignored (non-mutating): ${role}/${toolName(inputData)}`);
        result = null;
        return;
      }
      markDirty(root, inputData, agent, role);
      writeStatus(root, state, "dirty", `${role} changed files`);
      cmuxStatus("CCR dirty", "#FF9500");
      result = null;
      return;
    }
    if (event === "Stop") {
      if (String(getOrNull(inputData, "stop_hook_active") ?? "false").toLowerCase() === "true") {
        result = agent === "codex" ? {} : null;
        return;
      }
      const finishedReview = finishReview(root, state, inputData, role);
      if (finishedReview) {
        cmuxLog("progress", "Stop: skipped start_review (reviewer just finalized a reply)");
      } else {
        startReview(root, state, inputData, role);
      }
      result = agent === "codex" ? {} : null;
      return;
    }
  });
  return result;
}

/**
 * Python `ensure_info_exclude` (1975-1991): append `.cmux/ccr/` to the repo's
 * .git/info/exclude (idempotent) so CCR runtime state is never offered to git.
 */
export function ensureInfoExclude(cwd: string): void {
  if (!insideGit(cwd)) {
    return;
  }
  const [code, gitDir] = git(cwd, ["rev-parse", "--git-dir"]);
  if (code !== 0) {
    return;
  }
  let path = strip(gitDir);
  if (!isAbsolute(path)) {
    path = join(cwd, path);
  }
  const exclude = join(path, "info", "exclude");
  mkdirSync(join(path, "info"), { recursive: true });
  const existing = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
  if (!existing.includes(".cmux/ccr/")) {
    let prefix = "";
    if (existing && !existing.endsWith("\n")) {
      prefix = "\n";
    }
    appendFileSync(exclude, `${prefix}\n# Added by claude-codex-review\n.cmux/ccr/\n`, "utf-8");
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
