/**
 * cli-bin.test.ts — the npm package entrypoint (`bin/ccr`).
 *
 * Verifies the single `bin` declared in package.json exists and is runnable, and
 * that the launcher dispatches: `help` prints usage, an unknown subcommand is
 * rejected by the CLI arg parser (exit 2), and a known read-only command is
 * forwarded with its flags intact (`config --json` → valid JSON, exit 0).
 *
 * `install` is intentionally NOT executed here (it mutates HOME).
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const BIN = join(REPO, "bin", "ccr");

function runCcr(args: string[]) {
  return spawnSync("bun", [BIN, ...args], { encoding: "utf-8" });
}

test("package.json declares the ccr bin and the file is executable", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));
  expect(pkg.bin?.ccr).toBe("bin/ccr");
  // exists + has an executable bit
  const mode = statSync(BIN).mode;
  expect(mode & 0o111).not.toBe(0);
});

test("`ccr help` prints usage and exits 0", () => {
  const r = runCcr(["help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage:");
  expect(r.stdout).toContain("ccr install");
});

test("no args behaves like help", () => {
  const r = runCcr([]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage:");
});

test("an unknown subcommand is rejected (exit 2)", () => {
  const r = runCcr(["bogus"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("invalid choice");
});

test("a known read-only command is forwarded with flags (config --json)", () => {
  const r = runCcr(["config", "--json"]);
  expect(r.status).toBe(0);
  // forwarded `--json` must yield parseable JSON on stdout
  expect(() => JSON.parse(r.stdout)).not.toThrow();
});
