/**
 * diag.ts — shared helpers for the diagnostic commands (doctor/check/ready/
 * support), Phase 5d. Install-layout + PATH inspection that mirrors the Python
 * runtime's shutil.which / os.access / json-substring probes.
 */
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

import { pyJsonCompact } from "../lib/io";

/** Python `shutil.which(name)` for a bare command name: first PATH hit that is
 * executable and not a directory, else null. Empty PATH entries mean cwd
 * (os.path.join("", name) == name), matching CPython. */
export function which(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isDirectory()) {
        continue;
      }
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not here / not executable */
    }
  }
  return null;
}

/** Python `_is_executable` (2822-2823): is a regular file and X_OK. */
export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Python `_json_file_contains` (2813-2819): parse the JSON file, re-serialize it
 * compact (json.dumps default, ensure_ascii=False == pyJsonCompact), and test for
 * the substring. The re-serialization normalizes whitespace so the needle matches
 * regardless of the file's original formatting. false on read/parse error.
 */
export function jsonFileContains(path: string, needle: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
  return pyJsonCompact(parsed).includes(needle);
}

/** Install layout under the current HOME (Path.home()-derived, bound per process). */
export function installLayout(): { home: string; binRoot: string; claudeSettings: string; codexHooks: string } {
  const home = homedir();
  return {
    home,
    binRoot: join(home, ".local", "bin"),
    claudeSettings: join(home, ".claude", "settings.json"),
    codexHooks: join(home, ".codex", "hooks.json"),
  };
}
