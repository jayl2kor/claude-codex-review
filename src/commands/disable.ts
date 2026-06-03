/**
 * disable.ts — `ccr-disable`. Faithful port of ccr-hook.py command_disable
 * (2020-2035): remove this workspace from ENABLED_FILE and mark state disabled.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { rootForCwd, ENABLED_FILE, workspaceId } from "../lib/paths";
import { lockedState, writeStatus } from "../lib/lock";
import { cmuxStatus } from "../lib/cmux";
import { splitlines } from "../lib/pycompat";
import { out } from "./shared";

export function commandDisable(): number {
  const wid = workspaceId();
  if (!wid) {
    out("cmux workspace 안에서 실행해야 합니다.");
    return 1;
  }
  if (existsSync(ENABLED_FILE)) {
    const lines = splitlines(readFileSync(ENABLED_FILE, "utf-8")).filter((line) => line !== wid);
    writeFileSync(ENABLED_FILE, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  }
  const root = rootForCwd(process.cwd());
  if (existsSync(root)) {
    lockedState(root, (state) => {
      state.active_request = null;
      writeStatus(root, state, "disabled", "workspace disabled");
    });
  }
  cmuxStatus("CCR disabled", "#8E8E93");
  out(`자동 리뷰를 비활성화했습니다: ${wid}`);
  return 0;
}
