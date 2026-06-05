/**
 * postinstall.test.ts — the one-step-install guard (scripts/postinstall.mjs).
 *
 * Only the SIDE-EFFECT-FREE skip branches are exercised: a non-global install
 * and a CI install must exit 0 WITHOUT running the real `ccr install` (which
 * would mutate ~/.claude, ~/.codex, ~/.zshrc). The actual global-setup branch is
 * intentionally never triggered here.
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "postinstall.mjs");
const INSTALLER_DONE = "설치가 완료"; // installer's success line; must NOT appear

function run(env: Record<string, string>) {
  return spawnSync("node", [SCRIPT], {
    encoding: "utf-8",
    env: { ...process.env, npm_config_global: "", CI: "", ...env },
  });
}

test("non-global install is a silent no-op (exit 0, installer not run)", () => {
  const r = run({ npm_config_global: "" });
  expect(r.status).toBe(0);
  expect(r.stdout || "").not.toContain(INSTALLER_DONE);
  expect((r.stdout || "").trim()).toBe(""); // truly silent
});

test("global + CI install skips with guidance (exit 0, installer not run)", () => {
  const r = run({ npm_config_global: "true", CI: "1" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("CI detected");
  expect(r.stdout).not.toContain(INSTALLER_DONE);
});
