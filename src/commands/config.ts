/**
 * config.ts — `ccr-config`. Faithful port of ccr-hook.py _config_doc
 * (2641-2684) + command_config (2687-2710): print the effective CCR config
 * (env-driven settings, runtime commands, excluded paths), as text or --json.
 */
import { loadJson } from "../lib/io";
import { rootForCwd, workspaceId, surfaceId, CONFIG_ROOT, ENABLED_FILE } from "../lib/paths";
import {
  MAX_ROUNDS, MAX_UNTRACKED_BYTES, MAX_DIFF_BYTES, MIN_DIFF_LINES, STALE_ACTIVE_SECONDS,
  CCR_DEFAULTS, RUNTIME_COMMANDS, GENERATED_BIN_NAMES, GENERATED_CLAUDE_COMMAND_FILES,
  SENSITIVE_SUFFIXES, SENSITIVE_BASENAMES, promptGateMode,
} from "../lib/constants";
import { cpCompare } from "../lib/pycompat";
import type { CcrArgs } from "../lib/args";
import { out } from "./shared";

const EXCLUDED_PATHS = [
  ".cmux/ccr/", ".git/", ".env*", "node_modules/", "dist/", "build/",
  ".next/", ".venv/", "DerivedData/", ".open-research/logs/",
];

export function configDoc(cwd: string): Record<string, unknown> {
  const root = rootForCwd(cwd);
  const values: Record<string, string> = {
    CCR_MAX_ROUNDS: String(MAX_ROUNDS),
    CCR_MAX_UNTRACKED_BYTES: String(MAX_UNTRACKED_BYTES),
    CCR_MAX_DIFF_BYTES: String(MAX_DIFF_BYTES),
    CCR_MIN_DIFF_LINES: String(MIN_DIFF_LINES),
    CCR_STALE_ACTIVE_SECONDS: String(STALE_ACTIVE_SECONDS),
    CCR_PROMPT_GATE: promptGateMode(),
    CCR_ROOT: root,
  };
  const env: Record<string, Record<string, string>> = {};
  for (const key of Object.keys(values)) {
    env[key] = {
      value: values[key]!,
      source: Object.prototype.hasOwnProperty.call(process.env, key) ? "env" : "default",
      default: CCR_DEFAULTS[key] ?? "",
    };
  }
  return {
    version: 1,
    cwd,
    workspace_id: workspaceId() || "",
    surface_id: surfaceId() || "",
    config_root: CONFIG_ROOT,
    enabled_file: ENABLED_FILE,
    ccr_root: root,
    environment: env,
    runtime_commands: RUNTIME_COMMANDS,
    generated_commands: GENERATED_BIN_NAMES,
    generated_claude_commands: GENERATED_CLAUDE_COMMAND_FILES,
    excluded_paths: EXCLUDED_PATHS,
    sensitive_suffixes: [...SENSITIVE_SUFFIXES],
    sensitive_basenames: [...SENSITIVE_BASENAMES].sort(cpCompare),
  };
}

export function commandConfig(args: CcrArgs): number {
  const cwd = process.cwd();
  const doc = configDoc(cwd);
  if (args.json_output) {
    out(JSON.stringify(doc, null, 2));
    return 0;
  }
  out("CCR Config");
  out(`Cwd: ${doc.cwd}`);
  out(`CCR root: ${doc.ccr_root}`);
  out(`Config root: ${doc.config_root}`);
  out(`Workspace: ${doc.workspace_id || "-"}`);
  out(`Surface: ${doc.surface_id || "-"}`);
  out();
  out("Environment:");
  const env = doc.environment as Record<string, Record<string, string>>;
  for (const key of Object.keys(env)) {
    const item = env[key]!;
    out(`- ${key}=${item.value} (${item.source}; default ${item.default})`);
  }
  out();
  out("Runtime commands:");
  for (const name of doc.runtime_commands as string[]) {
    out(`- ${name}`);
  }
  out();
  out("Excluded paths:");
  for (const path of doc.excluded_paths as string[]) {
    out(`- ${path}`);
  }
  return 0;
}
