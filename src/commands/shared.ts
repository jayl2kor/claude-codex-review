/**
 * shared.ts — tiny helpers common to the ccr command handlers (Phase 5).
 *
 * `out`/`err` mirror Python `print(...)` / `print(..., file=sys.stderr)` (each
 * appends "\n"). `g` mirrors `dict.get(key, default)` (default only when the key
 * is ABSENT). `utcEpochSeconds` parses the fixed "%Y-%m-%dT%H:%M:%SZ" stamp to
 * UTC epoch seconds (the strptime + calendar.timegm path), or null on a bad
 * format (mirroring Python's ValueError → skip).
 */

export function out(line: string = ""): void {
  process.stdout.write(line + "\n");
}

export function err(line: string = ""): void {
  process.stderr.write(line + "\n");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python `dict.get(key, default)`: default ONLY when the key is absent. */
export function g(obj: unknown, key: string, dflt: unknown): unknown {
  if (isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }
  return dflt;
}

/** Parse the fixed "%Y-%m-%dT%H:%M:%SZ" UTC stamp to epoch seconds, or null. */
export function utcEpochSeconds(stamp: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(stamp)) {
    return null;
  }
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : Math.trunc(ms / 1000);
}

/** Current wall-clock epoch seconds (Python `time.time()`, used in subtraction). */
export function nowEpochSeconds(): number {
  return Date.now() / 1000;
}
