/**
 * text.ts — pure text/section formatting helpers ported from the CCR runtime
 * (ccr-hook.py) for the Python->Bun migration.
 *
 * Pure functions only: no I/O, no subprocess, deterministic. The differential
 * test compares this module's output against the Python oracle byte-for-byte,
 * so every length/slice/strip operation mirrors Python semantics exactly via
 * the already-validated pycompat foundation:
 *   - byte budgets use utf8ByteLength (len(s.encode("utf-8")))
 *   - codepoint length/slicing use cpLength/cpSlice (Python len + s[:n])
 *   - strip/lstrip/rstrip mirror str.strip/lstrip/rstrip incl. char-set forms
 *
 * Zero dependencies beyond the already-validated foundation module.
 */

import { strip, lstrip, rstrip, utf8ByteLength, cpLength, cpSlice } from "./pycompat";

/**
 * Python (ccr-hook.py:135-139):
 *   value = value.strip() or "unknown"
 *   value = re.sub(r"[^A-Za-z0-9_.-]", "_", value)
 *   if re.fullmatch(r"\.+", value): value = value.replace(".", "_")
 *
 * Python's re operates per Unicode codepoint, so each disallowed codepoint
 * becomes exactly one "_". The "u" flag makes the JS regex match by codepoint
 * too (without it, each UTF-16 surrogate half of an astral character would be
 * replaced separately, yielding two "_" instead of one).
 *
 * "." / ".." (and any all-dots string) are kept verbatim by the allow-list, but
 * they are path-control segments: used as a path component they escape the
 * parent dir (e.g. sessionDir(root, "..") -> root). Remap an all-dots result to
 * underscores so the output is always a safe single path component.
 */
export function sanitize(value: string): string {
  const v = (strip(value) || "unknown").replace(/[^A-Za-z0-9_.-]/gu, "_");
  return /^\.+$/.test(v) ? v.replace(/\./g, "_") : v;
}

/**
 * Python (ccr-hook.py:1468-1471):
 *   return "codex" if role == "claude" else "claude"
 */
export function opposite(role: string): string {
  return role === "claude" ? "codex" : "claude";
}

/** True for the two real agent roles (i.e. not "manual"/"unknown"). */
export function isAgentRole(role: string): boolean {
  return role === "claude" || role === "codex";
}

/**
 * Python `_join_sections` (ccr-hook.py:589-590):
 *   return "\n".join(f"{label}\n{body}\n" for label, body in sections)
 */
export function joinSections(sections: Array<[string, string]>): string {
  return sections.map(([label, body]) => `${label}\n${body}\n`).join("\n");
}

/**
 * Python `_truncate_sections` (ccr-hook.py:593-629).
 *
 * Drops trailing sections (keeping >= 2) until the joined byte size fits, then
 * appends a "# Notice" of omitted labels, then halves the last non-Notice /
 * non-"# Git HEAD" body until it fits, finally falling back to a stub message.
 */
export function truncateSections(
  sections: Array<[string, string]>,
  maxBytes: number,
): string {
  // secs = [list(s) for s in sections] — mutable copies.
  const secs: [string, string][] = sections.map((s) => [s[0], s[1]]);
  const omitted: string[] = [];
  while (secs.length > 2) {
    const candidate = joinSections(secs.map((s) => [s[0], s[1]]));
    if (utf8ByteLength(candidate) <= maxBytes) {
      break;
    }
    const dropped = secs.pop() as [string, string];
    omitted.push(lstrip(dropped[0], "# "));
  }
  if (omitted.length > 0) {
    secs.push([
      "# Notice",
      `Omitted sections to fit CCR_MAX_DIFF_BYTES: ${omitted.join(", ")}`,
    ]);
  }
  let candidate = joinSections(secs.map((s) => [s[0], s[1]]));
  if (utf8ByteLength(candidate) <= maxBytes) {
    return candidate;
  }
  let bodyIdx: number | null = null;
  for (let i = secs.length - 1; i >= 0; i -= 1) {
    if (secs[i][0] !== "# Notice" && secs[i][0] !== "# Git HEAD") {
      bodyIdx = i;
      break;
    }
  }
  if (bodyIdx === null) {
    return candidate;
  }
  const labelName = lstrip(secs[bodyIdx][0], "# ");
  let body = secs[bodyIdx][1];
  while (body) {
    body = cpSlice(body, 0, Math.max(1, Math.floor(cpLength(body) / 2)));
    secs[bodyIdx][1] =
      body + `\n# ... ${labelName} truncated to fit CCR_MAX_DIFF_BYTES\n`;
    candidate = joinSections(secs.map((s) => [s[0], s[1]]));
    if (utf8ByteLength(candidate) <= maxBytes) {
      return candidate;
    }
    if (cpLength(body) <= 1) {
      break;
    }
  }
  if (utf8ByteLength(candidate) > maxBytes) {
    const stub = `# Diff omitted: combined size exceeded CCR_MAX_DIFF_BYTES (${maxBytes} bytes) even after truncation.\n`;
    if (utf8ByteLength(stub) <= maxBytes) {
      return stub;
    }
    return "";
  }
  return candidate;
}

/**
 * Python `_truncate_text` (ccr-hook.py:828-831):
 *   if len(text) <= max_chars: return text
 *   return text[:max_chars] + f"\n\n[truncated to {max_chars} chars]"
 *
 * len()/slice are codepoint-based in Python -> cpLength/cpSlice.
 */
export function truncateText(text: string, maxChars: number = 12000): string {
  if (cpLength(text) <= maxChars) {
    return text;
  }
  return cpSlice(text, 0, maxChars) + `\n\n[truncated to ${maxChars} chars]`;
}

/**
 * Python `_fenced_markdown_block` (ccr-hook.py:844-854).
 *
 * Counts the longest run of backticks in text, picks a fence length of
 * max(3, longest+1), and returns [openFence+language, rstripped text, fence].
 */
export function fencedMarkdownBlock(
  text: string,
  language: string = "markdown",
): string[] {
  let longestRun = 0;
  let cur = 0;
  for (const ch of text) {
    if (ch === "`") {
      cur += 1;
      longestRun = Math.max(longestRun, cur);
    } else {
      cur = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, rstrip(text), fence];
}

/**
 * Python `_format_duration` (ccr-hook.py:1205-1212).
 *   seconds < 0      -> "-"
 *   seconds < 60     -> "{s}s"
 *   seconds < 3600   -> "{m}m {s}s"
 *   otherwise        -> "{h}h {m}m"
 * Integer division -> Math.floor.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) {
    return "-";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
