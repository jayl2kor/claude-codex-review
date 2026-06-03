/**
 * enable.ts — `ccr-enable`. Faithful port of ccr-hook.py command_enable
 * (1994-2017): add this workspace to ENABLED_FILE, create the CCR root, exclude
 * it from git, and seed idle state.
 */
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";

import { rootForCwd, CONFIG_ROOT, ENABLED_FILE, workspaceId } from "../lib/paths";
import { lockedState, writeStatus } from "../lib/lock";
import { cmuxStatus } from "../lib/cmux";
import { ensureInfoExclude } from "../lib/hooks";
import { splitlines } from "../lib/pycompat";
import { out } from "./shared";

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function commandEnable(): number {
  const wid = workspaceId();
  if (!wid) {
    out("cmux workspace 안에서 실행해야 합니다.");
    return 1;
  }
  mkdirSync(CONFIG_ROOT, { recursive: true });
  if (!existsSync(ENABLED_FILE)) {
    writeFileSync(ENABLED_FILE, "", "utf-8");
  }
  const lines = splitlines(readFileSync(ENABLED_FILE, "utf-8"));
  if (!lines.includes(wid)) {
    appendFileSync(ENABLED_FILE, wid + "\n", "utf-8");
  }
  const cwd = process.cwd();
  const root = rootForCwd(cwd);
  mkdirSync(root, { recursive: true });
  ensureInfoExclude(cwd);
  lockedState(root, (state) => {
    if (!hasOwn(state, "version")) {
      state.version = 1;
    }
    if (!hasOwn(state, "review_count")) {
      state.review_count = 0;
    }
    state.active_request = null;
    writeStatus(root, state, "idle", "enabled");
  });
  cmuxStatus("CCR enabled", "#34C759");
  out(`자동 리뷰를 활성화했습니다: ${wid}`);
  out(`CCR root: ${root}`);
  return 0;
}
