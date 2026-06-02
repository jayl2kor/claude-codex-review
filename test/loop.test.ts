import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Integration guard for the CCR hook loop. The heavy lifting lives in the
// Python harness (test/integration_loop.py), which drives the real
// handle_hook dispatcher end-to-end against a temp HOME/cwd with only the
// surface/diff boundary stubbed. This wrapper keeps it in the `bun test` gate.
//
// It is a regression guard for the reviewer-handoff reaper bug: if
// reap_stale_active ever discards active_request on a reviewer-side or
// worker-side UserPromptSubmit again, the harness's first scenario fails.
test("CCR hook loop: worker <-> reviewer handoff survives prompt events", () => {
  const harness = join(import.meta.dir, "integration_loop.py");
  const res = spawnSync("python3", [harness], { encoding: "utf-8" });
  if (res.status !== 0) {
    // Surface the harness output so failures are actionable in CI logs.
    throw new Error(
      `integration_loop.py failed (exit ${res.status})\n` +
        `STDOUT:\n${res.stdout ?? ""}\nSTDERR:\n${res.stderr ?? ""}`,
    );
  }
  // Count-agnostic: assert the harness reported zero failures regardless of how
  // many scenarios it runs, so adding scenarios never silently breaks this gate.
  const summary = res.stdout.match(/(\d+) passed, (\d+) failed/);
  expect(summary).not.toBeNull();
  expect(Number(summary![1])).toBeGreaterThan(0);
  expect(Number(summary![2])).toBe(0);
});
