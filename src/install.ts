#!/usr/bin/env bun
/**
 * install.ts — Bun/TypeScript port of the original bash installer (ccr.sh).
 *
 * This is a faithful, non-destructive port of /tmp/ccr-inline/installer-logic.sh
 * together with the two embedded install-time here-docs (now Bun, formerly
 * Python):
 *   - settings merge (formerly pyblock_04248.py)
 *   - post-merge JSON validation (formerly pyblock_05031.py)
 *
 * It reproduces the original steps in the SAME ORDER. As of Phase 5f the runtime
 * is the bundled Bun CLI (ccr-cli.js), so `bun` is the only hard requirement;
 * Python is no longer involved at install or runtime.
 *
 * Zero npm runtime dependencies — only Bun/Node built-ins are used.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Step 1: Path vars off os.homedir()
// ---------------------------------------------------------------------------
const HOME = homedir();
const CONFIG_ROOT = join(HOME, ".config", "claude-codex-review");
const STATE_ROOT = join(HOME, ".local", "state", "claude-codex-review");
const BIN_ROOT = join(HOME, ".local", "bin");

const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
const CODEX_HOOKS = join(HOME, ".codex", "hooks.json");
const CLAUDE_COMMANDS = join(HOME, ".claude", "commands");
const ZSHRC = join(HOME, ".zshrc");
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

// Templates dir ships alongside install.ts at <repo>/templates.
// install.ts lives in <repo>/src, so templates is one level up.
const TEMPLATES_DIR = join(import.meta.dir, "..", "templates");

// ---------------------------------------------------------------------------
// Small helpers mirroring the shell semantics.
// ---------------------------------------------------------------------------

/** command -v <cmd> >/dev/null 2>&1 */
function commandExists(cmd: string): boolean {
  // `command -v` is the portable POSIX test the bash script used.
  const res = spawnSync("command", ["-v", cmd], {
    stdio: "ignore",
    shell: true,
  });
  return res.status === 0;
}

/** need_cmd: abort with the same Korean message if missing. */
function needCmd(cmd: string): void {
  if (!commandExists(cmd)) {
    console.log(`필수 명령어가 없습니다: ${cmd}`);
    process.exit(1);
  }
}

/** mkdir -p */
function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** touch <file> (create empty if missing; do not truncate if present) */
function touch(file: string): void {
  if (!existsSync(file)) {
    writeFileSync(file, "", { encoding: "utf-8" });
  }
}

/**
 * grep -Fqx equivalent: returns true if the file contains an exact line equal
 * to `line` (fixed-string, whole-line match).
 */
function fileHasExactLine(file: string, line: string): boolean {
  if (!existsSync(file)) return false;
  const content = readFileSync(file, "utf-8");
  // Split on \n; a trailing newline produces a final "" element which never
  // matches a non-empty PATH_LINE, matching grep -Fqx whole-line semantics.
  const lines = content.split("\n");
  return lines.includes(line);
}

/**
 * Recursively copy a directory tree, preserving subdirectories.
 * ALWAYS overwrites (matches bash reinstall behavior).
 */
function copyTree(srcDir: string, destDir: string): void {
  mkdirp(destDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ===========================================================================
// Step 6 port: settings merge (faithful port of pyblock_04248.py)
// ===========================================================================

type Json = unknown;

/**
 * Assert that a parsed JSON value is a plain (non-null, non-array) object.
 *
 * Without this, an existing settings file whose top level is a JSON array
 * (e.g. `[]`) would be cast straight to an object; `mergeSettings` would then
 * attach `.hooks` to an array and `JSON.stringify` would SILENTLY DROP that
 * property, letting the installer "succeed" with no CCR hooks registered.
 * Throwing here routes through mergeSettings' try/catch so the backups are
 * restored instead.
 */
export function asPlainObject(value: Json, label: string): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    throw new Error(`Expected ${label} to be a JSON object, got ${kind}`);
  }
  return value as Record<string, Json>;
}

