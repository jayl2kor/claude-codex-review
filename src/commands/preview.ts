/**
 * preview.ts — `ccr-preview`. Faithful port of ccr-hook.py _preview_data
 * (2455-2499) + command_preview (2502-2531): report whether an automatic review
 * would fire now, with blockers/notes. Exit 0 when eligible, else 1.
 */
import { join } from "node:path";
import { statSync } from "node:fs";

import { loadJson } from "../lib/io";
import { defaultState } from "../lib/misc";
import { collectDiff, insideGit } from "../lib/git";
import { rootForCwd, skipMarkerPath } from "../lib/paths";
import { workspaceEnabled, surfaceForRole } from "../lib/cmux";
import { MIN_DIFF_LINES, MAX_DIFF_BYTES } from "../lib/constants";
import { utf8ByteLength } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out, g, isPlainObject } from "./shared";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

interface PreviewData {
  version: number;
  cwd: string;
  ccr_root: string;
  eligible: boolean;
  head: string;
  diff_hash: string;
  changed_lines: number;
  files_touched: string[];
  diff_payload_bytes: number;
  max_diff_bytes: number;
  min_diff_lines: number;
  active_request: Record<string, unknown> | null;
  skip_next: string;
  blockers: string[];
  notes: string[];
}

export function previewData(cwd: string, root: string): PreviewData {
  let state = loadJson<unknown>(join(root, "state.json"), defaultState());
  if (!isPlainObject(state)) {
    state = defaultState();
  }
  const s = state as Record<string, unknown>;
  const inGit = insideGit(cwd);
  const [diffText, diffHash, head, hasContent, changedLines, filesTouched] = collectDiff(cwd, inGit);
  const active = s.active_request;
  const skipPath = skipMarkerPath(root);

  const blockers: string[] = [];
  const notes: string[] = [];
  if (!inGit) {
    blockers.push("current directory is not inside a git worktree");
  }
  if (!hasContent) {
    blockers.push("no reviewable git diff detected");
  }
  if (isPlainObject(active)) {
    blockers.push(`review already active: round ${g(active, "round", "?")} ${g(active, "worker", "?")}->${g(active, "reviewer", "?")}`);
  }
  if (MIN_DIFF_LINES > 0 && changedLines < MIN_DIFF_LINES) {
    blockers.push(`diff has ${changedLines} changed lines (< CCR_MIN_DIFF_LINES=${MIN_DIFF_LINES})`);
  }
  if (diffHash && diffHash === s.last_diff_hash) {
    blockers.push("current diff hash matches the last reviewed diff");
  }
  if (isFile(skipPath)) {
    blockers.push("ccr-skip-next marker is pending; the next eligible automatic review will be skipped");
  }
  if (!workspaceEnabled()) {
    notes.push("workspace is not enabled; run ccr-enable before relying on automatic review");
  }
  if (!surfaceForRole("claude") || !surfaceForRole("codex")) {
    notes.push("both Claude and Codex surfaces should be registered for automatic handoff");
  }

  const eligible = hasContent && blockers.length === 0;
  return {
    version: 1,
    cwd,
    ccr_root: root,
    eligible,
    head: head || "unknown",
    diff_hash: diffHash,
    changed_lines: changedLines,
    files_touched: filesTouched,
    diff_payload_bytes: utf8ByteLength(diffText),
    max_diff_bytes: MAX_DIFF_BYTES,
    min_diff_lines: MIN_DIFF_LINES,
    active_request: isPlainObject(active) ? active : null,
    skip_next: isFile(skipPath) ? skipPath : "",
    blockers,
    notes,
  };
}

export function commandPreview(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const data = previewData(cwd, root);
  if (args.json_output) {
    out(JSON.stringify(data, null, 2));
    return data.eligible ? 0 : 1;
  }
  out("CCR Review Preview");
  out(`Cwd: ${cwd}`);
  out(`CCR root: ${root}`);
  out(`Git HEAD: ${data.head}`);
  out(`Changed lines: ${data.changed_lines}`);
  out(`Files touched: ${data.files_touched.length}`);
  for (const fname of data.files_touched.slice(0, 20)) {
    out(`  - ${fname}`);
  }
  if (data.files_touched.length > 20) {
    out(`  ... ${data.files_touched.length - 20} more`);
  }
  out(`Diff payload bytes: ${data.diff_payload_bytes} (limit ${data.max_diff_bytes})`);
  out();
  out(`Would auto-review now: ${data.eligible ? "yes" : "no"}`);
  if (data.blockers.length > 0) {
    out("Blockers:");
    for (const blocker of data.blockers) {
      out(`- ${blocker}`);
    }
  }
  if (data.notes.length > 0) {
    out("Notes:");
    for (const note of data.notes) {
      out(`- ${note}`);
    }
  }
  return data.eligible ? 0 : 1;
}
