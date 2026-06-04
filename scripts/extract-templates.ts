#!/usr/bin/env bun
/**
 * extract-templates.ts — regenerate the templates/ tree from ccr.sh.
 *
 * ccr.sh is the single source of truth. Its `cat > "$VAR/sub" <<'DELIM'` heredoc
 * blocks are the payloads the installer expands at install time; templates/ is a
 * mechanical, byte-identical extraction of those blocks (so install.ts can copy
 * them). After editing a heredoc in ccr.sh, run this to re-extract, then
 * `check:sync` asserts the two are byte-identical.
 *
 * This is the INVERSE of scripts/check-templates-sync.ts and uses the same
 * heredoc-aware parse. Zero runtime deps (Bun/Node built-ins only).
 *
 * Usage: bun run scripts/extract-templates.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
const SRC = join(REPO, "ccr.sh");
const TPL = join(REPO, "templates");

const VAR_MAP: Record<string, string> = {
  $BIN_ROOT: join(TPL, "bin"),
  $CLAUDE_COMMANDS: join(TPL, "claude-commands"),
  $CONFIG_ROOT: join(TPL, "config"),
};

// matches:  cat > "$VAR/sub/name" <<'DELIM'  (quoted) or <<DELIM (and <<- variants)
const FILE_OPEN =
  /^cat\s*>\s*"(\$[A-Z_]+)\/([^"]+)"\s*<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/;

const raw = readFileSync(SRC, "utf-8");
let lines = raw.split("\n");
if (raw.endsWith("\n")) lines = lines.slice(0, -1);

let written = 0;
const n = lines.length;
let i = 0;
while (i < n) {
  const m = lines[i].match(FILE_OPEN);
  if (m) {
    const [, varName, sub, delim] = m;
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < n) {
      if (lines[j] === delim) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j += 1;
    }
    if (!closed) throw new Error(`heredoc opened at line ${i + 1} (<<${delim}) never closed`);
    const base = VAR_MAP[varName];
    if (!base) throw new Error(`unknown var ${varName} at line ${i + 1}`);
    const dest = join(base, sub);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body.join("\n") + "\n", "utf-8");
    written += 1;
    i = j + 1;
    continue;
  }
  i += 1;
}

console.log(`extracted ${written} files from ccr.sh into templates/`);
