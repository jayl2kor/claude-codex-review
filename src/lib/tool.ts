/**
 * tool.ts — tool-name / tool-command extraction and mutation classification,
 * ported from the CCR runtime (ccr-hook.py) for the Python->Bun migration.
 *
 * Pure functions only: no I/O, no subprocess, deterministic. The differential
 * test compares this module's output against the Python oracle byte-for-byte,
 * so the coercion and isinstance(dict) semantics below are mirrored exactly.
 *
 * KNOWN, INTENTIONAL DIVERGENCE (see docs/ccr-js-migration-plan.md "Known
 * divergences"): when `tool` / `tool_input` is PRESENT but a non-dict value
 * (e.g. tool=null or tool="x", or {tool:{input:null}}), Python's chained
 * `.get("...", {}).get(...)` raises AttributeError, i.e. the hook crashes.
 * This port instead returns "" defensively. Real Claude/Codex hook payloads
 * never send a non-object `tool`/`tool_input`, and crashing inside a hook is
 * strictly worse than degrading to empty — so we deliberately do NOT replicate
 * the crash. (Also: a non-string tool_name/command would render via Python
 * str() as "True"/"None" vs JS String() "true"/"null"; likewise never sent.)
 *
 * Zero dependencies beyond the already-validated foundation module.
 */

import { MUTATING_TOOL_NAMES, MUTATING_BASH_PATTERNS } from "./constants";

type InputData = Record<string, unknown>;

/**
 * Mirror of Python `isinstance(x, dict)`: a plain object that is neither an
 * array nor null. (Python dict has no array analogue, and None is not a dict.)
 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Python (ccr-hook.py 692-693):
 *   str(input_data.get("tool_name") or input_data.get("tool", {}).get("name") or "")
 *
 * Note `input_data.get("tool", {})` defaults to an empty dict, so `.get("name")`
 * is always safe. We guard `tool` with a plain-object check to mirror that the
 * Python default is `{}` (a dict) and any non-dict would have errored / been
 * coerced; here we simply read `.name` when present.
 */
export function toolName(inputData: InputData): string {
  const toolNameVal = inputData["tool_name"];
  const tool = inputData["tool"];
  const fromTool = isPlainObject(tool) ? tool["name"] : undefined;
  return String(toolNameVal || fromTool || "");
}

/**
 * Python (ccr-hook.py 696-703):
 *   tool_input = input_data.get("tool_input")
 *   if isinstance(tool_input, dict):
 *       return str(tool_input.get("command") or "")
 *   tool = input_data.get("tool")
 *   if isinstance(tool, dict):
 *       return str(tool.get("input", {}).get("command") or "")
 *   return ""
 */
export function toolCommand(inputData: InputData): string {
  const toolInput = inputData["tool_input"];
  if (isPlainObject(toolInput)) {
    return String(toolInput["command"] || "");
  }
  const tool = inputData["tool"];
  if (isPlainObject(tool)) {
    const inner = tool["input"];
    const command = isPlainObject(inner) ? inner["command"] : undefined;
    return String(command || "");
  }
  return "";
}

/**
 * Python (ccr-hook.py 679-680):
 *   return any(re.search(pattern, command, flags=re.IGNORECASE)
 *              for pattern in MUTATING_BASH_PATTERNS)
 *
 * MUTATING_BASH_PATTERNS already carry the "i" flag where the Python code passed
 * re.IGNORECASE, and `.test()` provides search semantics (not anchored).
 */
export function bashLooksMutating(command: string): boolean {
  return MUTATING_BASH_PATTERNS.some((re) => re.test(command));
}

/**
 * Python (ccr-hook.py 683-689):
 *   name = tool_name(input_data)
 *   if name in MUTATING_TOOL_NAMES:
 *       return True
 *   if name == "Bash":
 *       return bash_looks_mutating(tool_command(input_data))
 *   return False
 */
export function shouldMarkDirtyForTool(inputData: InputData): boolean {
  const name = toolName(inputData);
  if (MUTATING_TOOL_NAMES.has(name)) {
    return true;
  }
  if (name === "Bash") {
    return bashLooksMutating(toolCommand(inputData));
  }
  return false;
}
