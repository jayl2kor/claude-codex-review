import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeSettings } from "../src/install.ts";

// Installer integration test. mergeSettings is the only part of install.ts that
// mutates pre-existing user state (settings.json / hooks.json), so it is the
// part that needs coverage. Paths are injected into a throwaway temp dir, so
// NOTHING under the real HOME is ever touched.

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

function tmpEnv() {
  const dir = mkdtempSync(join(tmpdir(), "ccr-install-test-"));
  return {
    dir,
    paths: {
      claudeSettings: join(dir, "claude-settings.json"),
      codexHooks: join(dir, "codex-hooks.json"),
      binRoot: join(dir, "bin"),
    },
  };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const ccrCount = (groups: any[]) =>
  groups.filter((g) => JSON.stringify(g).includes("ccr-hook-")).length;

test("mergeSettings: fresh install registers exactly one CCR group per event", () => {
  const { dir, paths } = tmpEnv();
  try {
    mergeSettings(paths);
    const claude = readJson(paths.claudeSettings);
    const codex = readJson(paths.codexHooks);
    for (const ev of EVENTS) {
      expect(ccrCount(claude.hooks[ev])).toBe(1);
      expect(ccrCount(codex.hooks[ev])).toBe(1);
    }
    // command shape "<path> <event>"; codex carries statusMessage, claude does not.
    expect(claude.hooks.Stop[0].hooks[0].command).toBe(
      join(paths.binRoot, "ccr-hook-claude") + " Stop",
    );
    expect(claude.hooks.Stop[0].hooks[0].statusMessage).toBeUndefined();
    expect(codex.hooks.Stop[0].hooks[0].statusMessage).toBe("Running CCR handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeSettings: preserves unrelated keys and existing non-CCR hooks", () => {
  const { dir, paths } = tmpEnv();
  try {
    writeFileSync(
      paths.claudeSettings,
      JSON.stringify({
        theme: "dark",
        permissions: { allow: ["Bash"] },
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "/usr/bin/other start", timeout: 5 }] },
          ],
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "/x/keepme pre", timeout: 9 }] },
          ],
        },
      }, null, 2),
    );
    mergeSettings(paths);
    const claude = readJson(paths.claudeSettings);
    // Unrelated top-level keys survive.
    expect(claude.theme).toBe("dark");
    expect(claude.permissions.allow).toEqual(["Bash"]);
    // Existing non-CCR hooks survive, and a single CCR group is added alongside.
    expect(claude.hooks.SessionStart.some((g: any) => JSON.stringify(g).includes("other start"))).toBe(true);
    expect(ccrCount(claude.hooks.SessionStart)).toBe(1);
    expect(claude.hooks.PreToolUse.some((g: any) => JSON.stringify(g).includes("keepme pre"))).toBe(true);
    expect(ccrCount(claude.hooks.PreToolUse)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeSettings: re-running is idempotent (dedupes CCR hooks)", () => {
  const { dir, paths } = tmpEnv();
  try {
    mergeSettings(paths);
    mergeSettings(paths);
    mergeSettings(paths);
    const claude = readJson(paths.claudeSettings);
    const codex = readJson(paths.codexHooks);
    for (const ev of EVENTS) {
      expect(ccrCount(claude.hooks[ev])).toBe(1);
      expect(ccrCount(codex.hooks[ev])).toBe(1);
      // No foreign groups were present, so exactly one group total per event.
      expect(claude.hooks[ev].length).toBe(1);
      expect(codex.hooks[ev].length).toBe(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeSettings: malformed (array) settings throws and restores the original", () => {
  const { dir, paths } = tmpEnv();
  try {
    writeFileSync(paths.claudeSettings, "[]\n"); // top-level array, not an object
    expect(() => mergeSettings(paths)).toThrow();
    // Original content is restored, not corrupted or partially written.
    expect(readFileSync(paths.claudeSettings, "utf-8")).toBe("[]\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeSettings: invalid JSON settings throws and leaves the file intact", () => {
  const { dir, paths } = tmpEnv();
  try {
    writeFileSync(paths.claudeSettings, "{not json");
    expect(() => mergeSettings(paths)).toThrow();
    expect(readFileSync(paths.claudeSettings, "utf-8")).toBe("{not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
