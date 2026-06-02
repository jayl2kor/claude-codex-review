/**
 * io.ts — JSON / text I/O helpers ported from the CCR runtime (ccr-hook.py),
 * Phase 3 of the Python->Bun migration.
 *
 * The serialized output is part of the byte-stable contract (risk 7 in
 * docs/ccr-js-migration-plan.md): state.json / status.json / session.json /
 * dirty.json and events.jsonl must be byte-identical to what the Python runtime
 * writes. Python uses two distinct json.dumps forms:
 *   - write_json:    json.dumps(data, ensure_ascii=False, indent=2) + "\n"
 *   - append_jsonl:  json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n"
 * The indent=2 form is matched exactly by JSON.stringify(data, null, 2). The
 * compact sort_keys form is NOT (JSON.stringify uses ":"/"," with no spaces and
 * never sorts), so pyJsonCompactSorted reproduces Python's ", " / ": "
 * separators and recursive key sorting.
 *
 * Ported from ccr-hook.py: now (98-99), load_json (102-108), write_json
 * (111-115), append_jsonl (118-121), read_text (152-156).
 *
 * Zero npm deps — node:fs / node:path / pycompat only.
 */

import {
  readFileSync,
  renameSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { strip, cpCompare } from "./pycompat";

/** Treat a thrown fs error as "file not found" the way Python catches FileNotFoundError. */
function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

/** writeSync may short-write; loop until the whole buffer is flushed. */
export function writeAllSync(fd: number, data: string): void {
  const buf = Buffer.from(data, "utf-8");
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

/**
 * Atomically write `data` to `path`: a FULL write into an unpredictable random
 * temp created with O_EXCL ("wx", no-follow), then renameSync into place — which
 * replaces the destination NAME, so a symlink AT the destination is replaced,
 * never followed. The temp is removed on ANY failure (open/write/close/rename).
 * Shared by writeJson and computeDeltaPatch; Python mirrors it with
 * tempfile.mkstemp + os.replace.
 */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  let closed = false;
  try {
    writeAllSync(fd, data);
    closeSync(fd);
    closed = true;
    renameSync(tmp, path);
  } catch (err) {
    if (!closed) {
      try {
        closeSync(fd);
      } catch {
        /* fd already closed or invalid */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Python `now` (98-99): time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()).
 * UTC, second precision, trailing "Z" — no milliseconds.
 */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Python `load_json` (102-108): json.loads(read_text); FileNotFoundError or
 * JSONDecodeError -> default. Other OS errors propagate (e.g. IsADirectoryError,
 * PermissionError), matching Python which only catches those two.
 */
export function loadJson<T = unknown>(path: string, dflt: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if (isENOENT(err)) {
      return dflt;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return dflt;
  }
}

/**
 * Python `write_json` (111-122): mkdir parents, write atomically via a temp +
 * rename. To avoid following a hostile pre-existing temp symlink, the temp uses
 * an UNPREDICTABLE random name created with O_EXCL ("wx", no-follow); it is
 * removed on ANY failure (write/close/rename). renameSync replaces the
 * destination NAME, so a symlink AT the destination is replaced rather than
 * followed. (Python mirrors this with tempfile.mkstemp + os.replace.) The final
 * bytes are unchanged, so state.json output stays byte-stable.
 */
export function writeJson(path: string, data: unknown): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

// O_APPEND|O_CREAT|O_WRONLY plus O_NOFOLLOW so a hostile symlink planted at the
// final path component is refused (openSync raises ELOOP) rather than appended
// THROUGH. Mirrors the Python helper's os.open(..., O_NOFOLLOW).
const APPEND_FLAGS =
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_WRONLY |
  fsConstants.O_NOFOLLOW;

/**
 * Python `append_jsonl` (118-124): append one compact, key-sorted JSON line via
 * a no-follow open so a pre-planted `events.jsonl` symlink cannot redirect the
 * append to an arbitrary target.
 */
export function appendJsonl(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, APPEND_FLAGS, 0o600);
  try {
    writeAllSync(fd, pyJsonCompactSorted(data) + "\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * Python `read_text` (152-156): read + str.strip(); FileNotFoundError -> "".
 */
export function readText(path: string): string {
  try {
    return strip(readFileSync(path, "utf-8"));
  } catch (err) {
    if (isENOENT(err)) {
      return "";
    }
    throw err;
  }
}

/**
 * Reproduce Python `json.dumps(data, ensure_ascii=False, sort_keys=True)`:
 *   - compact, but with Python's default separators ", " (items) and ": " (k/v),
 *   - object keys sorted (codepoint order, matching CPython's str comparison),
 *   - non-ASCII left raw (ensure_ascii=False).
 * String/number/bool/null leaves are delegated to JSON.stringify, whose escaping
 * matches Python's json string escaping for the (ASCII control + quote +
 * backslash) set while leaving everything >= U+0020 raw — identical to
 * ensure_ascii=False.
 */
export function pyJsonCompactSorted(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(pyJsonCompactSorted).join(", ") + "]";
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(cpCompare);
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ": " + pyJsonCompactSorted(obj[k]))
        .join(", ") +
      "}"
    );
  }
  if (value === undefined) {
    // Python has no `undefined`; callers normalize absent dict.get() to null.
    return "null";
  }
  return JSON.stringify(value);
}

/** Mirror Python dict.get(key) default-None: absent/undefined -> null. */
export function getOrNull(obj: Record<string, unknown> | null | undefined, key: string): unknown {
  if (obj == null) {
    return null;
  }
  const v = obj[key];
  return v === undefined ? null : v;
}
