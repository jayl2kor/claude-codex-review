/**
 * postinstall.mjs — optional one-step setup after `npm i -g`.
 *
 * Runs `ccr install` automatically, but ONLY for an explicit global, non-CI
 * install, and always best-effort: it must never fail the npm install. A local/
 * dependency install, a CI install, or a missing `bun` just prints guidance and
 * exits 0, leaving the user to run `ccr install` themselves.
 *
 * Deliberately plain Node ESM (no bun, no TS): npm runs lifecycle scripts with
 * Node available, but `bun` — the CCR runtime — may not be present yet, so we
 * must be able to detect its absence without crashing.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = (msg) => process.stdout.write(`\n[ccr] ${msg}\n\n`);

// Guard 0: never run during npm's git-dep PREPARATION. For `npm i -g github:…`
// npm clones the repo into a cache temp dir and runs an inner install there to
// prepare it; firing setup from that throwaway location is wrong and would
// double-run at the final install. The real global install runs from
// <prefix>/lib/node_modules, never from a cache/clone path.
if (/[\\/](?:_cacache|\.git)[\\/]|git-clone/i.test(PKG_ROOT)) {
  process.exit(0);
}

// Guard 1: only act on an explicit global install. A local or dependency
// install must never touch the user's ~/.claude, ~/.codex, ~/.zshrc, or PATH.
if (process.env.npm_config_global !== "true") {
  process.exit(0);
}

// Guard 2: skip in CI — global setup that merges agent hooks is not what a CI
// runner wants, and it should never be a silent side effect there.
if (process.env.CI) {
  note("CI detected; skipping automatic setup. Run `ccr install` if you want it.");
  process.exit(0);
}

// Guard 3: the runtime is Bun. If it is missing, guide instead of failing.
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasBun) {
  note("Bun is required to run CCR. Install bun, then run:  ccr install");
  process.exit(0);
}

// Run the same setup as `ccr install`, inheriting stdio so the user sees it.
// Best-effort: a non-zero exit prints guidance but never fails `npm install`.
const res = spawnSync("bun", [join(PKG_ROOT, "bin", "ccr"), "install"], { stdio: "inherit" });
if (res.error || res.status !== 0) {
  note("Automatic setup did not complete. Run it manually:  ccr install");
}
process.exit(0);
