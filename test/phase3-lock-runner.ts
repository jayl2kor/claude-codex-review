/**
 * phase3-lock-runner.ts — a tiny CLI used by phase3.test.ts to exercise
 * src/lib/lock.ts `lockedState` from SEPARATE processes, which is the only way
 * to test cross-process mutual exclusion / stale-lock reclaim for real.
 *
 * Usage: bun test/phase3-lock-runner.ts <root> <mode>
 *   incr  — increment state.counter inside the critical section (with a small
 *           sleep to widen the window and expose lost-update races)
 *   block — enter lockedState and set a flag; used to assert it BLOCKS behind a
 *           live holder (the parent kills this via spawn timeout)
 */
import { lockedState } from "../src/lib/lock.ts";

const root = process.argv[2]!;
const mode = process.argv[3] ?? "incr";

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

lockedState(root, (s) => {
  if (mode === "incr") {
    const c = typeof s.counter === "number" ? (s.counter as number) : 0;
    // Widen the critical section so any mutual-exclusion break loses an update.
    sleepSync(40);
    s.counter = c + 1;
  } else {
    s.touched = true;
  }
});
