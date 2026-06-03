/**
 * reset.ts — `ccr-reset`. Faithful port of ccr-hook.py command_reset
 * (2038-2049): wipe the CCR root and re-seed default idle state.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { rootForCwd } from "../lib/paths";
import { lockedState, writeStatus } from "../lib/lock";
import { cmuxStatus } from "../lib/cmux";
import { defaultState } from "../lib/misc";
import { out } from "./shared";

export function commandReset(): number {
  const root = rootForCwd(process.cwd());
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  lockedState(root, (state) => {
    for (const k of Object.keys(state)) {
      delete state[k];
    }
    Object.assign(state, defaultState());
    writeStatus(root, state, "idle", "reset");
  });
  cmuxStatus("CCR reset", "#8E8E93");
  out(`CCR state reset: ${root}`);
  return 0;
}
