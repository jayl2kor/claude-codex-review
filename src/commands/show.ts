/**
 * show.ts — `ccr-show`. Faithful port of ccr-hook.py command_show (2351-2403):
 * print (or dump --review of) a specific session/round's artifacts.
 */
import { join, basename } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

import { loadJson } from "../lib/io";
import { rootForCwd, sessionDir } from "../lib/paths";
import { latestSessionId } from "../lib/report";
import { cpCompare } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out, err, g, isPlainObject } from "./shared";

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

export function commandShow(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const sessionsDir = join(root, "sessions");
  if (!isDir(sessionsDir)) {
    err("No sessions yet.");
    return 1;
  }
  let sdir: string;
  if (args.session) {
    sdir = sessionDir(root, args.session);
    if (!isDir(sdir)) {
      err(`Session not found: ${args.session}`);
      return 1;
    }
  } else {
    const sid = latestSessionId(root);
    if (sid === null) {
      err("No sessions with rounds.");
      return 1;
    }
    sdir = join(sessionsDir, sid);
  }
  const roundsDir = join(sdir, "rounds");
  let roundNames: string[] = [];
  try {
    roundNames = readdirSync(roundsDir).filter((n) => isDir(join(roundsDir, n)));
  } catch {
    roundNames = [];
  }
  roundNames.sort(cpCompare);
  if (roundNames.length === 0) {
    err(`No rounds in ${sdir}.`);
    return 1;
  }
  let rdir: string;
  if (args.round) {
    rdir = join(roundsDir, pad4(Math.trunc(args.round)));
    if (!isDir(rdir)) {
      err(`Round ${args.round} not found in ${sdir}.`);
      return 1;
    }
  } else {
    rdir = join(roundsDir, roundNames[roundNames.length - 1]!);
  }
  const reviewPath = join(rdir, "review.md");
  const requestPath = join(rdir, "request.md");
  const diffPath = join(rdir, "diff.patch");
  const deltaPath = join(rdir, "delta.patch");
  const decisionPath = join(rdir, "decision.json");
  if (args.review) {
    if (!isFile(reviewPath)) {
      err(`No review.md in ${rdir}.`);
      return 1;
    }
    process.stdout.write(readFileSync(reviewPath, "utf-8"));
    return 0;
  }
  out(`Session: ${basename(sdir)}`);
  out(`Round dir: ${rdir}`);
  out(`Request: ${isFile(requestPath) ? requestPath : "-"}`);
  out(`Diff: ${isFile(diffPath) ? diffPath : "-"}`);
  if (isFile(deltaPath)) {
    out(`Delta: ${deltaPath}`);
  }
  out(`Review: ${isFile(reviewPath) ? reviewPath : "-"}`);
  if (isFile(decisionPath)) {
    const d = loadJson<Record<string, unknown>>(decisionPath, {});
    if (isPlainObject(d)) {
      out(`Decision: ${g(d, "decision", "-")} (round ${g(d, "round", "?")}) @ ${g(d, "updated_at", "-")}`);
    }
  }
  return 0;
}
