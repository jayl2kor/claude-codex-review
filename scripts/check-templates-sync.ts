#!/usr/bin/env bun
/**
 * Drift guard: asserts that the extracted templates/ tree stays byte-identical
 * to the heredocs still embedded in ccr.sh.
 *
 * During the JS migration ccr.sh remains the SINGLE SOURCE OF TRUTH. The
 * templates/ tree is a mechanical extraction of the `cat > "$VAR/name" <<DELIM`
 * heredoc blocks. This script re-runs the same heredoc-aware parse that the
 * reference extractor (/tmp/extract_ccr.py) uses and compares each emitted
 * heredoc body against the corresponding file under templates/. Any file that
 * is missing, extra, or byte-different fails the check.
 *
 * Parsing rules (mirrors /tmp/extract_ccr.py exactly):
 *   - Walk ccr.sh line-by-line as a heredoc-aware state machine.
 *   - Only the installer's OWN top-level heredoc openers start a capture.
 *     Once an opener is seen, every following line is literal body content
 *     until a line that is EXACTLY the delimiter. That means delimiters that
 *     look like openers but are nested inside an open heredoc are treated as
 *     literal content and never re-matched (no two-sources-of-truth drift).
 *   - `cat > "$VAR/name" <<'DELIM'` -> emitted file (mapped to templates/...).
 *   - `python3 ... <<'DELIM'`        -> install-time inline python (ignored here).
 *   - Reconstructed file content is `body.join("\n") + "\n"`, matching how the
 *     extractor wrote each file (join lines, append a single trailing newline).
 *
 * Zero runtime dependencies: only Bun/Node built-ins. ccr.sh is NEVER modified.
 *
 * Exit 0 if perfectly in sync; exit 1 with a diff summary otherwise.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Repo root is the parent of this script's directory (<repo>/scripts), so the
// drift guard works from any checkout instead of a hardcoded local path.
const REPO = join(import.meta.dir, "..");
const SRC = join(REPO, "ccr.sh");
const TPL = join(REPO, "templates");

const EXPECTED_FILE_COUNT = 44;

// $VAR in the heredoc header -> templates subdirectory root.
const VAR_MAP: Record<string, string> = {
  $BIN_ROOT: join(TPL, "bin"),
  $CLAUDE_COMMANDS: join(TPL, "claude-commands"),
  $CONFIG_ROOT: join(TPL, "config"),
};

// matches:  cat > "$VAR/sub/name" <<'DELIM'   (quoted) or <<DELIM  (and <<- variants)
const FILE_OPEN =
  /^cat\s*>\s*"(\$[A-Z_]+)\/([^"]+)"\s*<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/;
// matches:  python3 <<'PY' | python3 - <<'PY' | python3 - "$A" "$B" <<'PY'
const PY_OPEN = /^python3\b.*<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/;

interface FilePiece {
  varName: string; // e.g. "$BIN_ROOT"
  sub: string; // e.g. "ccr-lib.sh" or "codex-home/AGENTS.md"
  body: string[]; // raw body lines (without trailing newline join)
  openLine: number; // 1-based line number of the opener (for diagnostics)
}

interface PyPiece {
  delim: string; // heredoc delimiter, e.g. "PY" or "SELFTEST"
  body: string[]; // raw body lines (without trailing newline join)
  openLine: number; // 1-based line number of the opener (for diagnostics)
}

interface ParseResult {
  files: FilePiece[];
  pyBlocks: PyPiece[];
}

/**
 * Parse ccr.sh and return every top-level `cat > "$VAR/..."` heredoc block as a
 * file piece, plus every top-level `python3 ... <<DELIM` block as a py piece.
 * Throws on an unterminated heredoc (a structural error in the source).
 */
function parseFileBlocks(raw: string): ParseResult {
  let lines = raw.split("\n");
  // raw ends with a newline -> split yields a trailing "" element; drop it so
  // the line-by-line walk matches the Python reference exactly.
  const trailingNewline = raw.endsWith("\n");
  if (trailingNewline) {
    // last element is the empty string after the final newline
    lines = lines.slice(0, -1);
  }

  const pieces: FilePiece[] = [];
  const pyBlocks: PyPiece[] = [];
  const n = lines.length;
  let i = 0;

  while (i < n) {
    const line = lines[i];
    const mf = line.match(FILE_OPEN);
    const mp = mf ? null : line.match(PY_OPEN);

    if (mf || mp) {
      let delim: string;
      let isFile = false;
      let varName = "";
      let sub = "";
      if (mf) {
        isFile = true;
        varName = mf[1];
        sub = mf[2];
        delim = mf[3];
      } else {
        delim = (mp as RegExpMatchArray)[1];
      }

      // collect body until a line that is EXACTLY the delimiter
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
      if (!closed) {
        throw new Error(
          `heredoc opened at line ${i + 1} (<<${delim}) never closed`,
        );
      }
      if (isFile) {
        pieces.push({ varName, sub, body, openLine: i + 1 });
      } else {
        // py blocks are install-time logic. Most are ported into install.ts and
        // are not template content, but the SELFTEST block is shipped verbatim
        // as templates/selftest-install.py, so we keep them all for matching.
        pyBlocks.push({ delim, body, openLine: i + 1 });
      }
      i = j + 1; // skip past the delimiter line
      continue;
    }
    i += 1;
  }

  return { files: pieces, pyBlocks };
}

/** Recursively list files under a directory, returned as repo-relative paths. */
function listFilesRel(dir: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.add(relative(REPO, full));
    }
  };
  walk(dir);
  return out;
}

