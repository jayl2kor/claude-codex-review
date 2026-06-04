/**
 * bundle-sync.test.ts — drift guard for the shipped runtime bundle (Phase 5f).
 *
 * The runtime is a single bundle built from src/cli.ts and committed at
 * templates/bin/ccr-cli.js, which ccr.sh and install.ts copy-install (it is NOT
 * embedded in ccr.sh; check:sync allowlists it). This rebuilds the bundle to a
 * temp file and asserts it is byte-identical to the committed copy, so a change
 * to src/ without re-running `bun run build:cli` is caught. Chain of trust:
 *   src/cli.ts --(this test)--> templates/bin/ccr-cli.js --(copy-installed by ccr.sh/install.ts)--> ~/.local/bin
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(REPO_ROOT, "scripts", "build-cli.ts");
const COMMITTED = join(REPO_ROOT, "templates", "bin", "ccr-cli.js");

test("committed templates/bin/ccr-cli.js matches a fresh build of src/cli.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccr-bundle-sync-"));
  try {
    const out = join(dir, "ccr-cli.js");
    const built = spawnSync("bun", [BUILD, out], { encoding: "utf-8", cwd: REPO_ROOT });
    expect(built.status).toBe(0);
    const fresh = readFileSync(out);
    const committed = readFileSync(COMMITTED);
    // Byte-exact: build is deterministic (no minify), so any diff means the
    // committed bundle is stale — run `bun run build:cli`.
    expect(fresh.equals(committed)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
