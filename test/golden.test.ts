/**
 * Phase-0 golden-test regression net for the CCR Python runtime.
 *
 * Purpose: pin the EXACT behavior of the stdlib-only pure functions in
 * templates/bin/ccr-hook.py so that a future Bun port can be proven equivalent.
 * These tests shell out to a tiny Python probe (test/golden-probe.py) that
 * importlib-loads the runtime DIRECTLY from templates/bin/ccr-hook.py — they do
 * NOT depend on an installed ~/.local/bin copy.
 *
 * Constraints honored:
 *   - Zero npm runtime deps: only Bun built-ins + node:* stdlib.
 *   - Read-only: never mutates ccr.sh, README.md, or any HOME/config path.
 *   - install.ts is never executed here.
 *
 * Run with: `bun test test/golden.test.ts` (or `bun test`).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");
const PROBE = join(TEST_DIR, "golden-probe.py");
const GOLDEN_FILE = join(TEST_DIR, "golden", "functions.json");
const RUNTIME = join(REPO_ROOT, "templates", "bin", "ccr-hook.py");
const SELFTEST = join(REPO_ROOT, "templates", "selftest-install.py");
const INSTALLED_HOOK = join(
  process.env.HOME ?? "",
  ".local",
  "bin",
  "ccr-hook.py",
);

// Importing ccr-hook.py / selftest-install.py would otherwise drop a
// __pycache__/*.pyc next to templates/bin/ccr-hook.py, polluting the working
// tree. selftest-install.py is byte-identical to ccr.sh's SELFTEST block and
// must not be edited, so suppress bytecode at the process level instead — every
// spawnSync below inherits this env (none override it).
process.env.PYTHONDONTWRITEBYTECODE = "1";

/**
 * Extract the last well-formed JSON line/blob from a stdout string.
 *
 * The user's shell profile can emit noise on stderr during `python3` startup,
 * but the probe writes its JSON to stdout. We still defensively parse only the
 * JSON payload: try the whole string first, then fall back to the last line
 * that parses as JSON. This keeps the harness robust across environments.
 */
function parseProbeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to line-by-line recovery.
  }
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning upward
    }
  }
  throw new Error(`no JSON found in probe stdout:\n${stdout}`);
}

