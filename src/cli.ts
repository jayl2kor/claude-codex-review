/**
 * cli.ts — the Bun CLI entrypoint, Phase 5 of the Python->Bun migration. Mirrors
 * ccr-hook.py `main()` (3748-3843): an argparse-style dispatcher that either runs
 * a `--command X` handler or, in the absence of a command, processes a hook event
 * from stdin.
 *
 * Phase 5a (this step) implements ONLY the hook path + the byte-exact hook stdout
 * (risk 7). The 20 `command_*` handlers are ported in 5b–5d; until then a
 * `--command` invocation throws (the CLI is not yet wired into ccr.sh — the
 * installed bins still exec the Python runtime until the 5f cutover). The full
 * argparse-parity arg parser (src/lib/args.ts) arrives in 5e; here we extract
 * only the flags the hook path needs.
 *
 * Zero npm deps — node:* + lib modules only.
 */

import { readStdinJson, pyJsonCompact, getOrNull } from "./lib/io";
import { handleHook } from "./lib/hooks";

/** Extract a `--flag value` / `--flag=value` string option from argv (last wins). */
function optValue(argv: string[], flag: string): string | undefined {
  let val: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag) {
      val = argv[i + 1];
      i++;
    } else if (a.startsWith(flag + "=")) {
      val = a.slice(flag.length + 1);
    }
  }
  return val;
}

/**
 * Mirror ccr-hook.py `main()`. Returns the process exit code. The hook path
 * always returns 0 (matching Python); printing the result dict is the only
 * observable output and is byte-exact (compact, unsorted, +"\n", only when the
 * result is not null).
 */
export function runCli(argv: string[]): number {
  const command = optValue(argv, "--command");
  if (command !== undefined) {
    // Ported incrementally in Phase 5b–5d.
    throw new Error(`ccr command not yet ported to the Bun CLI: ${command}`);
  }

  const agent = optValue(argv, "--agent");
  const inputData = readStdinJson();
  const event = optValue(argv, "--event") || String(getOrNull(inputData, "hook_event_name") || "");
  if (!agent || !event) {
    return 0;
  }
  const result = handleHook(agent, event, inputData);
  if (result !== null) {
    process.stdout.write(pyJsonCompact(result) + "\n");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
