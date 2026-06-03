/**
 * args.ts — a zero-dep replacement for the argparse parser in ccr-hook.py
 * `main()` (3748-3789). Produces the same `args` namespace (Python dest names,
 * defaults, types, choices) that the command_* handlers read.
 *
 * Fidelity scope: option values, defaults, `action="append"` (default None →
 * null here), `type=int`, `store_true`/`store_false`, and `choices` validation
 * are reproduced. KNOWN DIVERGENCE: argparse's exact usage/error TEXT and prefix
 * abbreviation are NOT reproduced — an invalid choice / bad int / unknown flag /
 * missing value throws ArgError, which the CLI maps to exit code 2 (matching
 * argparse's exit code, not its stderr wording). The generated bins always pass
 * full, valid flags, so this is exercised only on malformed manual input.
 *
 * Zero npm deps — pure.
 */

const COMMANDS = [
  "enable", "disable", "reset", "status", "request",
  "cancel", "history", "show", "uninstall", "skip-next",
  "report", "doctor", "support", "ready", "selftest", "preview", "prune", "config", "events", "check",
];
const REVIEW_TYPES = [
  "code_review", "architecture_review", "design_review",
  "test_plan_review", "security_review", "general_review",
];

export interface CcrArgs {
  agent: string | null;
  event: string | null;
  command: string | null;
  reviewer: string;
  type: string;
  title: string | null;
  file: string[] | null;
  dir: string[] | null;
  question: string[] | null;
  note: string[] | null;
  purpose: string | null;
  non_goal: string | null;
  invariant: string | null;
  use_diff: boolean;
  limit: number;
  session: string | null;
  round: number | null;
  review: boolean;
  apply: boolean;
  purge: boolean;
  outcome: string | null;
  print_body: boolean;
  json_output: boolean;
  include_diffs: boolean;
  keep: number | null;
  days: number | null;
}

/** Raised on a parse/validation failure; the CLI maps this to exit code 2. */
export class ArgError extends Error {}

function defaults(): CcrArgs {
  return {
    agent: null, event: null, command: null,
    reviewer: "auto", type: "general_review", title: null,
    file: null, dir: null, question: null, note: null,
    purpose: null, non_goal: null, invariant: null,
    use_diff: false, limit: 20, session: null, round: null,
    review: false, apply: false, purge: false, outcome: null,
    print_body: false, json_output: false, include_diffs: false,
    keep: null, days: null,
  };
}

// flag -> dest for plain string-valued options.
const STRING_FLAGS: Record<string, keyof CcrArgs> = {
  "--agent": "agent", "--event": "event", "--command": "command",
  "--reviewer": "reviewer", "--type": "type", "--title": "title",
  "--purpose": "purpose", "--non-goal": "non_goal", "--invariant": "invariant",
  "--session": "session", "--outcome": "outcome",
};
const APPEND_FLAGS: Record<string, "file" | "dir" | "question" | "note"> = {
  "--file": "file", "--dir": "dir", "--question": "question", "--note": "note",
};
const INT_FLAGS: Record<string, "limit" | "round" | "keep" | "days"> = {
  "--limit": "limit", "--round": "round", "--keep": "keep", "--days": "days",
};
const TRUE_FLAGS: Record<string, keyof CcrArgs> = {
  "--use-diff": "use_diff", "--review": "review", "--apply": "apply",
  "--purge": "purge", "--print": "print_body", "--json": "json_output",
  "--include-diffs": "include_diffs",
};
const CHOICES: Partial<Record<keyof CcrArgs, string[]>> = {
  agent: ["claude", "codex"],
  command: COMMANDS,
  reviewer: ["auto", "claude", "codex"],
  type: REVIEW_TYPES,
};

/** Python `int(str)` for argparse type=int: whole-string signed integer, else error. */
function parseInt10(value: string, flag: string): number {
  const t = value.trim();
  if (!/^[+-]?\d+$/.test(t)) {
    throw new ArgError(`argument ${flag}: invalid int value: '${value}'`);
  }
  return Number.parseInt(t, 10);
}

function checkChoice(dest: keyof CcrArgs, value: string, flag: string): void {
  const choices = CHOICES[dest];
  if (choices && !choices.includes(value)) {
    throw new ArgError(`argument ${flag}: invalid choice: '${value}' (choose from ${choices.join(", ")})`);
  }
}

/**
 * Parse argv (already sliced past the program name) into the CcrArgs namespace.
 * Mirrors the ccr-hook.py main() parser. `--flag value` and `--flag=value` are
 * both accepted for value-taking options.
 */
export function parseArgs(argv: string[]): CcrArgs {
  const out = defaults();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    let flag = tok;
    let inlineVal: string | null = null;
    const eq = tok.indexOf("=");
    if (tok.startsWith("--") && eq !== -1) {
      flag = tok.slice(0, eq);
      inlineVal = tok.slice(eq + 1);
    }

    const takeValue = (): string => {
      if (inlineVal !== null) {
        return inlineVal;
      }
      const v = argv[i + 1];
      if (v === undefined) {
        throw new ArgError(`argument ${flag}: expected one argument`);
      }
      i++;
      return v;
    };

    if (flag === "--no-diff") {
      out.use_diff = false;
      continue;
    }
    if (flag in TRUE_FLAGS) {
      if (inlineVal !== null) {
        throw new ArgError(`argument ${flag}: ignored explicit argument '${inlineVal}'`);
      }
      (out[TRUE_FLAGS[flag]!] as boolean) = true;
      continue;
    }
    if (flag in STRING_FLAGS) {
      const dest = STRING_FLAGS[flag]!;
      const value = takeValue();
      checkChoice(dest, value, flag);
      (out[dest] as string) = value;
      continue;
    }
    if (flag in APPEND_FLAGS) {
      const dest = APPEND_FLAGS[flag]!;
      const value = takeValue();
      if (out[dest] === null) {
        out[dest] = [];
      }
      out[dest]!.push(value);
      continue;
    }
    if (flag in INT_FLAGS) {
      const dest = INT_FLAGS[flag]!;
      out[dest] = parseInt10(takeValue(), flag);
      continue;
    }
    throw new ArgError(`unrecognized arguments: ${tok}`);
  }
  return out;
}
