/**
 * report.ts — `ccr-report`. Faithful port of ccr-hook.py command_report
 * (2426-2452): (re)generate a session report and print its path (+ body with
 * --print).
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { loadJson } from "../lib/io";
import { rootForCwd } from "../lib/paths";
import { generateSessionReport, latestSessionId } from "../lib/report";
import type { CcrArgs } from "../lib/args";
import { out, err, g, isPlainObject } from "./shared";

export function commandReport(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const sid = args.session || latestSessionId(root) || "";
  if (!sid) {
    err("No CCR sessions found for this cwd.");
    return 1;
  }
  const statusDoc = loadJson<Record<string, unknown>>(join(root, "status.json"), {});
  let outcome = args.outcome;
  if (!outcome) {
    outcome = isPlainObject(statusDoc) ? String(g(statusDoc, "status", null) || "manual") : "manual";
  }
  const reportPath = generateSessionReport(root, sid, outcome, "manual");
  if (reportPath === null) {
    err(`Failed to generate report for session: ${sid}`);
    return 1;
  }
  out(reportPath);
  if (args.print_body) {
    try {
      process.stdout.write("\n");
      process.stdout.write(readFileSync(reportPath, "utf-8"));
    } catch (exc) {
      err(`Failed to read report: ${String(exc)}`);
      return 1;
    }
  }
  return 0;
}
