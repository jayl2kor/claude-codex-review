/**
 * pycompat.ts — faithful TypeScript reimplementations of the Python string /
 * path semantics that the CCR runtime (ccr-hook.py) relies on.
 *
 * These are the load-bearing primitives of the Python->Bun port: getting them
 * exactly right is what lets the ported pure functions match the Python oracle
 * byte-for-byte. Each helper documents the Python behavior it mirrors.
 *
 * Special characters are constructed from numeric codepoints (never typed as
 * literals) so the source stays pure-ASCII and unambiguous.
 *
 * Zero dependencies — Bun/Node built-ins only.
 */

const fromCps = (cps: number[]): Set<string> =>
  new Set<string>(cps.map((c) => String.fromCodePoint(c)));

// ---------------------------------------------------------------------------
// str.splitlines()
// ---------------------------------------------------------------------------

/**
 * Line boundaries recognized by Python's `str.splitlines()` (str, not bytes).
 * Space is NOT a boundary. "\r\n" is collapsed to a single boundary below.
 *   \n \r \v \f \x1c \x1d \x1e \x85 U+2028 U+2029
 */
const LINE_BOUNDARY = fromCps([
  0x0a, // \n
  0x0d, // \r
  0x0b, // \v
  0x0c, // \f
  0x1c, // file separator
  0x1d, // group separator
  0x1e, // record separator
  0x85, // next line (NEL)
  0x2028, // line separator
  0x2029, // paragraph separator
]);

/**
 * Mirror of Python `str.splitlines()` (keepends=False).
 *
 * Differs from JS `String.split("\n")` in two crucial ways:
 *   1. Splits on the full set of Unicode line boundaries, not just "\n".
 *   2. Does NOT emit a trailing empty string when the text ends with a
 *      boundary: "a\n".splitlines() == ["a"], not ["a", ""].
 */
export function splitlines(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  let start = 0;
  while (i < n) {
    const ch = s[i];
    if (LINE_BOUNDARY.has(ch)) {
      out.push(s.slice(start, i));
      if (ch === "\r" && i + 1 < n && s[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) {
    out.push(s.slice(start));
  }
  return out;
}

// ---------------------------------------------------------------------------
// str.strip() / lstrip() / rstrip()
// ---------------------------------------------------------------------------

/**
 * Characters Python's `str.strip()` (no argument) removes — codepoints for
 * which `str.isspace()` is true: ASCII whitespace plus the common Unicode
 * spaces. CCR inputs are ASCII-dominant, but we include the full set so the
 * port matches Python on any input.
 */
const PY_WHITESPACE = fromCps([
  0x09, // \t
  0x0a, // \n
  0x0b, // \v
  0x0c, // \f
  0x0d, // \r
  0x1c,
  0x1d,
  0x1e,
  0x1f,
  0x20, // space
  0x85, // NEL
  0xa0, // no-break space
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
]);

function inStripSet(ch: string, chars: string | null): boolean {
  if (chars === null) return PY_WHITESPACE.has(ch);
  return chars.includes(ch);
}

/** Python `str.lstrip([chars])`. */
export function lstrip(s: string, chars: string | null = null): string {
  let i = 0;
  while (i < s.length && inStripSet(s[i], chars)) i += 1;
  return s.slice(i);
}

/** Python `str.rstrip([chars])`. */
export function rstrip(s: string, chars: string | null = null): string {
  let j = s.length;
  while (j > 0 && inStripSet(s[j - 1], chars)) j -= 1;
  return s.slice(0, j);
}

/** Python `str.strip([chars])`. */
export function strip(s: string, chars: string | null = null): string {
  return rstrip(lstrip(s, chars), chars);
}

/**
 * Python `str.split()` with NO argument: split on maximal runs of whitespace
 * (the same set as strip()) and discard empty tokens, so leading/trailing and
 * consecutive separators never produce "" entries. Differs from JS
 * `String.split(/\s+/)`, whose `\s` omits U+001C-U+001F and U+0085 (which
 * Python treats as whitespace) and includes U+FEFF (which Python does not).
 */
export function splitWhitespace(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && PY_WHITESPACE.has(s[i])) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !PY_WHITESPACE.has(s[i])) i += 1;
    out.push(s.slice(start, i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// bytes / codepoints
// ---------------------------------------------------------------------------

const UTF8_ENCODER = new TextEncoder();

/** `len(s.encode("utf-8"))` — number of UTF-8 bytes. */
export function utf8ByteLength(s: string): number {
  return UTF8_ENCODER.encode(s).length;
}

/** `len(s)` in Python — number of Unicode codepoints (not UTF-16 units). */
export function cpLength(s: string): number {
  let count = 0;
  for (const _ of s) count += 1;
  return count;
}

/**
 * Python slice `s[start:end]` by codepoint (end optional → to end of string).
 * Negative indices are not supported (the CCR runtime never uses them here).
 */
export function cpSlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

/**
 * Compare two strings the way Python's `sorted()`/`<` does: lexicographically
 * by Unicode codepoint. JS's default `Array.sort()` compares by UTF-16 code
 * unit, which diverges for astral-plane characters (a surrogate-pair codepoint
 * > U+FFFF sorts after U+E000-U+FFFF by codepoint but before them by code unit).
 * Use this comparator wherever Python relies on codepoint ordering.
 */
export function cpCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0) as number;
    const bc = bn.value.codePointAt(0) as number;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

// ---------------------------------------------------------------------------
// pathlib.PurePosixPath
// ---------------------------------------------------------------------------

/**
 * Mirror of `pathlib.PurePosixPath(p).parts`.
 *
 * Semantics that matter for safe_rel_path:
 *   - "." segments are dropped: "a/./b" -> ["a", "b"].
 *   - empty segments (from "//" or trailing "/") are dropped.
 *   - ".." segments are KEPT (pathlib does not resolve them).
 *   - a leading "/" yields a root element "/" as parts[0].
 *   - "" and "." yield [].
 */
export function posixParts(p: string): string[] {
  if (p === "" || p === ".") return [];
  const hasRoot = p.startsWith("/");
  const segs = p.split("/").filter((seg) => seg !== "" && seg !== ".");
  return hasRoot ? ["/", ...segs] : segs;
}

/**
 * Mirror of `pathlib.PurePosixPath(p).name` — the final path component, or ""
 * for the root / an empty path.
 */
export function posixName(p: string): string {
  const parts = posixParts(p);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1];
  return last === "/" ? "" : last;
}
