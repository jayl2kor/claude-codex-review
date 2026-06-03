/**
 * events.ts — `ccr-events`. Faithful port of ccr-hook.py _read_events
 * (2290-2313) + command_events (2316-2348): tail the events.jsonl log, as a
 * table or (with --json) a JSON document.
 */
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";

import { rootForCwd } from "../lib/paths";
import { splitlines, ljust } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out, g, isPlainObject } from "./shared";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readEvents(root: string, limit: number): Record<string, unknown>[] {
  const eventsPath = join(root, "events.jsonl");
  if (!isFile(eventsPath)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(eventsPath, "utf-8");
  } catch {
    return [];
  }
  let lines = splitlines(text);
  if (limit && limit > 0) {
    lines = lines.slice(-limit);
  }
  const events: Record<string, unknown>[] = [];
  for (const raw of lines) {
    if (!raw.trim()) {
      continue;
    }
    let ev: unknown;
    try {
      ev = JSON.parse(raw);
    } catch {
      events.push({ type: "invalid_json", raw });
      continue;
    }
    if (isPlainObject(ev)) {
      events.push(ev);
    } else {
      events.push({ type: "invalid_event", raw });
    }
  }
  return events;
}

const DETAIL_KEYS = ["agent", "role", "session_id", "reason", "decision", "round", "path", "outcome"];

export function commandEvents(args: CcrArgs): number {
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  const limit = args.limit && args.limit > 0 ? args.limit : 50;
  const events = readEvents(root, limit);
  if (args.json_output) {
    out(JSON.stringify({ version: 1, cwd, ccr_root: root, limit, events }, null, 2));
    return 0;
  }
  out("CCR Events");
  out(`CCR root: ${root}`);
  out(`Limit: ${limit}`);
  out();
  if (events.length === 0) {
    out("No events found.");
    return 0;
  }
  out(`${ljust("time", 22)} ${ljust("type", 18)} detail`);
  for (const ev of events) {
    const when = String(g(ev, "at", null) || "");
    const etype = String(g(ev, "type", null) || "");
    const detailParts: string[] = [];
    for (const key of DETAIL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(ev, key)) {
        const v = ev[key];
        if (v !== "" && v !== null && v !== undefined) {
          detailParts.push(`${key}=${v}`);
        }
      }
    }
    if (detailParts.length === 0 && Object.prototype.hasOwnProperty.call(ev, "raw")) {
      detailParts.push(`raw=${ev.raw}`);
    }
    out(`${ljust(when, 22)} ${ljust(etype, 18)} ${detailParts.join(" ")}`);
  }
  return 0;
}
