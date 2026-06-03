/**
 * report.ts — session-report FS helpers, Phase 4a of the Python->Bun migration
 * (ccr-hook.py). The full report GENERATOR (generate_session_report) is Phase 4b;
 * this module ports the small read-only helpers it builds on.
 *
 * Ported from ccr-hook.py: _latest_session_id (1232-1239),
 * _round_must_fix_count (1252-1256), _round_files_touched (1259-1273).
 *
 * Zero npm deps — node:fs / node:path + lib modules only.
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

import { countMustFixInText } from "./decision";
import { filesTouchedFromDiffText, countChangedLines } from "./diff";
import { loadJson, writeJson, appendJsonl, now } from "./io";
import { sessionDir } from "./paths";
import { formatDuration, fencedMarkdownBlock } from "./text";
import { cmuxLog, cmuxNotify } from "./cmux";
import { splitlines, cpCompare } from "./pycompat";

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

/**
 * Python `_latest_session_id` (1232-1239): the session dir (that has a rounds/
 * subdir) with the greatest mtime, or null. On a tie, the first-encountered
 * candidate is kept (matching Python's max()), so callers should rely on
 * distinct mtimes for a deterministic result.
 */
export function latestSessionId(root: string): string | null {
  const sessionsDir = join(root, "sessions");
  if (!isDir(sessionsDir)) {
    return null;
  }
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const name of names) {
    const d = join(sessionsDir, name);
    if (!isDir(d) || !isDir(join(d, "rounds"))) {
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(d).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtime > best.mtime) {
      best = { name, mtime };
    }
  }
  return best === null ? null : best.name;
}

/** Python `_round_must_fix_count` (1252-1256). */
export function roundMustFixCount(rdir: string): number {
  const reviewPath = join(rdir, "review.md");
  if (!isFile(reviewPath)) {
    return 0;
  }
  return countMustFixInText(readFileSync(reviewPath, "utf-8"));
}

/**
 * Python `_round_files_touched` (1259-1273): files named in a round's
 * diff.patch. Python returns a set; this returns a sorted array (the report
 * uses it order-independently). filesTouchedFromDiffText is the shared parser.
 */
export function roundFilesTouched(rdir: string): string[] {
  const diffPath = join(rdir, "diff.patch");
  if (!isFile(diffPath)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(diffPath, "utf-8");
  } catch {
    return [];
  }
  return filesTouchedFromDiffText(text);
}

// ---------------------------------------------------------------------------
// Phase 4b-2a: session report generator
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python dict.get(key, default): default only when the key is absent. */
function mget(obj: Record<string, unknown>, key: string, dflt: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

/** Parse our fixed "%Y-%m-%dT%H:%M:%SZ" UTC stamp to epoch seconds, or null. */
function epochSeconds(stamp: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(stamp)) {
    return null;
  }
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : Math.trunc(ms / 1000);
}

interface RoundDigest {
  round: number;
  at: string;
  decision: string;
  must_fix: number;
  review_path: string;
  request_path: string;
  diff_path: string;
  delta_path: string;
  worker: string;
  reviewer: string;
}

/**
 * Python `generate_session_report` (1276-1495): build report.md from the
 * session's round dirs + session.json + events.jsonl, update
 * status.json.last_report, and append a `report` event. Returns the report path
 * or null. Faithful byte-for-byte port (report.md via plain write, like Python's
 * write_text).
 */
