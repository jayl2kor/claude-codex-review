# templates/ — auto-extracted, do NOT hand-edit

This directory is **mechanically extracted from `ccr.sh`** as part of the
in-progress JavaScript/Bun migration of the installer.

Every file under `bin/`, `claude-commands/`, and `config/` is the body of a
`cat > "$VAR/name" <<DELIM` heredoc embedded in `ccr.sh`:

| heredoc target var | extracted to            |
| ------------------ | ----------------------- |
| `$BIN_ROOT`        | `templates/bin/`        |
| `$CLAUDE_COMMANDS` | `templates/claude-commands/` |
| `$CONFIG_ROOT`     | `templates/config/`     |

## `ccr.sh` is still the source of truth

Until **Phase 5** of the migration flips the source of truth over to these
files, `ccr.sh` remains canonical. **Do not hand-edit anything in `templates/`.**
To change an installed artifact, edit the corresponding heredoc in `ccr.sh` and
re-run the extractor so `templates/` is regenerated from the updated source.

## Drift guard

`scripts/check-templates-sync.ts` (Bun, zero runtime dependencies) re-parses
`ccr.sh` with the same heredoc-aware state machine used by the extractor and
asserts that every emitted heredoc body is **byte-identical** to its file here.
It also asserts the expected file count (44). Run it any time:

```sh
bun run scripts/check-templates-sync.ts
```

- Exit `0` — `templates/` is perfectly in sync with `ccr.sh`.
- Exit `1` — a file is missing, extra, or byte-different; the output names each
  problem and the first differing line. Fix by editing `ccr.sh` and
  re-extracting, **never** by editing `templates/`.

This guard exists to prevent two-sources-of-truth drift during the transition.