/** Show the first differing line between two strings, for a readable diff. */
function firstLineDiff(expected: string, actual: string): string {
  const ea = expected.split("\n");
  const aa = actual.split("\n");
  const max = Math.max(ea.length, aa.length);
  for (let k = 0; k < max; k++) {
    if (ea[k] !== aa[k]) {
      return (
        `    first diff at line ${k + 1}:\n` +
        `      ccr.sh:    ${JSON.stringify(ea[k] ?? "<EOF>")}\n` +
        `      template:  ${JSON.stringify(aa[k] ?? "<EOF>")}`
      );
    }
  }
  return `    (content equal line-wise; byte length differs: ccr.sh=${expected.length} template=${actual.length})`;
}

function main(): number {
  if (!existsSync(SRC)) {
    console.error(`FAIL: source not found: ${SRC}`);
    return 1;
  }

  const raw = readFileSync(SRC, "utf8");
  let parsed: ParseResult;
  try {
    parsed = parseFileBlocks(raw);
  } catch (err) {
    console.error(`FAIL: could not parse ${SRC}: ${(err as Error).message}`);
    return 1;
  }
  const pieces = parsed.files;

  const problems: string[] = [];

  // Files that legitimately live under templates/ but are NOT `cat >` heredoc
  // emissions, so they must not be flagged as "extra" drift.
  const allowedExtraRel = new Set<string>([
    relative(REPO, join(TPL, "README.md")), // human-authored directory note
    relative(REPO, join(TPL, "selftest-install.py")), // derived from SELFTEST block (verified below)
  ]);

  // The install-time selftest ships as templates/selftest-install.py, derived
  // from ccr.sh's `python3 - <<'SELFTEST'` block (header + trailing delimiter
  // stripped). Verify it byte-for-byte so the SELFTEST block can't drift either.
  const selftestRel = relative(REPO, join(TPL, "selftest-install.py"));
  const selftestBlocks = parsed.pyBlocks.filter((b) => b.delim === "SELFTEST");
  if (selftestBlocks.length !== 1) {
    problems.push(
      `SELFTEST  expected exactly 1 \`<<'SELFTEST'\` block in ccr.sh, found ${selftestBlocks.length}`,
    );
  } else {
    const dest = join(TPL, "selftest-install.py");
    const expectedContent = selftestBlocks[0].body.join("\n") + "\n";
    if (!existsSync(dest)) {
      problems.push(
        `MISSING   ${selftestRel} — derived from ccr.sh SELFTEST block (line ${selftestBlocks[0].openLine}) but not on disk`,
      );
    } else {
      const actualContent = readFileSync(dest, "utf8");
      if (actualContent !== expectedContent) {
        problems.push(
          `DIFFERENT ${selftestRel} — differs from ccr.sh SELFTEST block (line ${selftestBlocks[0].openLine})\n` +
            firstLineDiff(expectedContent, actualContent),
        );
      }
    }
  }

  // Every file the parse says ccr.sh emits, mapped to its template path.
  const expectedRel = new Set<string>();

  for (const p of pieces) {
    const base = VAR_MAP[p.varName];
    if (!base) {
      problems.push(
        `UNKNOWN VAR ${p.varName} at ccr.sh line ${p.openLine} (${p.sub}) — no templates/ mapping`,
      );
      continue;
    }
    const dest = join(base, p.sub);
    const rel = relative(REPO, dest);
    expectedRel.add(rel);

    // content as the extractor wrote it: join body lines + single trailing \n
    const expectedContent = p.body.join("\n") + "\n";

    if (!existsSync(dest)) {
      problems.push(
        `MISSING   ${rel} — emitted by ccr.sh (line ${p.openLine}) but no template file on disk`,
      );
      continue;
    }
    if (!statSync(dest).isFile()) {
      problems.push(`NOT A FILE ${rel} — expected a regular file`);
      continue;
    }
    const actualContent = readFileSync(dest, "utf8");
    if (actualContent !== expectedContent) {
      problems.push(
        `DIFFERENT ${rel} — heredoc body (ccr.sh line ${p.openLine}) differs from template file\n` +
          firstLineDiff(expectedContent, actualContent),
      );
    }
  }

  // Any template file NOT produced by an emitted heredoc is "extra" drift.
  const actualRel = listFilesRel(TPL);
  for (const rel of actualRel) {
    // ignore intentional non-heredoc files (README note + the SELFTEST-derived
    // selftest-install.py, which is verified separately above).
    if (allowedExtraRel.has(rel)) continue;
    // ignore transient Python bytecode build noise (regenerated on import,
    // never emitted by ccr.sh — not template content).
    if (rel.includes("__pycache__/") || rel.endsWith(".pyc")) continue;
    if (!expectedRel.has(rel)) {
      problems.push(
        `EXTRA     ${rel} — present under templates/ but not emitted by any ccr.sh heredoc`,
      );
    }
  }

  // Count assertion: the parse must emit exactly the expected number of files.
  const emitted = expectedRel.size;
  if (emitted !== EXPECTED_FILE_COUNT) {
    problems.push(
      `COUNT     expected ${EXPECTED_FILE_COUNT} emitted files, parse found ${emitted}`,
    );
  }

  if (problems.length > 0) {
    console.error("templates/ is OUT OF SYNC with ccr.sh:\n");
    for (const p of problems) console.error("  " + p);
    console.error(
      `\n${problems.length} problem(s). ccr.sh is the source of truth — ` +
        `re-extract templates/ (do NOT hand-edit templates/).`,
    );
    return 1;
  }

  console.log(
    `OK: templates/ is byte-identical to ccr.sh heredocs (${emitted} files verified).`,
  );
  return 0;
}

process.exit(main());