export function generateSessionReport(
  root: string,
  sid: string,
  outcome: string,
  trigger: string = "auto",
): string | null {
  if (!sid) {
    sid = latestSessionId(root) || "";
  }
  if (!sid) {
    return null;
  }
  const sdir = sessionDir(root, sid);
  const roundsDir = join(sdir, "rounds");
  if (!isDir(sdir)) {
    return null;
  }
  let sessionMeta = loadJson<unknown>(join(sdir, "session.json"), {});
  if (!isPlainObject(sessionMeta)) {
    sessionMeta = {};
  }
  const meta = sessionMeta as Record<string, unknown>;

  const roundDirs: string[] = [];
  if (isDir(roundsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(roundsDir);
    } catch {
      names = [];
    }
    names.sort(cpCompare);
    for (const name of names) {
      const d = join(roundsDir, name);
      if (isDir(d)) {
        roundDirs.push(d);
      }
    }
  }

  const digests: RoundDigest[] = [];
  const filesAll = new Set<string>();
  let totalChangedLines = 0;
  for (const rdir of roundDirs) {
    let dec = (loadJson<Record<string, unknown>>(join(rdir, "decision.json"), {}) || {}) as unknown;
    if (!isPlainObject(dec)) {
      dec = {};
    }
    const d = dec as Record<string, unknown>;
    const name = basename(rdir);
    const nameDigit = /^\d+$/.test(name);
    let roundVal = 0;
    if (nameDigit) {
      roundVal = Math.trunc(Number(d.round || Number(name)));
    }
    const reviewPath = join(rdir, "review.md");
    const requestPath = join(rdir, "request.md");
    const diffPath = join(rdir, "diff.patch");
    const deltaPath = join(rdir, "delta.patch");
    digests.push({
      round: roundVal,
      at: String(d.updated_at || ""),
      decision: String(d.decision || "(none)"),
      must_fix: roundMustFixCount(rdir),
      review_path: isFile(reviewPath) ? reviewPath : "",
      request_path: isFile(requestPath) ? requestPath : "",
      diff_path: isFile(diffPath) ? diffPath : "",
      delta_path: isFile(deltaPath) ? deltaPath : "",
      worker: String(d.worker || ""),
      reviewer: String(d.reviewer || ""),
    });
    for (const f of roundFilesTouched(rdir)) {
      filesAll.add(f);
    }
    if (isFile(diffPath)) {
      try {
        totalChangedLines += countChangedLines(readFileSync(diffPath, "utf-8"));
      } catch {
        /* OSError -> skip */
      }
    }
  }

  const startedAt = String(mget(meta, "created_at", "") || (digests.length ? digests[0]!.at : ""));
  const endedAt = now();
  let duration = "-";
  if (startedAt) {
    const ts = epochSeconds(startedAt);
    const te = epochSeconds(endedAt);
    if (ts !== null && te !== null) {
      duration = formatDuration(te - ts);
    }
  }

  let skipCount = 0;
  let promptCount = 0;
  const interventions: Record<string, unknown>[] = [];
  const eventsPath = join(root, "events.jsonl");
  if (isFile(eventsPath)) {
    let text = "";
    try {
      text = readFileSync(eventsPath, "utf-8");
    } catch {
      text = "";
    }
    for (const raw of splitlines(text)) {
      if (!raw.trim()) {
        continue;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isPlainObject(ev)) {
        continue;
      }
      const evSid = ev.session_id;
      if (evSid && String(evSid) !== sid) {
        continue;
      }
      const etype = String(ev.type || "");
      if (etype === "skipped") {
        skipCount += 1;
        interventions.push(ev);
      } else if (etype === "user_prompt") {
        promptCount += 1;
        interventions.push(ev);
      }
    }
  }

  const last = digests.length ? digests[digests.length - 1]! : null;
  const workerRole = (last ? last.worker : "") || String(mget(meta, "role", "") || "");
  let reviewerRole = last ? last.reviewer : "";
  if (!reviewerRole && workerRole) {
    reviewerRole = workerRole === "claude" ? "codex" : workerRole === "codex" ? "claude" : "";
  }
  const roundsCount = digests.length;
  const lastDecision = last ? last.decision : "(none)";

  const summaryLines = [
    `Outcome: ${outcome} after ${roundsCount} round(s). Last decision: ${lastDecision}.`,
    `Worker: ${workerRole || "?"} -> Reviewer: ${reviewerRole || "?"}. Total changed lines across rounds: ${totalChangedLines}.`,
  ];
  if (skipCount || promptCount) {
    summaryLines.push(`Manual interventions: ${skipCount} skip(s), ${promptCount} user-prompt reset(s).`);
  }
  const summaryText = summaryLines.join("\n");

  const md: string[] = [
    "# CCR Session Report",
    "",
    "## Summary",
    "",
    summaryText,
    "",
    "## Metadata",
    "",
    "| Key | Value |",
    "|---|---|",
    `| session_id | \`${sid}\` |`,
    `| workspace_id | \`${mget(meta, "workspace_id", "-")}\` |`,
    `| cwd | \`${mget(meta, "cwd", "-")}\` |`,
    `| worker | ${workerRole || "-"} |`,
    `| reviewer | ${reviewerRole || "-"} |`,
    `| started_at | ${startedAt || "-"} |`,
    `| ended_at | ${endedAt} |`,
    `| duration | ${duration} |`,
    `| outcome | **${outcome}** |`,
    `| total_rounds | ${roundsCount} |`,
    `| manual_skips | ${skipCount} |`,
    `| user_prompt_resets | ${promptCount} |`,
    `| trigger | ${trigger} |`,
    "",
    "## Rounds",
    "",
    "| round | time | decision | must-fix | delta? | review |",
    "|---:|---|---|---:|:---:|---|",
  ];
  for (const d of digests) {
    const deltaMark = d.delta_path ? "✓" : "";
    md.push(`| ${d.round} | ${d.at} | ${d.decision} | ${d.must_fix} | ${deltaMark} | \`${d.review_path || "-"}\` |`);
  }
  if (digests.length === 0) {
    md.push("| – | – | – | – | – | – |");
  }
  md.push("");
  md.push("## Files Touched");
  md.push("");
  if (filesAll.size > 0) {
    for (const fname of [...filesAll].sort(cpCompare)) {
      md.push(`- \`${fname}\``);
    }
  } else {
    md.push("(none detected from diff.patch headers)");
  }
  md.push("");
  md.push("Note: paths derived from per-round diff.patch headers; may not match the current working tree.");
  md.push("");

  if (digests.length > 0) {
    md.push("## Round details");
    md.push("");
    for (const d of digests) {
      md.push(`### Round ${d.round} - ${d.decision}`);
      md.push("");
      md.push(`- request: \`${d.request_path || "-"}\``);
      md.push(`- diff: \`${d.diff_path || "-"}\``);
      if (d.delta_path) {
        md.push(`- delta: \`${d.delta_path}\``);
      }
      md.push(`- review: \`${d.review_path || "-"}\``);
      md.push("");
      let reviewText = "";
      if (d.review_path) {
        try {
          reviewText = readFileSync(d.review_path, "utf-8");
        } catch {
          reviewText = "";
        }
      }
      if (reviewText.trim()) {
        const [open, body, close] = fencedMarkdownBlock(reviewText, "markdown");
        md.push("<details><summary>review.md</summary>");
        md.push("");
        md.push(open);
        md.push(body);
        md.push(close);
        md.push("");
        md.push("</details>");
        md.push("");
      }
    }
  }

  md.push("## Manual interventions");
  md.push("");
  if (interventions.length > 0) {
    for (const ev of interventions) {
      md.push(`- ${mget(ev, "at", "?")} \`${mget(ev, "type", "?")}\` reason=\`${mget(ev, "reason", "-")}\``);
    }
  } else {
    md.push("(none)");
  }
  md.push("");

  const reportPath = join(sdir, "report.md");
  writeFileSync(reportPath, md.join("\n"), "utf-8");

  const statusPath = join(root, "status.json");
  let statusData = loadJson<unknown>(statusPath, {});
  if (!isPlainObject(statusData)) {
    statusData = {};
  }
  (statusData as Record<string, unknown>).last_report = {
    path: reportPath,
    outcome,
    at: endedAt,
    summary: summaryText,
  };
  writeJson(statusPath, statusData);

  const level = outcome === "passed" || outcome === "cancelled" ? "success" : "warning";
  cmuxLog(level, `report (${outcome}): ${summaryLines[0]}`);
  cmuxNotify(`CCR ${outcome}`, `${summaryLines[0]}\n${reportPath}`);
  appendJsonl(join(root, "events.jsonl"), {
    at: endedAt,
    type: "report",
    outcome,
    trigger,
    path: reportPath,
    session_id: sid,
  });
  return reportPath;
}

/** Python `_try_generate_report` (1498-1502): swallow + log report errors. */
export function tryGenerateReport(
  root: string,
  sid: string | null,
  outcome: string,
  trigger: string = "auto",
): void {
  try {
    generateSessionReport(root, sid || "", outcome, trigger);
  } catch (exc) {
    cmuxLog("warning", `report generation failed (${outcome}): ${String(exc)}`);
  }
}
