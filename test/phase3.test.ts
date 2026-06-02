/**
 * phase3.test.ts — ORACLE-BASED integration test for the Phase 3 I/O + lock +
 * git modules (src/lib/{io,paths,lock,git}.ts).
 *
 * Unlike the pure differential test, these functions have filesystem /
 * subprocess side effects, so we drive BOTH the Python runtime (via
 * test/phase3-probe.py, which imports the frozen templates/bin/ccr-hook.py) and
 * the TS port against parallel temp directories / a shared temp git repo, then
 * assert the produced artifacts are byte-identical:
 *   - state.json / status.json / dirty.json / session.json (indent=2 form)
 *   - events.jsonl (compact, key-sorted form)
 *   - collect_diff's full tuple, including its sha256 diff_hash (which only
 *     matches if the entire diff text is byte-for-byte identical).
 *
 * Wall-clock timestamps (now()) are non-deterministic, so timestamp tokens are
 * normalized to <TS> before comparison; everything else must match exactly.
 *
 * Constraints: read-only w.r.t. ccr.sh / README / ccr-hook.py; zero npm deps.
 * Run with: `bun test test/phase3.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { now, writeJson, appendJsonl, loadJson } from "../src/lib/io.ts";
import {
  lockedState,
  writeStatus,
  markDirty,
  clearDirty,
  hasDirty,
  ensureSession,
} from "../src/lib/lock.ts";
import { sessionDir } from "../src/lib/paths.ts";
import { collectDiff, insideGit, computeDeltaPatch } from "../src/lib/git.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "phase3-probe.py");
const LOCK_RUNNER = join(TEST_DIR, "phase3-lock-runner.ts");

const TMP_ROOTS: string[] = [];
function freshTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `ccr-p3-${label}-`));
  TMP_ROOTS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP_ROOTS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Run the Python oracle probe; throw on failure. Returns stdout. */
function probe(args: string[], env: Record<string, string> = {}): string {
  const proc = spawnSync("python3", [PROBE, ...args], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
  });
  if (proc.error) {
    throw new Error(`failed to spawn python3: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(
      `probe ${args[0]} exited ${proc.status}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }
  return proc.stdout;
}

/** Normalize ISO-8601 second-precision UTC timestamps to a stable token. */
function normTs(s: string): string {
  return s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, "<TS>");
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Set env vars for the duration of a callback, restoring prior values after. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(env)) {
      if (prev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev[k]!;
      }
    }
  }
}

