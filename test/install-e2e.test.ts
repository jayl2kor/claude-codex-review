/**
 * install-e2e.test.ts — end-to-end install of ccr.sh into an ISOLATED HOME
 * under a PYTHON-FREE PATH (Phase 5f). This is the highest-value guard for the
 * Python->Bun cutover: it runs the real installer with a PATH that has `bun`
 * (plus git/coreutils) but NO `python`/`python3`, so a surviving Python
 * dependency anywhere in install or runtime would fail loudly. It exercises:
 *   - need_cmd bun (prereq)
 *   - copy-install of templates/bin/ccr-cli.js + bin wrappers (exec bun)
 *   - the inline `bun run -` settings merge into settings.json / hooks.json
 *   - the install-time `bun ccr-cli.js --command selftest` (aborts on failure)
 *   - the inline `bun run -` post-merge JSON validation
 * then runs the installed wrappers (selftest / doctor / check) and asserts they
 * neither invoke nor report Python.
 *
 * Everything is rooted at a throwaway HOME, so the real ~/.claude, ~/.codex,
 * ~/.config, ~/.local, ~/.zshrc are never touched (the migration invariant).
 */
import { afterAll, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CCR_SH = join(REPO_ROOT, "ccr.sh");

const TMP: string[] = [];
afterAll(() => {
  for (const d of TMP) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-e2e-${label}-`));
  TMP.push(d);
  return d;
}

/**
 * Build a bin dir that symlinks every command on the real PATH EXCEPT anything
 * named python* — so `bun`, `git`, `bash`, and coreutils are present but
 * `python`/`python3` are genuinely absent (which("python3") === null). Used as
 * the ONLY PATH entry so any Python invocation fails with "command not found".
 */
function pythonFreeBin(): string {
  const farm = freshTmp("nopybin");
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.toLowerCase().startsWith("python")) continue; // exclude python, python3, python3.x
      if (seen.has(name)) continue;
      seen.add(name);
      try { symlinkSync(join(dir, name), join(farm, name)); } catch { /* skip dupes/races */ }
    }
  }
  return farm;
}

test("ccr.sh installs + runs with bun and NO python on PATH (no-Python invariant)", () => {
  const home = freshTmp("home");
  const cwd = freshTmp("cwd");
  const bin = pythonFreeBin();
  const env = { ...process.env, HOME: home, PATH: bin };

  // Sanity: the curated PATH really has bun and really lacks python3. Use
  // `bash -c` (NOT -lc) so the passed PATH is respected and no login profile
  // re-adds the system bindir (which would restore python3).
  expect(spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf-8", env }).status).toBe(0);
  expect(spawnSync("bash", ["-c", "command -v python3 || true"], { encoding: "utf-8", env }).stdout.trim()).toBe("");

  const install = spawnSync("bash", [CCR_SH], { encoding: "utf-8", cwd, env });
  if (install.status !== 0) {
    throw new Error(`ccr.sh failed (exit ${install.status})\nSTDOUT:\n${install.stdout}\nSTDERR:\n${install.stderr}`);
  }
  expect(install.stdout).toContain("설치가 완료되었습니다.");

  const binRoot = join(home, ".local", "bin");
  expect(existsSync(join(binRoot, "ccr-cli.js"))).toBe(true);
  expect(existsSync(join(binRoot, "ccr-hook.py"))).toBe(false);
  for (const w of ["ccr-hook-claude", "ccr-hook-codex", "ccr-status", "ccr-doctor", "ccr-check"]) {
    expect(existsSync(join(binRoot, w))).toBe(true);
  }

  // The inline bun settings-merge wrote both hook files (valid JSON, CCR hooks).
  const settings = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
  const hooks = readFileSync(join(home, ".codex", "hooks.json"), "utf-8");
  expect(JSON.parse(settings)).toBeDefined();
  expect(JSON.parse(hooks)).toBeDefined();
  expect(settings).toContain("ccr-hook-claude");
  expect(hooks).toContain("ccr-hook-codex");

  const run = (wrapper: string, ...args: string[]) =>
    spawnSync("bash", [join(binRoot, wrapper), ...args], { encoding: "utf-8", cwd, env });

  // ccr-selftest: the installed runtime self-checks pass with no python present.
  const selftest = run("ccr-selftest");
  expect(selftest.status).toBe(0);
  expect(selftest.stdout).toContain("passed");
  expect(`${selftest.stdout}${selftest.stderr}`.toLowerCase()).not.toContain("python");

  // ccr-doctor --json: no python check survives; the runtime command checked is bun.
  const doctor = run("ccr-doctor", "--json");
  const ddoc = JSON.parse(doctor.stdout);
  const checkNames = (ddoc.checks as Array<{ name: string; status: string }>).map((c) => c.name);
  expect(checkNames).not.toContain("command: python3");
  const bunCheck = (ddoc.checks as Array<{ name: string; status: string }>).find((c) => c.name === "command: bun");
  expect(bunCheck).toBeDefined();
  expect(bunCheck!.status).toBe("ok");
  expect(JSON.stringify(ddoc).toLowerCase()).not.toContain("python");

  // ccr-check --json: rollup runs and reports nothing about python.
  const check = run("ccr-check", "--json");
  expect(check.stdout.length).toBeGreaterThan(0);
  expect(check.stdout.toLowerCase()).not.toContain("python");
}, 120_000);

// The inline merge validates BOTH the Claude (settings.json) and Codex
// (hooks.json) branches identically; cover each so future drift in either
// safety-hook install path is caught.
for (const target of [
  { label: "claude settings.json", rel: [".claude", "settings.json"] },
  { label: "codex hooks.json", rel: [".codex", "hooks.json"] },
] as const) {
  test(`ccr.sh inline merge rejects a malformed .hooks shape in ${target.label} and restores it`, () => {
    const home = freshTmp("home-bad");
    const cwd = freshTmp("cwd-bad");
    const env = { ...process.env, HOME: home, PATH: pythonFreeBin() };

    // Valid JSON, but .hooks is an array — the asArray/asPlainObject guard must
    // throw so the catch restores the backup instead of letting JSON.stringify
    // silently drop CCR hook entries (leaving CCR installed without safety hooks).
    const file = join(home, ...target.rel);
    const original = '{"hooks": []}\n';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, original, "utf-8");

    const install = spawnSync("bash", [CCR_SH], { encoding: "utf-8", cwd, env });
    // The merge throws -> bun exits nonzero -> ccr.sh (set -e) aborts the install.
    expect(install.status).not.toBe(0);
    // The malformed file is restored byte-for-byte (not corrupted / not half-merged).
    expect(readFileSync(file, "utf-8")).toBe(original);
  }, 120_000);
}
