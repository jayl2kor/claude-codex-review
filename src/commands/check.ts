/**
 * check.ts — `ccr-check`. Faithful port of ccr-hook.py _check_doc (2736-2784) +
 * command_check (2787-2810): a one-shot rollup of selftest + doctor + ready +
 * preview + config, with deduped next-actions. Exit 0 only when overall == pass.
 */
import { rootForCwd } from "../lib/paths";
import type { CcrArgs } from "../lib/args";
import { doctorDoc } from "./doctor";
import { selftestDoc } from "./selftest";
import { readyChecks } from "./ready";
import { previewData } from "./preview";
import { configDoc } from "./config";
import { out, g } from "./shared";

function checkDoc(cwd: string): Record<string, unknown> {
  const root = rootForCwd(cwd);
  const doctor = doctorDoc(cwd);
  const selftest = selftestDoc();
  const readyCheckList = readyChecks(cwd, root);
  const ready = readyCheckList.every((c) => Boolean(c.ok));
  const readyActions: string[] = [];
  const readySeen = new Set<string>();
  for (const check of readyCheckList) {
    const action = String(check.action || "");
    if (action && !readySeen.has(action)) {
      readySeen.add(action);
      readyActions.push(action);
    }
  }
  const preview = previewData(cwd, root);
  const config = configDoc(cwd);

  const actions: string[] = [];
  const seenActions = new Set<string>();
  const addAction = (action: string): void => {
    if (action && !seenActions.has(action)) {
      seenActions.add(action);
      actions.push(action);
    }
  };
  if (selftest.code) {
    addAction("Run `ccr-selftest` for failed runtime smoke-test details.");
  }
  for (const action of (doctor.doc.actions as string[]) || []) {
    addAction(String(action));
  }
  if (!ready) {
    for (const action of readyActions) {
      addAction(action);
    }
  }
  if (!preview.eligible) {
    addAction("Run `ccr-preview` to inspect current diff review blockers.");
  }

  const env = config.environment as Record<string, Record<string, string>>;
  const envOverrides = Object.keys(env).filter((k) => env[k]!.source === "env");

  return {
    version: 1,
    cwd,
    ccr_root: root,
    overall: selftest.code === 0 && doctor.code === 0 && ready ? "pass" : "attention",
    selftest: { exit_code: selftest.code, passed: selftest.doc.passed, failed: selftest.doc.failed },
    doctor: { exit_code: doctor.code, summary: doctor.doc.summary },
    ready: { ready, failed: readyCheckList.filter((c) => !c.ok).length },
    preview: { eligible: preview.eligible, blockers: preview.blockers, changed_lines: preview.changed_lines },
    config: { env_overrides: envOverrides },
    actions,
  };
}

export function commandCheck(jsonOutput: boolean): number {
  const doc = checkDoc(process.cwd());
  if (jsonOutput) {
    out(JSON.stringify(doc, null, 2));
    return doc.overall === "pass" ? 0 : 1;
  }
  const selftest = doc.selftest as Record<string, unknown>;
  const doctor = doc.doctor as Record<string, unknown>;
  const ready = doc.ready as Record<string, unknown>;
  const preview = doc.preview as Record<string, unknown>;
  const config = doc.config as { env_overrides: string[] };
  out("CCR Check");
  out(`Overall: ${doc.overall}`);
  out(`CCR root: ${doc.ccr_root}`);
  out();
  out(`Selftest: ${selftest.passed} passed, ${selftest.failed} failed`);
  const summary = doctor.summary as Record<string, unknown>;
  out(`Doctor: ${g(summary, "fail", 0)} fail, ${g(summary, "warn", 0)} warn, ${g(summary, "ok", 0)} ok`);
  out(`Ready: ${ready.ready ? "yes" : "no"} (${ready.failed} blocker(s))`);
  out(`Preview: ${preview.eligible ? "eligible" : "not eligible"} (${preview.changed_lines} changed lines)`);
  if (config.env_overrides.length > 0) {
    out(`Env overrides: ${config.env_overrides.join(", ")}`);
  } else {
    out("Env overrides: none");
  }
  const actions = doc.actions as string[];
  if (actions.length > 0) {
    out();
    out("Next actions:");
    actions.forEach((action, i) => {
      out(`${i + 1}. ${action}`);
    });
  }
  return doc.overall === "pass" ? 0 : 1;
}
