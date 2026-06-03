/**
 * cli.ts — the Bun CLI entrypoint, Phase 5 of the Python->Bun migration. Mirrors
 * ccr-hook.py `main()` (3748-3843): an argparse-style dispatcher that either runs
 * a `--command X` handler or, in the absence of a command, processes a hook event
 * from stdin.
 *
 * Read-only commands (status/history/events/show/report/preview/config) are
 * ported (Phase 5b); the remaining handlers (5c–5d) throw until ported. The
 * hook path prints the result dict byte-exactly (risk 7): pyJsonCompact +"\n",
 * only when the result is not null, always exiting 0. The CLI is not yet wired
 * into ccr.sh — the installed bins exec the Python runtime until the 5f cutover.
 *
 * Zero npm deps — node:* + lib modules only.
 */

import { readStdinJson, pyJsonCompact, getOrNull } from "./lib/io";
import { handleHook } from "./lib/hooks";
import { parseArgs, ArgError, type CcrArgs } from "./lib/args";
import { commandStatus } from "./commands/status";
import { commandHistory } from "./commands/history";
import { commandEvents } from "./commands/events";
import { commandShow } from "./commands/show";
import { commandReport } from "./commands/report";
import { commandPreview } from "./commands/preview";
import { commandConfig } from "./commands/config";
import { commandEnable } from "./commands/enable";
import { commandDisable } from "./commands/disable";
import { commandReset } from "./commands/reset";
import { commandCancel } from "./commands/cancel";
import { commandSkipNext } from "./commands/skipNext";
import { commandPrune } from "./commands/prune";
import { commandRequest } from "./commands/request";

function dispatchCommand(command: string, args: CcrArgs): number {
  switch (command) {
    case "status":
      return commandStatus();
    case "history":
      return commandHistory(args);
    case "events":
      return commandEvents(args);
    case "show":
      return commandShow(args);
    case "report":
      return commandReport(args);
    case "preview":
      return commandPreview(args);
    case "config":
      return commandConfig(args);
    case "enable":
      return commandEnable();
    case "disable":
      return commandDisable();
    case "reset":
      return commandReset();
    case "cancel":
      return commandCancel();
    case "skip-next":
      return commandSkipNext();
    case "prune":
      return commandPrune(args);
    case "request":
      return commandRequest(args);
    default:
      // ready (5c follow-on) + doctor/check/support/selftest/uninstall (5d).
      throw new Error(`ccr command not yet ported to the Bun CLI: ${command}`);
  }
}

/**
 * Mirror ccr-hook.py `main()`. Returns the process exit code. The hook path
 * always returns 0 (matching Python); printing the result dict is the only
 * observable output and is byte-exact.
 */
export function runCli(argv: string[]): number {
  let args: CcrArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(String(e.message) + "\n");
      return 2;
    }
    throw e;
  }

  if (args.command !== null) {
    return dispatchCommand(args.command, args);
  }

  const inputData = readStdinJson();
  const event = args.event || String(getOrNull(inputData, "hook_event_name") || "");
  if (!args.agent || !event) {
    return 0;
  }
  const result = handleHook(args.agent, event, inputData);
  if (result !== null) {
    process.stdout.write(pyJsonCompact(result) + "\n");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
