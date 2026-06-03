/**
 * skipNext.ts — `ccr-skip-next`. Faithful port of ccr-hook.py command_skip_next
 * (2406-2423): drop a skip-next marker so the next eligible automatic review is
 * skipped once.
 */
import { mkdirSync } from "node:fs";

import { writeJson, now } from "../lib/io";
import { rootForCwd, skipMarkerPath, workspaceId, surfaceId } from "../lib/paths";
import { cmuxStatus, cmuxLog } from "../lib/cmux";
import { out, err } from "./shared";

export function commandSkipNext(): number {
  const wid = workspaceId();
  if (!wid) {
    err("cmux workspace 안에서 실행해야 합니다.");
    return 1;
  }
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  mkdirSync(root, { recursive: true });
  const path = skipMarkerPath(root);
  writeJson(path, {
    at: now(),
    by_surface: surfaceId(),
    cwd,
  });
  cmuxStatus("CCR skip pending", "#8E8E93");
  cmuxLog("progress", "skip-next marker set");
  out(`다음 자동 리뷰 1회를 건너뜁니다. marker: ${path}`);
  return 0;
}
