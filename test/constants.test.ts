import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pyInt, CCR_DEFAULTS } from "../src/lib/constants.ts";

// Numeric env defaults that must stay equal between the TS port and the Python
// runtime. CCR_ROOT is a per-cwd path placeholder, not a numeric default, so it
// is excluded from strict parity.
const NUMERIC_DEFAULT_KEYS = [
  "CCR_MAX_ROUNDS",
  "CCR_MAX_UNTRACKED_BYTES",
  "CCR_MAX_DIFF_BYTES",
  "CCR_MIN_DIFF_LINES",
  "CCR_STALE_ACTIVE_SECONDS",
];

test("pyInt enforces Python int() strictness (full-string integer)", () => {
  expect(pyInt("42", "x")).toBe(42);
  expect(pyInt("  -7 ", "x")).toBe(-7); // surrounding whitespace ok, like int()
  expect(pyInt("+5", "x")).toBe(5);
  expect(pyInt("1800", "x")).toBe(1800);
  // All of these raise in Python's int(); Number.parseInt would NOT.
  for (const bad of ["123abc", "", "1.0", "0x10", "- 5", "abc", "1e3", "  "]) {
    expect(() => pyInt(bad, "x")).toThrow();
  }
  // Intentional, documented divergence: underscore-separated literals like
  // "1_000" are valid in Python int() but rejected here. Env values never use
  // them, and rejecting is the safe direction (no silent misparse).
  expect(() => pyInt("1_000", "x")).toThrow();
});

test("CCR_DEFAULTS numeric defaults match the Python runtime config", () => {
  const hook = join(import.meta.dir, "..", "templates", "bin", "ccr-hook.py");
  const res = spawnSync("python3", [hook, "--command", "config", "--json"], {
    encoding: "utf-8",
  });
  expect(res.status).toBe(0);
  const env = JSON.parse(res.stdout).environment ?? {};
  for (const key of NUMERIC_DEFAULT_KEYS) {
    expect(env[key]?.default).toBe(CCR_DEFAULTS[key]);
  }
  // Spot-check the value that diverged this round.
  expect(CCR_DEFAULTS.CCR_STALE_ACTIVE_SECONDS).toBe("1800");
});