/** Assert that a value is a JSON array (used for per-event hook lists). */
export function asArray(value: Json, label: string): unknown[] {
  if (!Array.isArray(value)) {
    const kind = value === null ? "null" : typeof value;
    throw new Error(`Expected ${label} to be a JSON array, got ${kind}`);
  }
  return value;
}

export function loadJson(path: string): Record<string, Json> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  return asPlainObject(JSON.parse(text), path);
}

function backup(path: string, backupPath: string): void {
  if (existsSync(path)) {
    copyFileSync(path, backupPath);
  }
}

function restore(path: string, backupPath: string): void {
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, path);
  }
}

function removeBackup(backupPath: string): void {
  if (existsSync(backupPath)) {
    unlinkSync(backupPath);
  }
}

/**
 * contains_ccr_hook: serialize the group and look for the CCR markers.
 * Mirrors json.dumps(obj, ensure_ascii=False) then substring search.
 */
function containsCcrHook(obj: Json): boolean {
  const text = JSON.stringify(obj);
  return text.includes("ccr-hook-") || text.includes("claude-codex-review-");
}

function command(path: string, event: string): string {
  return `${path} ${event}`;
}

interface HookEntry {
  type: "command";
  command: string;
  timeout: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/**
 * hook_group: faithful port. Key insertion order in the original Python dict is
 * {"hooks": [...]} first, then "matcher" added afterward. JSON serialization in
 * Python preserves insertion order, so "hooks" appears before "matcher". We
 * reproduce that ordering here by building the object with `hooks` first.
 */
function hookGroup(
  event: string,
  path: string,
  matcher: string | null = null,
  timeout = 30,
  status: string | null = null,
): HookGroup {
  const entry: HookEntry = {
    type: "command",
    command: command(path, event),
    timeout,
  };
  if (status) {
    entry.statusMessage = status;
  }
  const group: HookGroup = { hooks: [entry] };
  if (matcher !== null) {
    group.matcher = matcher;
  }
  return group;
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

const DEFAULT_MERGE_PATHS = {
  claudeSettings: CLAUDE_SETTINGS,
  codexHooks: CODEX_HOOKS,
  binRoot: BIN_ROOT,
};

/**
 * Merge CCR hook groups into the Claude settings + Codex hooks files.
 *
 * Paths are injectable so a temp-HOME test can exercise merge preservation,
 * CCR-hook dedupe, and rollback-on-malformed-config WITHOUT mutating the real
 * home. Defaults target the live install locations (used by main()).
 */
export function mergeSettings(
  opts: { claudeSettings: string; codexHooks: string; binRoot: string } =
    DEFAULT_MERGE_PATHS,
): void {
  const CLAUDE_SETTINGS = opts.claudeSettings;
  const CODEX_HOOKS = opts.codexHooks;
  const BIN_ROOT = opts.binRoot;
  const claudeBackup = join(dirname(CLAUDE_SETTINGS), "settings.json.ccr-backup");
  const codexBackup = join(dirname(CODEX_HOOKS), "hooks.json.ccr-backup");

  const claudeHook = join(BIN_ROOT, "ccr-hook-claude");
  const codexHook = join(BIN_ROOT, "ccr-hook-codex");

  try {
    backup(CLAUDE_SETTINGS, claudeBackup);
    backup(CODEX_HOOKS, codexBackup);

    // --- Claude settings ---
    const claude = loadJson(CLAUDE_SETTINGS);
    if (claude.hooks === undefined) claude.hooks = {};
    const claudeHooks = asPlainObject(
      claude.hooks,
      `${CLAUDE_SETTINGS} → .hooks`,
    ) as Record<string, HookGroup[]>;
    claude.hooks = claudeHooks;
    for (const event of HOOK_EVENTS) {
      if (claudeHooks[event] === undefined) claudeHooks[event] = [];
      claudeHooks[event] = (
        asArray(claudeHooks[event], `${CLAUDE_SETTINGS} → .hooks.${event}`) as HookGroup[]
      ).filter((item) => !containsCcrHook(item));
    }

    claudeHooks.SessionStart.push(
      hookGroup("SessionStart", claudeHook, "startup|resume|clear", 30),
    );
    claudeHooks.UserPromptSubmit.push(
      hookGroup("UserPromptSubmit", claudeHook, null, 10),
    );
    claudeHooks.PreToolUse.push(
      hookGroup(
        "PreToolUse",
        claudeHook,
        "Bash|Edit|Write|MultiEdit|NotebookEdit",
        30,
      ),
    );
    claudeHooks.PostToolUse.push(
      hookGroup(
        "PostToolUse",
        claudeHook,
        "Bash|Edit|Write|MultiEdit|NotebookEdit",
        30,
      ),
    );
    claudeHooks.Stop.push(hookGroup("Stop", claudeHook, null, 30));

    mkdirp(dirname(CLAUDE_SETTINGS));
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(claude, null, 2) + "\n", {
      encoding: "utf-8",
    });

    // --- Codex hooks ---
    const codex = loadJson(CODEX_HOOKS);
    if (codex.hooks === undefined) codex.hooks = {};
    const codexHooks = asPlainObject(
      codex.hooks,
      `${CODEX_HOOKS} → .hooks`,
    ) as Record<string, HookGroup[]>;
    codex.hooks = codexHooks;
    for (const event of HOOK_EVENTS) {
      if (codexHooks[event] === undefined) codexHooks[event] = [];
      codexHooks[event] = (
        asArray(codexHooks[event], `${CODEX_HOOKS} → .hooks.${event}`) as HookGroup[]
      ).filter((item) => !containsCcrHook(item));
    }

    codexHooks.SessionStart.push(
      hookGroup(
        "SessionStart",
        codexHook,
        "startup|resume|clear",
        30,
        "Starting CCR session",
      ),
    );
    codexHooks.UserPromptSubmit.push(
      hookGroup(
        "UserPromptSubmit",
        codexHook,
        null,
        10,
        "Resetting CCR round counter",
      ),
    );
    codexHooks.PreToolUse.push(
      hookGroup(
        "PreToolUse",
        codexHook,
        "Bash|apply_patch|Edit|Write",
        30,
        "Checking CCR reviewer mode",
      ),
    );
    codexHooks.PostToolUse.push(
      hookGroup(
        "PostToolUse",
        codexHook,
        "Bash|apply_patch|Edit|Write",
        30,
        "Recording CCR activity",
      ),
    );
    codexHooks.Stop.push(
      hookGroup("Stop", codexHook, null, 30, "Running CCR handoff"),
    );

    mkdirp(dirname(CODEX_HOOKS));
    writeFileSync(CODEX_HOOKS, JSON.stringify(codex, null, 2) + "\n", {
      encoding: "utf-8",
    });

    // In-merge validation (mirrors the trailing json.load calls in pyblock_04248).
    JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf-8"));
    JSON.parse(readFileSync(CODEX_HOOKS, "utf-8"));

    removeBackup(claudeBackup);
    removeBackup(codexBackup);
  } catch (e) {
    restore(CLAUDE_SETTINGS, claudeBackup);
    restore(CODEX_HOOKS, codexBackup);
    console.log(`설정 병합 중 오류가 발생해 원본을 복구했습니다: ${e}`);
    throw e;
  }
}

// ===========================================================================
// Step 8 port: post-merge JSON validation (faithful port of pyblock_05031.py)
// ===========================================================================
function validateJsonFiles(paths: string[]): void {
  for (const raw of paths) {
    try {
      JSON.parse(readFileSync(raw, "utf-8"));
    } catch (exc) {
      throw new Error(`Invalid JSON in ${raw}: ${exc}`);
    }
  }
}

// ===========================================================================
// Step 9 port: VERSION file write.
//
// Original shell:
//   {
//     git rev-parse --short HEAD   (or "unknown-sha")
//     date -u "+installed=%Y-%m-%dT%H:%M:%SZ"
//   } | tr '\n' ' ' > VERSION
//   echo >> VERSION
//
// `tr '\n' ' '` turns BOTH trailing newlines (after the sha and after the date)
// into spaces, yielding "<sha> installed=<ISO> " (note the trailing space).
// Then `echo >>` appends a single newline. Final content:
//   "<sha> installed=<ISO> \n"
// ===========================================================================
function gitShortShaOfInstallerRepo(): string {
  // The original resolves SCRIPT_DIR to the installer's own directory and only
  // emits a sha when that dir is a git repo. install.ts lives in <repo>/src;
  // the repo root is import.meta.dir/.. — git -C resolves the enclosing repo.
  const scriptDir = import.meta.dir;
  if (!commandExists("git")) return "unknown-sha";
  const res = spawnSync(
    "git",
    ["-C", scriptDir, "rev-parse", "--short", "HEAD"],
    { encoding: "utf-8" },
  );
  if (res.status === 0 && typeof res.stdout === "string") {
    const sha = res.stdout.trim();
    if (sha) return sha;
  }
  return "unknown-sha";
}

function isoZNow(): string {
  // date -u "+installed=%Y-%m-%dT%H:%M:%SZ" → seconds precision, UTC, trailing Z.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;
  return `installed=${stamp}`;
}

function writeVersionFile(): void {
  const sha = gitShortShaOfInstallerRepo();
  const datePart = isoZNow();
  // Join the two "lines" with a space (tr '\n' ' '), and because each line had a
  // trailing newline, there is also a trailing space after datePart. Then the
  // final `echo >>` adds the newline.
  const content = `${sha} ${datePart} \n`;
  writeFileSync(join(CONFIG_ROOT, "VERSION"), content, { encoding: "utf-8" });
}

// ===========================================================================
// main — reproduces installer-logic.sh in order.
// ===========================================================================
export function main(): void {
  // Step 2: require bun (the runtime is the bundled ccr-cli.js Bun CLI).
  needCmd("bun");

  // Step 3: mkdir -p the same dirs; touch enabled-workspaces.txt.
  mkdirp(join(CONFIG_ROOT, "workspaces"));
  mkdirp(STATE_ROOT);
  mkdirp(BIN_ROOT);
  mkdirp(dirname(CLAUDE_SETTINGS));
  mkdirp(dirname(CODEX_HOOKS));
  mkdirp(CLAUDE_COMMANDS);
  touch(join(CONFIG_ROOT, "enabled-workspaces.txt"));

  // Step 4: append PATH line to ~/.zshrc only if not already present (grep -Fqx).
  touch(ZSHRC);
  let pathAdded: "yes" | "no";
  if (!fileHasExactLine(ZSHRC, PATH_LINE)) {
    appendFileSync(
      ZSHRC,
      "\n# Added by cmux Claude-Codex review installer\n" + PATH_LINE + "\n",
      { encoding: "utf-8" },
    );
    pathAdded = "yes";
  } else {
    pathAdded = "no";
  }

  // Step 5: copy templates and chmod.
  // bin/ → BIN_ROOT, chmod 0o755 on every copied file (matches reinstall).
  const binSrc = join(TEMPLATES_DIR, "bin");
  for (const entry of readdirSync(binSrc, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dest = join(BIN_ROOT, entry.name);
    copyFileSync(join(binSrc, entry.name), dest);
    chmodSync(dest, 0o755);
  }

  // claude-commands/*.md → CLAUDE_COMMANDS
  const commandsSrc = join(TEMPLATES_DIR, "claude-commands");
  for (const entry of readdirSync(commandsSrc, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    copyFileSync(join(commandsSrc, entry.name), join(CLAUDE_COMMANDS, entry.name));
  }

  // config/** → CONFIG_ROOT (preserving subdirs incl. codex-home/AGENTS.md).
  // mkdir -p CONFIG_ROOT and CONFIG_ROOT/codex-home first (matches shell order).
  mkdirp(CONFIG_ROOT);
  mkdirp(join(CONFIG_ROOT, "codex-home"));
  copyTree(join(TEMPLATES_DIR, "config"), CONFIG_ROOT);

  // Step 6: settings merge (backup → merge → validate → remove-backup; restore on error).
  mergeSettings();

  // Step 7: install-time selftest. Run the freshly-installed runtime's own
  // selftest (`bun ~/.local/bin/ccr-cli.js --command selftest`), which
  // re-exercises the bundled lib in-process. Inherit stdio; a non-zero exit
  // aborts the install.
  const selftest = spawnSync("bun", [join(BIN_ROOT, "ccr-cli.js"), "--command", "selftest"], {
    stdio: "inherit",
  });
  if (selftest.status !== 0) {
    process.exit(selftest.status === null ? 1 : selftest.status);
  }

  // Step 8: post-merge JSON validation of both files.
  validateJsonFiles([CLAUDE_SETTINGS, CODEX_HOOKS]);

  // Step 9: VERSION file.
  writeVersionFile();

  // Step 10: Korean user-facing summary (verbatim from installer-logic.sh).
  console.log();
  console.log("설치가 완료되었습니다.");
  console.log();
  console.log("생성된 주요 명령어:");
  console.log("  cmux-setup-claude");
  console.log("  cmux-setup-codex");
  console.log("  ccr-help");
  console.log("  ccr-enable");
  console.log("  ccr-disable");
  console.log("  ccr-status");
  console.log("  ccr-request");
  console.log("  ccr-reset");
  console.log("  ccr-cancel");
  console.log("  ccr-history");
  console.log("  ccr-events");
  console.log("  ccr-show");
  console.log("  ccr-preview");
  console.log("  ccr-prune");
  console.log("  ccr-config");
  console.log("  ccr-check");
  console.log("  ccr-skip-next");
  console.log("  ccr-report");
  console.log("  ccr-ready");
  console.log("  ccr-doctor");
  console.log("  ccr-support");
  console.log("  ccr-selftest");
  console.log("  ccr-uninstall");
  console.log();

  if (pathAdded === "yes") {
    console.log("~/.local/bin PATH 설정을 ~/.zshrc에 추가했습니다.");
    console.log("이미 열려 있던 일반 쉘에서는 아래 중 하나를 해주세요.");
    console.log("  1) source ~/.zshrc");
    console.log("  2) 탭을 닫고 새로 열기");
  } else {
    console.log("~/.local/bin PATH 설정은 이미 ~/.zshrc에 있습니다.");
  }

  console.log();
  console.log("사용 순서:");
  console.log("  1) Claude surface에서 cmux-setup-claude");
  console.log("  2) Codex surface에서 cmux-setup-codex");
  console.log("  3) 작업 repo cwd에서 ccr-enable");
  console.log("  4) Codex에서 /hooks 를 열어 CCR hook을 trust");
  console.log();
  console.log("동작:");
  console.log(
    "  - 세션 데이터는 현재 cwd의 .cmux/ccr/sessions/<session-id>/ 아래에 저장됩니다.",
  );
  console.log(
    "  - 최대 자동 리뷰 라운드는 CCR_MAX_ROUNDS 환경 변수로 조정할 수 있으며 기본값은 3입니다.",
  );
}

// Only run the installer when executed directly (`bun run src/install.ts`).
// Guarding on import.meta.main keeps the module importable from tests (e.g. a
// temp-HOME harness) without performing any filesystem mutations on import.
if (import.meta.main) {
  main();
}
