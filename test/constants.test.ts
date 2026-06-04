import { test, expect } from "bun:test";
import { pyInt, CCR_DEFAULTS } from "../src/lib/constants.ts";

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

test("CCR_DEFAULTS pins the documented numeric env defaults", () => {
  // These were locked against the (now-removed) Python runtime during the
  // migration; they are the contract the docs/installer advertise, so pin them
  // directly. Changing a default is a deliberate act that must update this test.
  expect(CCR_DEFAULTS.CCR_MAX_ROUNDS).toBe("3");
  expect(CCR_DEFAULTS.CCR_MAX_UNTRACKED_BYTES).toBe("200000");
  expect(CCR_DEFAULTS.CCR_MAX_DIFF_BYTES).toBe("300000");
  expect(CCR_DEFAULTS.CCR_MIN_DIFF_LINES).toBe("0");
  expect(CCR_DEFAULTS.CCR_STALE_ACTIVE_SECONDS).toBe("1800");
  expect(CCR_DEFAULTS.CCR_PROMPT_GATE).toBe("on");
});
