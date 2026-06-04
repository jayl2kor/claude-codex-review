# CCR Validation Guide

Use this guide before sharing CCR changes with another repository, teammate, or support channel. For implementation structure, see [architecture.md](architecture.md). For rollout policy, see [rollout.md](rollout.md). For script-friendly command examples, see [automation.md](automation.md). For copy-paste validation handoffs, see [templates.md](templates.md). For post-upgrade checks, see [upgrade.md](upgrade.md).

## Validation Levels

| Change Type | Minimum Checks |
|---|---|
| Documentation only | Markdown fence-balance check, link/keyword checks for the edited docs, and `rg` for stale command names. |
| `ccr.sh` logic | `bash -n ccr.sh`, isolated install, and `ccr-selftest --json`. |
| Generated commands or slash commands | Isolated install, `ccr-help`, command `--help`, `ccr-doctor --json`, and `ccr-selftest --json`. |
| Setup/routing behavior | `ccr-check --json`, `ccr-ready --json`, and `ccr-preview --json` in a target git repository. |
| Support or privacy behavior | `ccr-support --print` without payloads, then an explicit `--include-diffs` check only with safe sample data. |
| Retention behavior | `ccr-prune --json` dry-run first, then `ccr-prune --apply --json` only in a disposable state root. |
| TypeScript port (`src/`, `scripts/`, `test/`) | `bun test`, `bun run check:sync`, and `bun run typecheck`. |

## Baseline Script Checks

Run from the CCR repository:

```sh
bash -n ccr.sh
```

Run an isolated install so generated files, hooks, and wrappers are created in a disposable home:

```sh
tmp_home=$(mktemp -d /tmp/ccr-home.XXXXXX)
HOME="$tmp_home" bash ccr.sh
HOME="$tmp_home" PATH="$tmp_home/.local/bin:$PATH" ccr-selftest --json
HOME="$tmp_home" PATH="$tmp_home/.local/bin:$PATH" ccr-help
```

Expected result:

- installer self-test prints `ccr-hook self-test OK`,
- `ccr-selftest --json` reports zero failures,
- `ccr-help` mentions first-run setup, diagnostics, and docs entry points.

## Bun Gates

The JS migration ships a Bun project alongside `ccr.sh`. When you touch `src/`,
`scripts/`, `test/`, or the extracted `templates/` tree, run the Bun gates from
the CCR repository root:

```sh
bun test          # golden + differential tests + CCR loop integration harness (test/loop.test.ts)
bun run check:sync # drift guard: templates/ is byte-identical to ccr.sh heredocs
bun run typecheck  # tsc --noEmit over src/, scripts/, test/ (real type gate; needs `bun install`)
```

Expected result:

- `bun test` reports zero failures,
- `bun run check:sync` prints `templates/ is byte-identical to ccr.sh heredocs` and exits 0,
- `bun run typecheck` completes with no type errors.

These gates protect the migration invariant: the extracted templates never drift
from `ccr.sh`, and the ported TypeScript keeps producing the same results as the
Python runtime.

## Readiness And Routing Checks

From a target git repository inside a cmux workspace:

```sh
ccr-check --json
ccr-ready --json
ccr-preview --json
```

Use these results as different signals:

- `ccr-check --json`: broad health summary and action list.
- `ccr-ready --json`: strict yes/no readiness gate for automatic routing.
- `ccr-preview --json`: current diff eligibility without mutating CCR state.

If `ccr-ready --json` fails, treat `actions` as the onboarding checklist.

## Support Bundle Checks

Default support bundles should not include request, review, or diff payloads:

```sh
ccr-support --print
```

Use `--include-diffs` only with safe sample data or explicit approval:

```sh
ccr-support --include-diffs --print
```

Verify that the default manifest marks payload inclusion as false, and that payload files appear only in the explicit opt-in bundle.

## Documentation Checks

Verify Markdown code fences before sharing docs, especially when templates contain nested code blocks:

```sh
bun run - <<'JS'
import { readFileSync, readdirSync } from "node:fs";

const docs = readdirSync("docs").filter((f) => f.endsWith(".md")).sort().map((f) => `docs/${f}`);
for (const path of [...docs, "README.md", "TODO.md"]) {
  const stack = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let lineno = 1; lineno <= lines.length; lineno++) {
    const stripped = lines[lineno - 1].replace(/^\s+/, "");
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      const ch = stripped[0];
      let count = 0;
      while (count < stripped.length && stripped[count] === ch) count++;
      if (stack.length === 0) {
        stack.push([ch, count, lineno]);
      } else {
        const [prevCh, prevCount] = stack[stack.length - 1];
        if (ch === prevCh && count >= prevCount) stack.pop();
        else stack.push([ch, count, lineno]);
      }
    }
  }
  if (stack.length) {
    console.error(`unclosed fence in ${path}: ${JSON.stringify(stack)}`);
    process.exit(1);
  }
}
console.log("markdown fence verification OK");
JS
```

When command names, docs entry points, or onboarding flows change, verify links and references:

```sh
rg -n "start-here.md|quickstart.md|examples.md|adoption-checklist.md|faq.md|commands.md|glossary.md|troubleshooting.md|automation.md|rollout.md|security.md|validation.md|templates.md|upgrade.md|release-notes.md|architecture.md" README.md docs ccr.sh
```

For generated command coverage:

```sh
rg -n "ccr-help|ccr-ready|ccr-check|ccr-preview|ccr-support|ccr-selftest|ccr-prune" README.md docs ccr.sh
```

## Release Checklist

- `bash -n ccr.sh` passes.
- Isolated `bash ccr.sh` install passes.
- Isolated `ccr-selftest --json` reports zero failures.
- `ccr-help` points to start-here, quickstart, examples, adoption checklist, FAQ, command reference, troubleshooting, validation, glossary, templates, and upgrade docs.
- `ccr-check --json`, `ccr-ready --json`, and `ccr-preview --json` have been run in at least one target repository.
- `ccr-support --print` excludes payloads by default.
- `ccr-prune` was checked in dry-run mode before any cleanup.
- Markdown fence-balance verification passes for `README.md`, `TODO.md`, and `docs/*.md`.
- README, [index.md](index.md), [README.md](README.md), and `ccr-help` link any new user-facing docs or commands.
