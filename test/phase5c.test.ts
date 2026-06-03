/**
 * phase5c.test.ts — ORACLE test for the state-mutating ccr commands (Phase 5c):
 * enable, disable, reset, cancel, skip-next, prune, request. Spawns BOTH
 * `ccr-hook.py --command X` and `bun src/cli.ts --command X` on SEPARATE
 * per-runtime HOME + CCR_ROOT (they mutate), and compares stdout + exit code +
 * key written artifacts.
 *
 * Normalization: root -> <ROOT>, home -> <HOME>, timestamps -> <TS>, the
 * `manual-<epoch>-` session id -> manual-<MID>-, and now()-derived prune
 * age_days -> <AGE> (all inherently divergent between two independent runs).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PY = join(REPO_ROOT, "templates", "bin", "ccr-hook.py");
const TS_CLI = join(REPO_ROOT, "src", "cli.ts");

const TMP: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p5c-${label}-`));
  TMP.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

let FAKE_BIN = "";
function fakeBin(): string {
  if (!FAKE_BIN) {
    const bin = freshTmp("bin");
    const c = join(bin, "cmux");
    writeFileSync(c, "#!/bin/sh\nexit 0\n");
    chmodSync(c, 0o755);
    FAKE_BIN = bin;
  }
  return FAKE_BIN;
}
function fakePath(): string {
  return `${fakeBin()}${delimiter}${process.env.PATH ?? ""}`;
}

const WID = "ws-5c";
function mkHome(opts: { enabled?: boolean; surfaces?: boolean } = {}): string {
  const home = freshTmp("home");
  const cfg = join(home, ".config", "claude-codex-review");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "VERSION"), "9.9.9-test\n");
  if (opts.enabled) {
    writeFileSync(join(cfg, "enabled-workspaces.txt"), WID + "\n");
  }
  if (opts.surfaces) {
    mkdirSync(join(cfg, "workspaces", WID), { recursive: true });
    writeFileSync(join(cfg, "workspaces", WID, "claude-surface"), "SURF_CLAUDE\n");
    writeFileSync(join(cfg, "workspaces", WID, "codex-surface"), "SURF_CODEX\n");
  }
  return home;
}

function run(bin: "py" | "ts", args: string[], cwd: string, env: Record<string, string>) {
  const cmd = bin === "py" ? ["python3", [PY, ...args]] as const : ["bun", [TS_CLI, ...args]] as const;
  return spawnSync(cmd[0], cmd[1], {
    encoding: "utf-8", cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PATH: fakePath(), ...env },
  });
}
function read(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf-8") : "<MISSING>";
}
function norm(s: string, root: string, home: string, cwd: string): string {
  return s
    .split(root).join("<ROOT>")
    .split(home).join("<HOME>")
    .split(cwd).join("<CWD>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>")
    .replace(/manual-\d+-/g, "manual-<MID>-")
    .replace(/"age_days": [0-9.]+/g, '"age_days": <AGE>')
    .replace(/\([0-9.]+ days;/g, "(<AGE> days;");
}

interface Spec {
  args: string[];
  env?: Record<string, string>;
  homeOpts?: { enabled?: boolean; surfaces?: boolean };
  seed?: (root: string) => void;
  cwdGit?: boolean;
  artifacts?: string[]; // root-relative files to byte-compare (normalized)
}

/** Run both runtimes on separate home/root; assert stdout + exit + artifacts. */
function expectParity(spec: Spec): { out: string; root: string } {
  const pyHome = mkHome(spec.homeOpts);
  const tsHome = mkHome(spec.homeOpts);
  const pyRoot = freshTmp("root");
  const tsRoot = freshTmp("root");
  spec.seed?.(pyRoot);
  spec.seed?.(tsRoot);
  const cwd = spec.cwdGit ? gitRepo() : freshTmp("cwd");
  const baseEnv = { CMUX_WORKSPACE_ID: WID, CMUX_SURFACE_ID: "SURF_CLAUDE", ...(spec.env ?? {}) };
  const py = run("py", spec.args, cwd, { HOME: pyHome, CCR_ROOT: pyRoot, ...baseEnv });
  const ts = run("ts", spec.args, cwd, { HOME: tsHome, CCR_ROOT: tsRoot, ...baseEnv });
  if (ts.status === null) throw new Error(`ts crashed: ${ts.stderr}`);
  if (py.status === null) throw new Error(`py crashed: ${py.stderr}`);
  expect(norm(ts.stdout, tsRoot, tsHome, cwd)).toBe(norm(py.stdout, pyRoot, pyHome, cwd));
  expect(ts.status).toBe(py.status);
  for (const rel of spec.artifacts ?? []) {
    expect(norm(read(join(tsRoot, rel)), tsRoot, tsHome, cwd)).toBe(norm(read(join(pyRoot, rel)), pyRoot, pyHome, cwd));
  }
  return { out: ts.stdout, root: tsRoot };
}