/** Call the probe with a function name + args, return the parsed `result`. */
function probe(fn: string, args: unknown[]): unknown {
  const proc = spawnSync(
    "python3",
    [PROBE, fn, JSON.stringify(args)],
    { encoding: "utf-8", cwd: REPO_ROOT },
  );
  if (proc.error) {
    throw new Error(`failed to spawn python3: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(
      `probe exited ${proc.status} for ${fn}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
  }
  const parsed = parseProbeJson(proc.stdout) as { ok?: boolean; result?: unknown; error?: string };
  if (!parsed.ok) {
    throw new Error(`probe reported failure for ${fn}: ${parsed.error}`);
  }
  return parsed.result;
}

describe("ccr-hook runtime presence", () => {
  test("templates/bin/ccr-hook.py exists (source of truth)", () => {
    expect(existsSync(RUNTIME)).toBe(true);
  });
  test("golden-probe.py exists", () => {
    expect(existsSync(PROBE)).toBe(true);
  });
});

describe("parse_decision (deterministic golden cases)", () => {
  test("PASS with trailing content", () => {
    expect(probe("parse_decision", ["REVIEW_DECISION: PASS\nrest"])).toBe("PASS");
  });
  test("NEEDS_CHANGES after preamble line", () => {
    expect(
      probe("parse_decision", ["preamble\nREVIEW_DECISION: NEEDS_CHANGES"]),
    ).toBe("NEEDS_CHANGES");
  });
  test("case-insensitive lowercase 'pass' -> PASS", () => {
    expect(probe("parse_decision", ["REVIEW_DECISION: pass"])).toBe("PASS");
  });
  test("surrounding whitespace tolerated -> NEEDS_HUMAN", () => {
    expect(probe("parse_decision", ["REVIEW_DECISION:   NEEDS_HUMAN  "])).toBe(
      "NEEDS_HUMAN",
    );
  });
  test("no decision line -> INVALID", () => {
    expect(probe("parse_decision", ["no decision here"])).toBe("INVALID");
  });
  test("fenced example does not leak; real decision wins", () => {
    const fenced =
      "Example format:\n```\nREVIEW_DECISION: PASS\n```\nActual verdict:\nREVIEW_DECISION: NEEDS_CHANGES\n";
    expect(probe("parse_decision", [fenced])).toBe("NEEDS_CHANGES");
  });
  test("blockquoted example does not leak; real decision wins", () => {
    const quoted = "> REVIEW_DECISION: PASS\nREVIEW_DECISION: NEEDS_HUMAN\n";
    expect(probe("parse_decision", [quoted])).toBe("NEEDS_HUMAN");
  });
});

describe("count_changed_lines (deterministic golden cases)", () => {
  test("counts +/- but skips +++/--- headers", () => {
    expect(
      probe("count_changed_lines", ["--- a/x\n+++ b/x\n@@\n+hi\n-bye\n other"]),
    ).toBe(2);
  });
});

describe("_count_must_fix_in_text (deterministic golden cases)", () => {
  test("sentinel '- None.' is not a must-fix", () => {
    expect(
      probe("_count_must_fix_in_text", [
        "## Must Fix\n- None.\n\n## Looks Good\n- ok\n",
      ]),
    ).toBe(0);
  });
  test("sentinel variants (N/A, -, (none), 없음) not counted", () => {
    expect(
      probe("_count_must_fix_in_text", ["## Must Fix\n- N/A\n- -\n- (none)\n- 없음\n"]),
    ).toBe(0);
  });
  test("two real items counted", () => {
    expect(
      probe("_count_must_fix_in_text", ["## Must Fix\n- a real one\n- another\n"]),
    ).toBe(2);
  });
  test("mixed sentinel + real -> 1", () => {
    expect(
      probe("_count_must_fix_in_text", ["## Must Fix\n- None.\n- a real one\n"]),
    ).toBe(1);
  });
});

describe("is_ccr_handoff_prompt (deterministic golden cases)", () => {
  test("sentinel on first line -> true", () => {
    expect(probe("is_ccr_handoff_prompt", ["[ccr-handoff]\n..."])).toBe(true);
  });
  test("sentinel on first line with non-ascii body -> true", () => {
    expect(
      probe("is_ccr_handoff_prompt", ["[ccr-handoff]\n자동 리뷰 요청입니다"]),
    ).toBe(true);
  });
  test("sentinel not on first line -> false", () => {
    expect(probe("is_ccr_handoff_prompt", ["please [ccr-handoff] later"])).toBe(
      false,
    );
  });
  test("normal prompt -> false", () => {
    expect(probe("is_ccr_handoff_prompt", ["normal"])).toBe(false);
  });
  test("empty prompt -> false", () => {
    expect(probe("is_ccr_handoff_prompt", [""])).toBe(false);
  });
});

describe("should_mark_dirty_for_tool (deterministic golden cases)", () => {
  test("apply_patch -> true", () => {
    expect(probe("should_mark_dirty_for_tool", [{ tool_name: "apply_patch" }])).toBe(
      true,
    );
  });
  test("Edit / Write / MultiEdit -> true", () => {
    expect(probe("should_mark_dirty_for_tool", [{ tool_name: "Edit" }])).toBe(true);
    expect(probe("should_mark_dirty_for_tool", [{ tool_name: "Write" }])).toBe(true);
    expect(probe("should_mark_dirty_for_tool", [{ tool_name: "MultiEdit" }])).toBe(
      true,
    );
  });
  test("Bash 'pytest' (read-only/test) -> false", () => {
    expect(
      probe("should_mark_dirty_for_tool", [
        { tool_name: "Bash", tool_input: { command: "pytest" } },
      ]),
    ).toBe(false);
  });
  test("Bash 'ccr-reset' / 'ccr-status' -> false", () => {
    expect(
      probe("should_mark_dirty_for_tool", [
        { tool_name: "Bash", tool_input: { command: "ccr-reset" } },
      ]),
    ).toBe(false);
    expect(
      probe("should_mark_dirty_for_tool", [
        { tool_name: "Bash", tool_input: { command: "ccr-status" } },
      ]),
    ).toBe(false);
  });
  test("Bash redirect 'printf x > app.py' -> true", () => {
    expect(
      probe("should_mark_dirty_for_tool", [
        { tool_name: "Bash", tool_input: { command: "printf x > app.py" } },
      ]),
    ).toBe(true);
  });
  test("Bash 'rm -rf build' -> true", () => {
    expect(
      probe("should_mark_dirty_for_tool", [
        { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
      ]),
    ).toBe(true);
  });
});

describe("committed golden snapshot", () => {
  test("test/golden/functions.json exists and is internally consistent", () => {
    expect(existsSync(GOLDEN_FILE)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf-8")) as {
      version: number;
      cases: Array<{ fn: string; args: unknown[]; expected: unknown; actual: unknown }>;
    };
    expect(golden.version).toBe(1);
    expect(Array.isArray(golden.cases)).toBe(true);
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const c of golden.cases) {
      expect(c.actual).toEqual(c.expected);
    }
  });

  test("re-running the probe reproduces the committed golden values exactly", () => {
    // Re-emit the snapshot from the live runtime and compare to the committed
    // file. Any drift in pure-function behavior fails here — this is the gate a
    // future Bun port must also pass.
    const proc = spawnSync("python3", [PROBE, "--emit-golden"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    expect(proc.error).toBeUndefined();
    expect(proc.status).toBe(0);
    const fresh = parseProbeJson(proc.stdout) as {
      cases: Array<{ fn: string; args: unknown[]; expected: unknown; actual: unknown }>;
    };
    const committed = JSON.parse(readFileSync(GOLDEN_FILE, "utf-8")) as {
      cases: Array<{ fn: string; args: unknown[]; expected: unknown; actual: unknown }>;
    };
    // Compare case-by-case (order + values) so a diff points at the offender.
    expect(fresh.cases.length).toBe(committed.cases.length);
    for (let i = 0; i < committed.cases.length; i++) {
      const f = fresh.cases[i];
      const g = committed.cases[i];
      expect({ fn: f.fn, args: f.args, actual: f.actual }).toEqual({
        fn: g.fn,
        args: g.args,
        actual: g.actual,
      });
    }
  });
});

describe("install-time selftest", () => {
  // The shipped selftest (templates/selftest-install.py) importlib-loads the
  // INSTALLED hook at ~/.local/bin/ccr-hook.py and self-verifies many runtime
  // behaviors. We run it only when that installed copy is present (we never
  // install it here, per the non-destructive constraint).
  const haveInstalled = existsSync(INSTALLED_HOOK);
  test.skipIf(!haveInstalled)(
    "python3 templates/selftest-install.py exits 0 (installed hook present)",
    () => {
      const proc = spawnSync("python3", [SELFTEST], {
        encoding: "utf-8",
        cwd: REPO_ROOT,
      });
      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
    },
  );
  test.skipIf(haveInstalled)(
    "selftest-install.py skipped: no installed ~/.local/bin/ccr-hook.py (non-destructive; golden-probe covers the runtime directly)",
    () => {
      expect(haveInstalled).toBe(false);
    },
  );

  // Variant that ALWAYS runs: point the selftest's importlib at the in-repo
  // runtime templates/bin/ccr-hook.py instead of the installed copy, so the
  // selftest's behavioral assertions are exercised with zero install footprint.
  // We do this by running the selftest source with HOME redirected to a temp
  // dir whose .local/bin/ccr-hook.py is a copy of the in-repo runtime.
  test("selftest behaviors pass against in-repo runtime (temp HOME, no real install)", () => {
    const proc = spawnSync(
      "python3",
      ["-c", SELFTEST_INREPO_DRIVER, RUNTIME, SELFTEST],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    if (proc.status !== 0) {
      throw new Error(
        `in-repo selftest failed (status ${proc.status})\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
      );
    }
    expect(proc.status).toBe(0);
  });
});

/**
 * Python driver (run via `python3 -c`) that executes the shipped selftest
 * against the IN-REPO runtime without touching the real HOME. It creates a
 * throwaway temp HOME, copies templates/bin/ccr-hook.py into
 * <tempHOME>/.local/bin/ccr-hook.py, sets HOME to it, and execs the selftest
 * source. argv: [runtime_path, selftest_path].
 */
const SELFTEST_INREPO_DRIVER = `
import os, sys, shutil, tempfile, runpy
runtime, selftest = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp(prefix="ccr-golden-home-")
bindir = os.path.join(tmp, ".local", "bin")
os.makedirs(bindir, exist_ok=True)
shutil.copyfile(runtime, os.path.join(bindir, "ccr-hook.py"))
os.environ["HOME"] = tmp
# Some stdlib paths cache the home dir; Path.home() reads $HOME at call time on
# POSIX, so setting it here is sufficient for the selftest's importlib lookup.
try:
    runpy.run_path(selftest, run_name="__main__")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`;
