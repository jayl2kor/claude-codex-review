/**
 * args.test.ts — CLI arg parsing fidelity, focused on two argparse-divergence
 * fixes:
 *   1. takeValue() must not silently swallow an option-like next token as a
 *      value (argparse reports a missing argument instead).
 *   2. parseInt10 must accept Python int()'s inter-digit underscores.
 */
import { test, expect } from "bun:test";
import { parseArgs, ArgError } from "../src/lib/args.ts";

test("value flags reject an option-like next token (argparse parity)", () => {
  expect(() => parseArgs(["--title", "--use-diff"])).toThrow(ArgError);
  expect(() => parseArgs(["--type", "--json"])).toThrow(ArgError);
  expect(() => parseArgs(["--title"])).toThrow(ArgError); // missing value
});

test("value flags still accept '-', negative numbers, and normal values", () => {
  expect(parseArgs(["--title", "-"]).title).toBe("-"); // lone dash is a value
  expect(parseArgs(["--limit", "-5"]).limit).toBe(-5); // negative number value
  expect(parseArgs(["--title", "hello"]).title).toBe("hello");
  expect(parseArgs(["--title=--weird"]).title).toBe("--weird"); // inline = is literal
});

test("parseInt10 accepts Python-style underscore separators", () => {
  expect(parseArgs(["--limit", "1_000"]).limit).toBe(1000);
  expect(parseArgs(["--limit", "100"]).limit).toBe(100);
});

test("parseInt10 rejects malformed underscores / non-ints", () => {
  for (const bad of ["_1", "1_", "1__0", "abc", "1.5"]) {
    expect(() => parseArgs(["--limit", bad])).toThrow(ArgError);
  }
});