// ===========================================================================
// now() format
// ===========================================================================
describe("io.now", () => {
  test("matches Python strftime format", () => {
    const tsNow = now();
    expect(tsNow).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const pyNow = probe(["now"]).trim();
    expect(pyNow).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

// ===========================================================================
// write_json / append_jsonl byte parity
// ===========================================================================
const SERIALIZE_CASES: Array<{ name: string; data: unknown }> = [
  { name: "empty-object", data: {} },
  { name: "empty-array", data: [] },
  {
    name: "mixed",
    data: { a: 1, b: "two", c: [1, 2, 3], d: { nested: true }, e: null },
  },
  { name: "unicode", data: { 키: "값", emoji: "💥🧨", arr: ["한", 2] } },
  { name: "key-order", data: { z: 1, a: 2, m: 3, A: 4, _: 5 } },
  { name: "nested-empty", data: { a: {}, b: [], c: { d: {} } } },
  {
    name: "special-chars",
    data: { s: 'line\nbreak\ttab"quote\\back', ctrl: "xy" },
  },
  { name: "numbers", data: { n: 0, neg: -5, big: 1234567 } },
  { name: "booleans", data: { t: true, f: false, nil: null } },
  { name: "array-of-objects", data: [{ b: 2, a: 1 }, { z: 26 }] },
];

describe("io.writeJson byte parity (indent=2, insertion order)", () => {
  for (const c of SERIALIZE_CASES) {
    test(c.name, () => {
      const dir = freshTmp("wj");
      const pyFile = join(dir, "py.json");
      const tsFile = join(dir, "ts.json");
      probe(["write-json", pyFile, JSON.stringify(c.data)]);
      writeJson(tsFile, c.data);
      expect(read(tsFile)).toBe(read(pyFile));
    });
  }
});

describe("io.appendJsonl byte parity (compact, sort_keys)", () => {
  for (const c of SERIALIZE_CASES) {
    test(c.name, () => {
      const dir = freshTmp("aj");
      const pyFile = join(dir, "py.jsonl");
      const tsFile = join(dir, "ts.jsonl");
      // Append twice to also confirm line accumulation is identical.
      probe(["append-jsonl", pyFile, JSON.stringify(c.data)]);
      probe(["append-jsonl", pyFile, JSON.stringify(c.data)]);
      appendJsonl(tsFile, c.data);
      appendJsonl(tsFile, c.data);
      expect(read(tsFile)).toBe(read(pyFile));
    });
  }
});

// ===========================================================================
// locked_state roundtrip
// ===========================================================================
describe("lock.lockedState state.json parity", () => {
  const patches: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "fresh-counts", patch: { review_count: 2, last_diff_hash: "abc123" } },
    {
      name: "active-request",
      patch: {
        review_count: 1,
        active_request: { round: 1, started_at: "x", reviewer: "codex" },
      },
    },
    {
      name: "last-completed",
      patch: { last_completed: { round: 3, decision: "PASS", at: "y" } },
    },
  ];
  for (const { name, patch } of patches) {
    test(`fresh root: ${name}`, () => {
      const rootPy = freshTmp("ls-py");
      const rootTs = freshTmp("ls-ts");
      probe(["locked-state-set", rootPy, JSON.stringify(patch)]);
      lockedState(rootTs, (s) => Object.assign(s, patch));
      expect(read(join(rootTs, "state.json"))).toBe(read(join(rootPy, "state.json")));
    });
  }

  test("pre-existing state is loaded, mutated, and rewritten identically", () => {
    const rootPy = freshTmp("ls2-py");
    const rootTs = freshTmp("ls2-ts");
    const seed =
      JSON.stringify(
        {
          version: 1,
          review_count: 5,
          last_diff_hash: "seedhash",
          active_request: null,
          last_completed: { round: 4, decision: "NEEDS_CHANGES", at: "z" },
        },
        null,
        2,
      ) + "\n";
    mkdirSync(rootPy, { recursive: true });
    mkdirSync(rootTs, { recursive: true });
    writeFileSync(join(rootPy, "state.json"), seed);
    writeFileSync(join(rootTs, "state.json"), seed);
    const patch = { review_count: 6, last_diff_hash: "newhash" };
    probe(["locked-state-set", rootPy, JSON.stringify(patch)]);
    lockedState(rootTs, (s) => Object.assign(s, patch));
    expect(read(join(rootTs, "state.json"))).toBe(read(join(rootPy, "state.json")));
  });

  test("corrupt state.json falls back to default_state on both sides", () => {
    const rootPy = freshTmp("ls3-py");
    const rootTs = freshTmp("ls3-ts");
    mkdirSync(rootPy, { recursive: true });
    mkdirSync(rootTs, { recursive: true });
    writeFileSync(join(rootPy, "state.json"), "not json{{{");
    writeFileSync(join(rootTs, "state.json"), "not json{{{");
    probe(["locked-state-set", rootPy, JSON.stringify({ review_count: 1 })]);
    lockedState(rootTs, (s) => Object.assign(s, { review_count: 1 }));
    expect(read(join(rootTs, "state.json"))).toBe(read(join(rootPy, "state.json")));
  });
});

// ===========================================================================
// write_status
// ===========================================================================
describe("lock.writeStatus status.json parity", () => {
  const state = {
    version: 1,
    review_count: 3,
    last_diff_hash: "h",
    active_request: { round: 2, reviewer: "claude" },
    last_completed: { round: 1, decision: "PASS", at: "t" },
  };
  test("basic", () => {
    const rootPy = freshTmp("ws-py");
    const rootTs = freshTmp("ws-ts");
    probe(["write-status", rootPy, JSON.stringify(state), "reviewing", "round 2 in flight"]);
    writeStatus(rootTs, state, "reviewing", "round 2 in flight");
    expect(normTs(read(join(rootTs, "status.json")))).toBe(
      normTs(read(join(rootPy, "status.json"))),
    );
  });

  test("missing review_count/active_request default like Python .get", () => {
    const rootPy = freshTmp("ws2-py");
    const rootTs = freshTmp("ws2-ts");
    const sparse = { version: 1 };
    probe(["write-status", rootPy, JSON.stringify(sparse), "idle", ""]);
    writeStatus(rootTs, sparse, "idle", "");
    expect(normTs(read(join(rootTs, "status.json")))).toBe(
      normTs(read(join(rootPy, "status.json"))),
    );
  });

  test("existing last_report object is preserved", () => {
    const rootPy = freshTmp("ws3-py");
    const rootTs = freshTmp("ws3-ts");
    const existing =
      JSON.stringify({ status: "old", last_report: { path: "/r.md", round: 9 } }, null, 2) + "\n";
    mkdirSync(rootPy, { recursive: true });
    mkdirSync(rootTs, { recursive: true });
    writeFileSync(join(rootPy, "status.json"), existing);
    writeFileSync(join(rootTs, "status.json"), existing);
    probe(["write-status", rootPy, JSON.stringify(state), "done", "ok"]);
    writeStatus(rootTs, state, "done", "ok");
    expect(normTs(read(join(rootTs, "status.json")))).toBe(
      normTs(read(join(rootPy, "status.json"))),
    );
  });
});

// ===========================================================================
// mark_dirty / clear_dirty / has_dirty
// ===========================================================================
describe("lock.markDirty dirty.json + events.jsonl parity", () => {
  const inputs: Array<{ name: string; input: Record<string, unknown> }> = [
    {
      name: "edit",
      input: {
        session_id: "sess-123",
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        turn_id: "turn-7",
      },
    },
    {
      name: "bash-missing-fields",
      input: { session_id: "abc", tool_name: "Bash" },
    },
    {
      name: "sanitized-sid",
      input: {
        session_id: "weird/../id with spaces",
        hook_event_name: "PreToolUse",
        tool: { name: "Write" },
        turn_id: 42,
      },
    },
  ];
  for (const { name, input } of inputs) {
    test(name, () => {
      const rootPy = freshTmp("md-py");
      const rootTs = freshTmp("md-ts");
      probe(["mark-dirty", rootPy, JSON.stringify(input), "claude", "claude"]);
      markDirty(rootTs, input, "claude", "claude");
      const sid = String(input.session_id);
      const pyDirty = join(sessionDir(rootPy, sid), "dirty.json");
      const tsDirty = join(sessionDir(rootTs, sid), "dirty.json");
      expect(normTs(read(tsDirty))).toBe(normTs(read(pyDirty)));
      expect(normTs(read(join(rootTs, "events.jsonl")))).toBe(
        normTs(read(join(rootPy, "events.jsonl"))),
      );
    });
  }

  test("no session_id is a no-op on both sides", () => {
    const rootPy = freshTmp("md0-py");
    const rootTs = freshTmp("md0-ts");
    probe(["mark-dirty", rootPy, JSON.stringify({ tool_name: "Edit" }), "claude", "claude"]);
    markDirty(rootTs, { tool_name: "Edit" }, "claude", "claude");
    expect(existsSync(join(rootTs, "events.jsonl"))).toBe(existsSync(join(rootPy, "events.jsonl")));
  });

  test("clearDirty / hasDirty lifecycle", () => {
    const root = freshTmp("cd-ts");
    const input = { session_id: "s1", hook_event_name: "x", tool_name: "Edit" };
    markDirty(root, input, "claude", "claude");
    expect(hasDirty(root, "s1")).toBe(true);
    clearDirty(root, "s1");
    expect(hasDirty(root, "s1")).toBe(false);
    // idempotent
    clearDirty(root, "s1");
    expect(hasDirty(root, "s1")).toBe(false);
  });
});

// ===========================================================================
// ensure_session
// ===========================================================================
describe("lock.ensureSession session.json + events.jsonl parity", () => {
  const ENV = { CMUX_WORKSPACE_ID: "ws-42", CMUX_SURFACE_ID: "surf-7" };
  const input = {
    session_id: "sess-abc",
    cwd: "/work/dir",
    transcript_path: "/t/path.jsonl",
    model: "claude-opus-4-8",
    hook_event_name: "SessionStart",
  };

  test("fresh session", () => {
    const rootPy = freshTmp("es-py");
    const rootTs = freshTmp("es-ts");
    probe(["ensure-session", rootPy, JSON.stringify(input), "claude", "claude"], ENV);
    withEnv(ENV, () => ensureSession(rootTs, "claude", "claude", input));
    const pyS = join(sessionDir(rootPy, input.session_id), "session.json");
    const tsS = join(sessionDir(rootTs, input.session_id), "session.json");
    expect(normTs(read(tsS))).toBe(normTs(read(pyS)));
    expect(normTs(read(join(rootTs, "events.jsonl")))).toBe(
      normTs(read(join(rootPy, "events.jsonl"))),
    );
  });

  test("missing optional fields become null on both sides", () => {
    const rootPy = freshTmp("es2-py");
    const rootTs = freshTmp("es2-ts");
    const sparse = { session_id: "s2", cwd: "/c" };
    probe(["ensure-session", rootPy, JSON.stringify(sparse), "codex", "codex"], ENV);
    withEnv(ENV, () => ensureSession(rootTs, "codex", "codex", sparse));
    const pyS = join(sessionDir(rootPy, "s2"), "session.json");
    const tsS = join(sessionDir(rootTs, "s2"), "session.json");
    expect(normTs(read(tsS))).toBe(normTs(read(pyS)));
  });

  test("existing created_at and extra keys are preserved ({**existing})", () => {
    const rootPy = freshTmp("es3-py");
    const rootTs = freshTmp("es3-ts");
    const sid = "s3";
    // SEED_CREATED is deliberately NOT a timestamp so normTs leaves it intact,
    // proving created_at is preserved rather than regenerated.
    const seed =
      JSON.stringify({ created_at: "SEED_CREATED", sentinel_key: "KEEP_ME" }, null, 2) + "\n";
    const pyDir = sessionDir(rootPy, sid);
    const tsDir = sessionDir(rootTs, sid);
    mkdirSync(pyDir, { recursive: true });
    mkdirSync(tsDir, { recursive: true });
    writeFileSync(join(pyDir, "session.json"), seed);
    writeFileSync(join(tsDir, "session.json"), seed);
    const inp = { session_id: sid, cwd: "/c" };
    probe(["ensure-session", rootPy, JSON.stringify(inp), "claude", "claude"], ENV);
    withEnv(ENV, () => ensureSession(rootTs, "claude", "claude", inp));
    const pyOut = read(join(pyDir, "session.json"));
    const tsOut = read(join(tsDir, "session.json"));
    expect(normTs(tsOut)).toBe(normTs(pyOut));
    // Both must retain the seeded values.
    expect(tsOut).toContain('"created_at": "SEED_CREATED"');
    expect(tsOut).toContain('"sentinel_key": "KEEP_ME"');
    expect(pyOut).toContain('"created_at": "SEED_CREATED"');
  });
});

// ===========================================================================
// collect_diff (temp git repo)
// ===========================================================================
function sh(cmd: string, args: string[], cwd: string): void {
  const proc = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  if (proc.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${proc.status}): ${proc.stderr}`);
  }
}

function buildRepo(): string {
  const repo = freshTmp("repo");
  sh("git", ["init", "-q"], repo);
  sh("git", ["config", "user.email", "t@e.st"], repo);
  sh("git", ["config", "user.name", "Test"], repo);
  sh("git", ["config", "commit.gpgsign", "false"], repo);
  // Initial commit so HEAD exists.
  writeFileSync(join(repo, "base.txt"), "base content\n");
  sh("git", ["add", "base.txt"], repo);
  sh("git", ["commit", "-q", "-m", "init"], repo);
  // Tracked file modified + staged.
  writeFileSync(join(repo, "staged.txt"), "staged change\n");
  sh("git", ["add", "staged.txt"], repo);
  // Tracked file modified, left unstaged.
  writeFileSync(join(repo, "base.txt"), "base content\nmodified line\n");
  // Untracked text file (safe).
  writeFileSync(join(repo, "new.txt"), "fresh untracked\nsecond line\n");
  // Untracked file with NO trailing newline.
  writeFileSync(join(repo, "nonl.txt"), "no trailing newline");
  // Untracked file with mixed line endings (CRLF + bare CR) to exercise
  // splitlinesKeepends; any divergence flips the byte-for-byte diff_hash.
  writeFileSync(join(repo, "mixed.txt"), "crlf\r\nbare\rcr\nlf\n");
  // Untracked sensitive file -> must be excluded by safe_rel_path.
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  // Untracked file under node_modules -> excluded.
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports=1\n");
  // Untracked binary file -> "binary file omitted".
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  return repo;
}

describe("git.collectDiff parity (temp repo)", () => {
  test("insideGit true inside repo, false outside", () => {
    const repo = buildRepo();
    expect(insideGit(repo)).toBe(true);
    const outside = freshTmp("nogit");
    expect(insideGit(outside)).toBe(false);
  });

  test("full tuple incl. sha256 diff_hash matches the Python oracle", () => {
    const repo = buildRepo();
    const pyTuple = JSON.parse(probe(["collect-diff", repo]).trim());
    const tsTuple = collectDiff(repo);
    // [combined, diff_hash, head, has_content, changed_lines, files_touched]
    expect(tsTuple).toEqual(pyTuple);
  });

  test("collectDiff outside a git repo returns the empty tuple", () => {
    const outside = freshTmp("nogit2");
    const tsTuple = collectDiff(outside);
    const pyTuple = JSON.parse(probe(["collect-diff", outside]).trim());
    expect(tsTuple).toEqual(pyTuple);
    expect(tsTuple).toEqual(["", "", "", false, 0, []]);
  });
});

// ===========================================================================
// collect_diff symlink safety (regression: lexical resolve leaked out-of-tree
// files; the port must canonicalize like Python's Path.resolve()).
// ===========================================================================
describe("git.collectDiff symlink handling", () => {
  test("untracked symlink pointing OUTSIDE the repo is excluded (no leak) and matches oracle", () => {
    const secretDir = freshTmp("secret");
    const secretFile = join(secretDir, "secret.txt");
    writeFileSync(secretFile, "TOP_SECRET_LEAK_CONTENT\n");
    const repo = buildRepo();
    symlinkSync(secretFile, join(repo, "leak.txt"));

    const tsTuple = collectDiff(repo);
    const pyTuple = JSON.parse(probe(["collect-diff", repo]).trim());
    expect(tsTuple).toEqual(pyTuple);
    // The out-of-tree secret must never appear in the combined diff text.
    expect(tsTuple[0]).not.toContain("TOP_SECRET_LEAK_CONTENT");
    expect(tsTuple[0]).not.toContain("leak.txt");
  });

  test("untracked symlink pointing INSIDE the repo matches the oracle", () => {
    const repo = buildRepo();
    // alias -> in-tree base.txt; Python resolves it inside the tree and keeps
    // it. Whatever Python does, the port must match byte-for-byte (diff_hash).
    symlinkSync(join(repo, "base.txt"), join(repo, "alias.txt"));
    const tsTuple = collectDiff(repo);
    const pyTuple = JSON.parse(probe(["collect-diff", repo]).trim());
    expect(tsTuple).toEqual(pyTuple);
  });

  test("in-tree symlink to a SENSITIVE target (alias.txt -> .env.local) is excluded", () => {
    const repo = buildRepo();
    // .env.local is itself excluded by name; the danger is a benignly-named
    // symlink whose RESOLVED target is the secret. safeRelPath must re-run on
    // the resolved repo-relative path. (Same guard in py and ts -> still parity.)
    writeFileSync(join(repo, ".env.local"), "API_KEY=SECRET_SHOULD_NOT_LEAK\n");
    symlinkSync(join(repo, ".env.local"), join(repo, "alias.txt"));
    const tsTuple = collectDiff(repo);
    const pyTuple = JSON.parse(probe(["collect-diff", repo]).trim());
    expect(tsTuple).toEqual(pyTuple);
    expect(tsTuple[0]).not.toContain("SECRET_SHOULD_NOT_LEAK");
    expect(tsTuple[0]).not.toContain("alias.txt");
  });
});

// ===========================================================================
// collect_diff hardening: repo-configured diff helpers must NOT execute during
// review collection (--no-ext-diff / --no-textconv).
// ===========================================================================
describe("git.collectDiff diff-helper hardening", () => {
  // Helper scripts live OUTSIDE the repo so they are not themselves collected as
  // untracked files (which would put their sentinel text into the diff).
  function rawGitDiff(repo: string, args: string[]): string {
    return spawnSync("git", ["-C", repo, "diff", ...args], { encoding: "utf-8" }).stdout ?? "";
  }

  test("--no-textconv suppresses a configured textconv on BOTH staged and unstaged", () => {
    const helpers = freshTmp("helpers");
    const upper = join(helpers, "upper.sh");
    writeFileSync(upper, '#!/bin/sh\nawk \'{print toupper($0)}\' "$1"\n');
    sh("chmod", ["+x", upper], helpers);

    const repo = buildRepo();
    writeFileSync(join(repo, ".gitattributes"), "*.tc diff=upper\n");
    sh("git", ["config", "diff.upper.textconv", upper], repo);
    writeFileSync(join(repo, "staged.tc"), "alpha base\n");
    writeFileSync(join(repo, "unstaged.tc"), "beta base\n");
    sh("git", ["add", ".gitattributes", "staged.tc", "unstaged.tc"], repo);
    sh("git", ["commit", "-q", "-m", "tc"], repo);
    writeFileSync(join(repo, "staged.tc"), "alpha base\nstaged marker low\n");
    sh("git", ["add", "staged.tc"], repo);
    writeFileSync(join(repo, "unstaged.tc"), "beta base\nunstaged marker low\n");

    // Sanity: without the flag the textconv IS active on both paths.
    expect(rawGitDiff(repo, ["--cached", "staged.tc"])).toContain("STAGED MARKER LOW");
    expect(rawGitDiff(repo, ["unstaged.tc"])).toContain("UNSTAGED MARKER LOW");

    const tsTuple = collectDiff(repo);
    expect(tsTuple).toEqual(JSON.parse(probe(["collect-diff", repo]).trim()));
    expect(tsTuple[0]).toContain("staged marker low");
    expect(tsTuple[0]).toContain("unstaged marker low");
    expect(tsTuple[0]).not.toContain("STAGED MARKER LOW");
    expect(tsTuple[0]).not.toContain("UNSTAGED MARKER LOW");
  });

  test("--no-ext-diff suppresses a configured external diff on BOTH staged and unstaged", () => {
    const helpers = freshTmp("helpers2");
    const ext = join(helpers, "ext.sh");
    // Prints a sentinel instead of a real diff; git would use it as the diff.
    writeFileSync(ext, "#!/bin/sh\necho EXTDIFF_RAN\n");
    sh("chmod", ["+x", ext], helpers);

    const repo = buildRepo();
    writeFileSync(join(repo, ".gitattributes"), "*.ed diff=ext\n");
    sh("git", ["config", "diff.ext.command", ext], repo);
    writeFileSync(join(repo, "staged.ed"), "one\n");
    writeFileSync(join(repo, "unstaged.ed"), "two\n");
    sh("git", ["add", ".gitattributes", "staged.ed", "unstaged.ed"], repo);
    sh("git", ["commit", "-q", "-m", "ed"], repo);
    writeFileSync(join(repo, "staged.ed"), "one\nstaged change\n");
    sh("git", ["add", "staged.ed"], repo);
    writeFileSync(join(repo, "unstaged.ed"), "two\nunstaged change\n");

    // Sanity: without the flag the external diff IS invoked on both paths.
    expect(rawGitDiff(repo, ["--cached", "staged.ed"])).toContain("EXTDIFF_RAN");
    expect(rawGitDiff(repo, ["unstaged.ed"])).toContain("EXTDIFF_RAN");

    const tsTuple = collectDiff(repo);
    expect(tsTuple).toEqual(JSON.parse(probe(["collect-diff", repo]).trim()));
    // External diff command never ran; normal internal diff is present instead.
    expect(tsTuple[0]).not.toContain("EXTDIFF_RAN");
    expect(tsTuple[0]).toContain("staged.ed");
    expect(tsTuple[0]).toContain("unstaged.ed");
  });
});

// ===========================================================================
// paths.sessionDir traversal safety: a "." / ".." session id must NOT escape
// root/sessions (sanitize remaps all-dots segments).
// ===========================================================================
describe("paths.sessionDir traversal safety", () => {
  test('"."/".."/alias session ids stay strictly under root/sessions', () => {
    const root = resolve(freshTmp("sdir"));
    const base = join(root, "sessions");
    for (const sid of [".", "..", "...", "../..", "../../etc/passwd", "  ..  "]) {
      const dir = resolve(sessionDir(root, sid));
      expect(dir.startsWith(base + sep)).toBe(true);
    }
  });
});

// ===========================================================================
// lock reclaim / ownership (DIRECTORY lock at <root>/state.lock.d): a dead
// holder is reclaimed, a LIVE holder is never stolen, reentrancy is rejected,
// and concurrent contenders never lose updates.
// ===========================================================================
describe("lock.lockedState reclaim & ownership", () => {
  // Plant a held lock dir; owner === null simulates a holder that crashed
  // between mkdir and the owner-file write.
  function plantLock(root: string, owner: string | null): void {
    const lockDir = join(root, "state.lock.d");
    mkdirSync(lockDir, { recursive: true });
    if (owner !== null) {
      writeFileSync(join(lockDir, "owner"), owner);
    }
  }
  const lockDirOf = (root: string): string => join(root, "state.lock.d");

  test("reclaims a lock left by a dead PID and releases its own lock", () => {
    const root = freshTmp("lockdead");
    plantLock(root, "2147483646:stale");
    lockedState(root, (s) => {
      s.review_count = 7;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(7);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("reclaims an owner-less (crashed-during-init) lock dir after the grace", () => {
    const root = freshTmp("lockinit");
    plantLock(root, null); // dir exists but no owner file was written
    lockedState(root, (s) => {
      s.review_count = 5;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(5);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("reclaims a lock dir with a corrupt (non-pid) owner token", () => {
    const root = freshTmp("lockcorrupt");
    plantLock(root, "garbage-without-a-pid"); // holderPid -> null -> reclaimable
    lockedState(root, (s) => {
      s.review_count = 4;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(4);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("an empty owner file (mid-init) is reclaimed after the grace", () => {
    const root = freshTmp("lockemptyowner");
    const lockDir = join(root, "state.lock.d");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner"), ""); // created but token not yet written
    lockedState(root, (s) => {
      s.review_count = 3;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(3);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("a crashed-mid-publish artifact (no owner, leftover private temp) is reclaimed cleanly", () => {
    // A publisher that died after creating its temp but before linking `owner`
    // leaves an owner-less dir containing a `.owner.tmp.*` file — and NEVER a
    // live owner. Reclaim must remove the whole dir (recursive) and acquire.
    const root = freshTmp("lockpubfail");
    const lockDir = join(root, "state.lock.d");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, ".owner.tmp.deadbeef"), "12345:partial"); // no `owner`
    lockedState(root, (s) => {
      s.review_count = 8;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(8);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("reclaims a same-PID lock from a prior run (distinguished by nonce)", () => {
    const root = freshTmp("lockself");
    // A leftover owner bearing OUR pid but a prior-acquisition nonce. The live
    // process is us, yet this must be reclaimed (not deadlocked) and must not be
    // mistaken for our current acquisition — the per-acquisition nonce differs.
    plantLock(root, `${process.pid}:prior-run-nonce`);
    lockedState(root, (s) => {
      s.review_count = 9;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(9);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("nested lockedState on the same root is rejected; the outer lock is preserved", () => {
    const root = freshTmp("locknest");
    let innerRan = false;
    expect(() =>
      lockedState(root, (outer) => {
        outer.review_count = 1;
        // Reentrant acquire of the SAME root must throw rather than reclaim the
        // live outer lock (the round-2 mutual-exclusion bug).
        lockedState(root, (inner) => {
          innerRan = true;
          inner.review_count = 2;
        });
      }),
    ).toThrow(/reentrant/);
    expect(innerRan).toBe(false);
    // Outer unwound cleanly: lock released, and its write never landed (the
    // mutate threw before writeJson).
    expect(existsSync(lockDirOf(root))).toBe(false);
    expect(existsSync(join(root, "state.json"))).toBe(false);
  });

  test("sequential lockedState on the same root is NOT treated as reentrant", () => {
    const root = freshTmp("lockseq");
    lockedState(root, (s) => {
      s.review_count = 1;
    });
    lockedState(root, (s) => {
      s.review_count = (s.review_count as number) + 1;
    });
    expect(loadJson<{ review_count?: number }>(join(root, "state.json"), {}).review_count).toBe(2);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("nested lockedState through a root ALIAS (symlink) is still rejected", () => {
    const root = freshTmp("lockalias");
    const linkParent = freshTmp("lockalias-link");
    const aliasRoot = join(linkParent, "alias");
    symlinkSync(root, aliasRoot); // aliasRoot -> root (same physical directory)
    let innerRan = false;
    expect(() =>
      lockedState(root, (outer) => {
        outer.review_count = 1;
        // The SAME physical root reached via a symlink alias must still be
        // detected as reentrant (canonicalized lock identity) — not reclaim the
        // live outer lock. (The round-3 alias-bypass bug.)
        lockedState(aliasRoot, (inner) => {
          innerRan = true;
          inner.review_count = 2;
        });
      }),
    ).toThrow(/reentrant/);
    expect(innerRan).toBe(false);
    expect(existsSync(lockDirOf(root))).toBe(false);
    expect(existsSync(join(root, "state.json"))).toBe(false);
  });

  test("rejects an async mutate callback instead of silently dropping it", () => {
    const root = freshTmp("lockasync");
    expect(() =>
      // TS allows an async callback to satisfy `(state) => void` (its Promise
      // return is widened to void), which is exactly why the runtime guard
      // exists. No @ts-expect-error: this is intentionally a clean assignment.
      lockedState(root, async (s) => {
        s.review_count = 1;
      }),
    ).toThrow(/synchronous/);
  });

  test("a LIVE holder's lock is never stolen (blocks like flock)", () => {
    const root = freshTmp("locklive");
    // A real, live process whose PID we plant as the lock-dir owner.
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const liveToken = `${holder.pid!}:held-by-test`;
      plantLock(root, liveToken);
      // A contender must BLOCK behind the live holder. Run it with a timeout;
      // it should be killed before completing (state.json never written) and
      // must leave the live holder's lock dir untouched.
      const proc = spawnSync("bun", [LOCK_RUNNER, root, "block"], {
        encoding: "utf-8",
        timeout: 1000,
      });
      expect(proc.status).toBe(null); // killed by timeout => it was blocked
      expect(existsSync(join(root, "state.json"))).toBe(false);
      expect(existsSync(lockDirOf(root))).toBe(true);
      expect(readFileSync(join(lockDirOf(root), "owner"), "utf-8").trim()).toBe(liveToken);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("concurrent contenders racing to RECLAIM a dead lock dir never lose updates", async () => {
    const root = freshTmp("lockrace");
    // Plant a dead lock dir so EVERY contender starts on the reclaimDeadLock
    // (atomic rename) path simultaneously — the race the review series targeted.
    plantLock(root, "2147483646:stale");
    const N = 6;
    const kids = Array.from({ length: N }, () =>
      spawn("bun", [LOCK_RUNNER, root, "incr"], { stdio: "ignore" }),
    );
    const codes = await Promise.all(
      kids.map(
        (k) => new Promise<number>((res) => k.on("exit", (code) => res(code ?? -1))),
      ),
    );
    expect(codes.every((c) => c === 0)).toBe(true);
    // If mutual exclusion held, every increment landed: counter === N.
    expect(loadJson<{ counter?: number }>(join(root, "state.json"), {}).counter).toBe(N);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("forced interleaving: many contenders with NO pre-existing lock stay exclusive", async () => {
    // Pure acquire/release contention (no planted lock): contenders race mkdir,
    // and each reclaims the released dir of the previous holder. counter must
    // equal N — any mutual-exclusion break loses an increment.
    const root = freshTmp("lockcontend");
    mkdirSync(root, { recursive: true });
    const N = 8;
    const kids = Array.from({ length: N }, () =>
      spawn("bun", [LOCK_RUNNER, root, "incr"], { stdio: "ignore" }),
    );
    const codes = await Promise.all(
      kids.map((k) => new Promise<number>((res) => k.on("exit", (c) => res(c ?? -1)))),
    );
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(loadJson<{ counter?: number }>(join(root, "state.json"), {}).counter).toBe(N);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });

  test("an owner-less leftover (failed/stalled-publish artifact) is reclaimed, not path-cleaned, under contention", async () => {
    // The publish-failure path deliberately leaves an owner-less dir (it must
    // NOT path-clean, since the dir may already belong to a new live holder).
    // Plant that exact artifact and prove concurrent contenders all acquire
    // cleanly — any wrong path-removal of a live holder's dir loses an increment.
    const root = freshTmp("lockleftover");
    plantLock(root, null); // owner-less dir == what a failed/stalled publish leaves
    const N = 4;
    const kids = Array.from({ length: N }, () =>
      spawn("bun", [LOCK_RUNNER, root, "incr"], { stdio: "ignore" }),
    );
    const codes = await Promise.all(
      kids.map((k) => new Promise<number>((res) => k.on("exit", (c) => res(c ?? -1)))),
    );
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(loadJson<{ counter?: number }>(join(root, "state.json"), {}).counter).toBe(N);
    expect(existsSync(lockDirOf(root))).toBe(false);
  });
});

// ===========================================================================
// compute_delta_patch
// ===========================================================================
describe("git.computeDeltaPatch", () => {
  test("writes a unified diff when inputs differ", () => {
    const dir = freshTmp("delta");
    const prev = join(dir, "prev.patch");
    const cur = join(dir, "cur.patch");
    const dest = join(dir, "delta.patch");
    writeFileSync(prev, "line1\nline2\n");
    writeFileSync(cur, "line1\nline2-changed\nline3\n");
    expect(computeDeltaPatch(prev, cur, dest)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(read(dest)).toContain("line2-changed");
  });

  test("returns false when an input is missing", () => {
    const dir = freshTmp("delta2");
    const cur = join(dir, "cur.patch");
    writeFileSync(cur, "x\n");
    expect(computeDeltaPatch(join(dir, "absent.patch"), cur, join(dir, "d.patch"))).toBe(false);
  });

  test("returns false when inputs are identical (empty diff)", () => {
    const dir = freshTmp("delta3");
    const prev = join(dir, "p.patch");
    const cur = join(dir, "c.patch");
    writeFileSync(prev, "same\n");
    writeFileSync(cur, "same\n");
    expect(computeDeltaPatch(prev, cur, join(dir, "d.patch"))).toBe(false);
  });

  test("a hostile symlink at dest is replaced, not followed (no clobber)", () => {
    const dir = freshTmp("deltasym");
    const prev = join(dir, "prev.patch");
    const cur = join(dir, "cur.patch");
    writeFileSync(prev, "a\n");
    writeFileSync(cur, "a\nb\n");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const dest = join(dir, "delta.patch");
    symlinkSync(victim, dest); // hostile: dest -> victim
    expect(computeDeltaPatch(prev, cur, dest)).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // target untouched
    expect(lstatSync(dest).isSymbolicLink()).toBe(false); // dest is now a real file
    expect(read(dest)).toContain("+b");
  });

  test("the PYTHON oracle compute_delta_patch also replaces a hostile dest symlink", () => {
    const dir = freshTmp("deltapysym");
    const prev = join(dir, "prev.patch");
    const cur = join(dir, "cur.patch");
    writeFileSync(prev, "a\n");
    writeFileSync(cur, "a\nb\n");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const dest = join(dir, "delta.patch");
    symlinkSync(victim, dest);
    const out = JSON.parse(probe(["compute-delta-patch", prev, cur, dest]).trim());
    expect(out.ok).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // target untouched
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(read(dest)).toContain("+b");
  });
});

// ===========================================================================
// io.writeJson hostile-symlink safety (regression: predictable temp name +
// symlink-following writes could clobber arbitrary files).
// ===========================================================================
describe("io.writeJson symlink safety", () => {
  test("does NOT clobber a hostile symlink planted at the old predictable temp path", () => {
    const dir = freshTmp("wjtmp");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const dest = join(dir, "state.json");
    // The pre-hardening code wrote to `${dest}.tmp` via a symlink-following
    // write; plant a hostile symlink there. The random O_EXCL temp ignores it.
    symlinkSync(victim, `${dest}.tmp`);
    writeJson(dest, { ok: 1 });
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // untouched
    expect(loadJson<{ ok?: number }>(dest, {}).ok).toBe(1);
  });

  test("replaces a symlink AT the destination without following it", () => {
    const dir = freshTmp("wjdest");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const dest = join(dir, "state.json");
    symlinkSync(victim, dest); // dest itself is a hostile symlink to victim
    writeJson(dest, { ok: 2 });
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // target untouched
    expect(lstatSync(dest).isSymbolicLink()).toBe(false); // dest is now a real file
    expect(loadJson<{ ok?: number }>(dest, {}).ok).toBe(2);
  });

  test("the PYTHON oracle write_json is hardened the same way (no temp-symlink clobber)", () => {
    const dir = freshTmp("pywjtmp");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const dest = join(dir, "state.json");
    symlinkSync(victim, `${dest}.tmp`); // old predictable Python temp name
    probe(["write-json", dest, JSON.stringify({ ok: 3 })]);
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // untouched
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toEqual({ ok: 3 });
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
  });

  test("cleans up the random temp file when serialization fails (no .tmp.* left behind)", () => {
    const dir = freshTmp("wjfail");
    const dest = join(dir, "state.json");
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws on this
    expect(() => writeJson(dest, circular)).toThrow();
    // No leftover temp files, and the destination was never created.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  test("leaves no temp behind when the final rename fails (destination is a directory)", () => {
    const dir = freshTmp("wjrenamefail");
    const dest = join(dir, "state.json");
    mkdirSync(dest, { recursive: true }); // rename onto a non-empty dir fails
    writeFileSync(join(dest, "keep"), "x");
    expect(() => writeJson(dest, { ok: 1 })).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
  });
});

// ===========================================================================
// io.appendJsonl symlink safety (regression: appendFileSync followed a hostile
// events.jsonl symlink; the hardened path opens O_NOFOLLOW).
// ===========================================================================
describe("io.appendJsonl symlink safety", () => {
  test("refuses to append THROUGH a hostile symlink at the path (no clobber)", () => {
    const dir = freshTmp("ajsym");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const events = join(dir, "events.jsonl");
    symlinkSync(victim, events); // hostile: events.jsonl -> victim
    // O_NOFOLLOW makes the open fail rather than appending through the symlink.
    expect(() => appendJsonl(events, { type: "x" })).toThrow();
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // untouched
  });

  test("appends normally to a regular file", () => {
    const dir = freshTmp("ajok");
    const events = join(dir, "events.jsonl");
    appendJsonl(events, { type: "a" });
    appendJsonl(events, { type: "b" });
    const lines = readFileSync(events, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "a" });
  });

  test("the PYTHON oracle append_jsonl also refuses a hostile events.jsonl symlink", () => {
    const dir = freshTmp("ajpysym");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "ORIGINAL\n");
    const events = join(dir, "events.jsonl");
    symlinkSync(victim, events);
    // O_NOFOLLOW makes Python os.open raise -> the probe exits non-zero -> throws.
    expect(() => probe(["append-jsonl", events, JSON.stringify({ type: "x" })])).toThrow();
    expect(readFileSync(victim, "utf-8")).toBe("ORIGINAL\n"); // untouched
  });
});

// Reference loadJson so the import is exercised (round-trips a written file).
describe("io.loadJson", () => {
  test("round-trips a written object and returns default when absent", () => {
    const dir = freshTmp("lj");
    const f = join(dir, "x.json");
    writeJson(f, { a: 1 });
    expect(loadJson<unknown>(f, null)).toEqual({ a: 1 });
    expect(loadJson(join(dir, "absent.json"), "DEFAULT")).toBe("DEFAULT");
  });
});