let REPO = "";
function gitRepo(): string {
  if (!REPO) {
    const r = freshTmp("repo");
    const gx = (...a: string[]) => spawnSync("git", ["-C", r, ...a], { encoding: "utf-8" });
    gx("init", "-q");
    gx("config", "user.email", "t@t");
    gx("config", "user.name", "t");
    writeFileSync(join(r, "a.ts"), "export const a = 1;\n");
    gx("add", "a.ts");
    gx("commit", "-q", "-m", "init");
    writeFileSync(join(r, "a.ts"), "export const a = 2;\n");
    REPO = r;
  }
  return REPO;
}

function seedActive(root: string): void {
  const sid = "sess-X";
  mkdirSync(join(root, "sessions", sid, "rounds", "0001"), { recursive: true });
  writeFileSync(join(root, "sessions", sid, "dirty.json"), "{}\n");
  writeFileSync(join(root, "sessions", sid, "rounds", "0001", "decision.json"), JSON.stringify({
    decision: "NEEDS_CHANGES", reviewer: "codex", worker: "claude", round: 1,
    review_file: join(root, "sessions", sid, "rounds", "0001", "review.md"), must_fix_count: 1, updated_at: "2026-06-03T10:01:00Z",
  }, null, 2) + "\n");
  writeFileSync(join(root, "sessions", sid, "rounds", "0001", "review.md"), "REVIEW_DECISION: NEEDS_CHANGES\n");
  writeFileSync(join(root, "sessions", sid, "rounds", "0001", "diff.patch"), "diff --git a/x b/x\n+1\n");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    version: 1, review_count: 1, last_diff_hash: "h",
    active_request: { round: 1, worker: "claude", reviewer: "codex", worker_session_id: sid, worker_surface: "SURF_CLAUDE", reviewer_surface: "SURF_CODEX", request_file: join(root, "r.md"), diff_file: join(root, "d.patch"), diff_hash: "h", created_at: "2026-06-03T10:00:00Z" },
    last_completed: null,
  }, null, 2) + "\n");
}

describe("command enable (oracle parity)", () => {
  test("enables workspace + seeds idle state", () => {
    const { out } = expectParity({ args: ["--command", "enable"], artifacts: ["state.json", "status.json"] });
    expect(out).toContain("자동 리뷰를 활성화했습니다: ws-5c");
  });
});

describe("command disable (oracle parity)", () => {
  test("removes workspace + marks disabled", () => {
    expectParity({ args: ["--command", "disable"], homeOpts: { enabled: true }, artifacts: ["status.json"] });
  });
});

describe("command reset (oracle parity)", () => {
  test("wipes + reseeds", () => {
    expectParity({ args: ["--command", "reset"], seed: seedActive, artifacts: ["state.json", "status.json"] });
  });
});

describe("command cancel (oracle parity)", () => {
  test("clears active + reports", () => {
    const { out } = expectParity({ args: ["--command", "cancel"], homeOpts: { enabled: true, surfaces: true }, seed: seedActive, artifacts: ["status.json", "sessions/sess-X/report.md"] });
    expect(out).toContain("Cancelled active request: round 1 (claude->codex)");
  });
  test("no active request", () => {
    const { out } = expectParity({ args: ["--command", "cancel"], seed: (r) => writeFileSync(join(r, "state.json"), JSON.stringify({ version: 1, review_count: 0, last_diff_hash: "", active_request: null, last_completed: null }, null, 2) + "\n"), artifacts: ["status.json"] });
    expect(out).toContain("No active request");
  });
});

describe("command skip-next (oracle parity)", () => {
  test("writes the skip marker", () => {
    const { out } = expectParity({ args: ["--command", "skip-next"], artifacts: ["skip-next.json"] });
    expect(out).toContain("다음 자동 리뷰 1회를 건너뜁니다");
  });
});

describe("command prune (oracle parity)", () => {
  function seedSessions(root: string): void {
    for (const sid of ["s1", "s2", "s3"]) {
      mkdirSync(join(root, "sessions", sid), { recursive: true });
      writeFileSync(join(root, "sessions", sid, "marker"), sid);
    }
  }
  test("dry-run lists candidates beyond keep=1", () => {
    const { out } = expectParity({ args: ["--command", "prune", "--keep", "1"], seed: seedSessions });
    expect(out).toContain("CCR Prune");
    expect(out).toContain("DRY-RUN");
  });
  test("--json dry-run", () => {
    expectParity({ args: ["--command", "prune", "--keep", "1", "--json"], seed: seedSessions });
  });
  test("refuses with no retention rule", () => {
    const { out } = expectParity({ args: ["--command", "prune", "--keep", "-1", "--days", "0"], seed: seedSessions });
    expect(out).toBe("");
  });
});

describe("command request (oracle parity)", () => {
  test("manual code_review request (no diff)", () => {
    const { out } = expectParity({
      args: ["--command", "request", "--type", "code_review", "--file", "a.ts", "--question", "ok?", "--purpose", "ship it"],
      homeOpts: { enabled: true, surfaces: true },
    });
    expect(out).toContain("Sent CCR code_review request to codex");
  });
  test("not enabled -> error exit 1", () => {
    const { out } = expectParity({ args: ["--command", "request", "--type", "code_review"], homeOpts: { surfaces: true } });
    expect(out).toBe("");
  });
});
