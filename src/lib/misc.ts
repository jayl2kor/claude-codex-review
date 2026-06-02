/**
 * misc.ts — pure (no I/O, no subprocess, deterministic) helpers ported from
 * the Python CCR runtime (templates/bin/ccr-hook.py) for the Python->Bun
 * migration.
 *
 * Each function mirrors the referenced Python function byte-for-byte so the
 * differential test can compare TS output against the Python oracle. See the
 * Python line ranges in each docstring.
 *
 * Zero dependencies beyond the already-validated foundation modules.
 */

// ---------------------------------------------------------------------------
// default_state (ccr-hook.py 739-746)
// ---------------------------------------------------------------------------

/** Default persisted state object. Mirrors Python `default_state()`. */
export function defaultState(): {
  version: number;
  review_count: number;
  last_diff_hash: string;
  active_request: null;
  last_completed: null;
} {
  return {
    version: 1,
    review_count: 0,
    last_diff_hash: "",
    active_request: null,
    last_completed: null,
  };
}

// ---------------------------------------------------------------------------
// reviewer_block_response (ccr-hook.py 1814-1823)
// ---------------------------------------------------------------------------

/**
 * Build the hook response that blocks a reviewer action.
 *
 * Mirrors Python `reviewer_block_response(agent, reason)`:
 *   - agent == "codex" → Codex PreToolUse deny shape.
 *   - otherwise        → {"decision": "block", "reason": reason}.
 */
export function reviewerBlockResponse(
  agent: string,
  reason: string,
):
  | {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    }
  | { decision: string; reason: string } {
  if (agent === "codex") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
  return { decision: "block", reason };
}

// ---------------------------------------------------------------------------
// _doctor_next_message (ccr-hook.py 2777-2782)
// ---------------------------------------------------------------------------

/** Next-step message for `ccr-doctor`. Mirrors Python `_doctor_next_message`. */
export function doctorNextMessage(failCount: number, warnCount: number): string {
  if (failCount) {
    return "rerun `bash ccr.sh`, then run `ccr-doctor` again.";
  }
  if (warnCount) {
    return "resolve warnings that match your intended workflow; many are expected outside cmux or before ccr-enable.";
  }
  return "run `ccr-status` or start work normally.";
}

// ---------------------------------------------------------------------------
// _doctor_action_items (ccr-hook.py 2785-2829)
// ---------------------------------------------------------------------------

/**
 * Derive the ordered, de-duplicated list of action items from doctor rows.
 *
 * Mirrors Python `_doctor_action_items(rows)`:
 *   - Skips rows whose status == "ok".
 *   - De-dups by exact action string, preserving first-seen insertion order.
 *   - Falls back to the "start work normally" hint when nothing was added.
 */
export function doctorActionItems(
  rows: Array<{ status?: string; name?: string; detail?: string }>,
): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();

  const add = (action: string): void => {
    if (!seen.has(action)) {
      seen.add(action);
      actions.push(action);
    }
  };

  for (const row of rows) {
    const status = row.status ?? "";
    if (status === "ok") {
      continue;
    }
    const name = row.name ?? "";
    const detail = row.detail ?? "";
    if (name.startsWith("command: ")) {
      // Python: name.split(": ", 1)[1] — split on first ": " keeping the
      // remainder intact (maxsplit=1).
      const idx = name.indexOf(": ");
      const cmd = name.slice(idx + 2);
      add(`Install or expose \`${cmd}\` in PATH, then rerun \`ccr-doctor\`.`);
    } else if (name === "PATH") {
      add("Run `source ~/.zshrc` or open a new shell so `~/.local/bin` is on PATH.");
    } else if (
      name === "installed command files" ||
      name === "Claude hooks" ||
      name === "Codex hooks"
    ) {
      add("Run `bash ccr.sh` from the CCR repository to reinstall generated commands and hooks.");
    } else if (name === "cmux surface") {
      add("Open the target project in cmux and run CCR commands inside a cmux surface.");
    } else if (name === "registered current surface") {
      add("Run `cmux-setup-claude` in the Claude surface or `cmux-setup-codex` in the Codex surface.");
    } else if (name === "registered Claude surface") {
      add("Run `cmux-setup-claude` in the Claude terminal surface.");
    } else if (name === "registered Codex surface") {
      add("Run `cmux-setup-codex` in the Codex terminal surface.");
    } else if (name === "workspace enabled") {
      add("Run `ccr-enable` from the target repository directory.");
    } else if (name === "git repository") {
      add("Change directory to the target git repository before running CCR commands.");
    } else if (name === "CCR runtime root") {
      add("Run `ccr-enable` from the target repository directory to create local CCR state.");
    } else if (name === "active request") {
      add("Run `ccr-status`; if the request is stale, run `ccr-cancel`.");
    } else if (name === "skip-next marker") {
      add(
        `The next eligible automatic review will be skipped; delete \`${detail}\` only if this was accidental.`,
      );
    } else {
      add(`Inspect \`${name}\`: ${detail}`);
    }
  }
  if (actions.length === 0) {
    actions.push("Run `ccr-status` or start work normally.");
  }
  return actions;
}
