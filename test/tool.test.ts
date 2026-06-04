/**
 * tool.test.ts — classification of Bash commands as mutating vs read-only
 * (feeds the dirty marker that arms an automatic CCR review).
 *
 * Regression focus: read-only redirection idioms (`2>/dev/null`, `2>&1`) must
 * NOT be flagged as mutating — otherwise a purely investigative turn marks the
 * tree dirty and an automatic review fires against a pre-existing diff.
 */
import { test, expect } from "bun:test";
import { bashLooksMutating, shouldMarkDirtyForTool } from "../src/lib/tool.ts";

test("bashLooksMutating: read-only redirects/idioms -> false", () => {
  for (const cmd of [
    "find . -name x 2>/dev/null",
    "cmux identify 2>&1 | head",
    "grep foo bar >/dev/null",
    "cmd >/dev/null 2>&1",
    "cmd &>/dev/null",
    "cat a.txt | grep x",
    "ls -la",
    "git diff --stat",
    "git log --oneline | head",
  ]) {
    expect(bashLooksMutating(cmd)).toBe(false);
  }
});

test("bashLooksMutating: real file writes / package + git mutations -> true", () => {
  for (const cmd of [
    "echo hi > out.txt",
    "cmd >> log.txt",
    "printf x 2>err.log", // stderr to a real file still writes a file
    "rm -rf foo",
    "mv a b",
    "sed -i '' s/a/b/ f",
    "npm install left-pad",
  ]) {
    expect(bashLooksMutating(cmd)).toBe(true);
  }
});

test("shouldMarkDirtyForTool: read-only Bash does not mark dirty", () => {
  expect(shouldMarkDirtyForTool({ tool_name: "Bash", tool_input: { command: "find . 2>/dev/null" } })).toBe(false);
  expect(shouldMarkDirtyForTool({ tool_name: "Read", tool_input: {} })).toBe(false);
});

test("shouldMarkDirtyForTool: mutating tools / Bash writes mark dirty", () => {
  expect(shouldMarkDirtyForTool({ tool_name: "Edit", tool_input: {} })).toBe(true);
  expect(shouldMarkDirtyForTool({ tool_name: "Write", tool_input: {} })).toBe(true);
  expect(shouldMarkDirtyForTool({ tool_name: "Bash", tool_input: { command: "echo x > f" } })).toBe(true);
});
