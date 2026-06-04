/**
 * promptgate.test.ts — unit coverage for the prompt-based review gate
 * (CCR_PROMPT_GATE): the prompt classifier, the agent-verdict parser, the
 * hybrid suppress precedence, and the loop-safety invariant.
 */
import { test, expect } from "bun:test";
import { promptWantsReview, suppressReason } from "../src/lib/promptgate.ts";
import { parseReviewVerdict } from "../src/lib/decision.ts";
import { isCcrHandoffPrompt } from "../src/lib/intent.ts";

test("promptWantsReview: change requests -> true (defer to diff gates)", () => {
  for (const p of [
    "implement a retry with backoff",
    "fix the null deref in parser",
    "refactor the auth middleware",
    "add a test for the edge case",
    "make it faster",
    "what does X do, then fix it", // change verb wins over question lead
    "update the README and rename the flag",
  ]) {
    expect(promptWantsReview(p)).toBe(true);
  }
});

test("promptWantsReview: read-only / opt-out -> false (suppress)", () => {
  for (const p of [
    "what does this function do?",
    "explain the auth flow",
    "why is this slow?",
    "show me the config",
    "list the routes",
    "review this PR",
    "don't review this, just tell me the value",
    "no review needed — what is the default?",
  ]) {
    expect(promptWantsReview(p)).toBe(false);
  }
});

test("promptWantsReview: ambiguous / empty -> null (defer)", () => {
  expect(promptWantsReview("")).toBeNull();
  expect(promptWantsReview("thoughts?")).toBeNull();
  expect(promptWantsReview("faster startup please")).toBeNull();
  expect(promptWantsReview("로그 파일 경로")).toBeNull(); // a bare Korean noun phrase: no signal
});

test("promptWantsReview: Korean read-only / opt-out -> false (suppress)", () => {
  for (const p of [
    "이는 왜인가요?", // interrogative at the END (an English-style lead anchor would miss it)
    "왜 느린가요",
    "이 함수 뭐하는거야?",
    "auth 흐름 설명해줘",
    "라우팅 로직 어떻게 동작하나요",
    "현재 설정 보여줘",
    "리뷰는 보내지 말고 값만 알려줘", // explicit opt-out
  ]) {
    expect(promptWantsReview(p)).toBe(false);
  }
});

test("promptWantsReview: Korean change requests -> true (defer to diff gates)", () => {
  for (const p of [
    "파서의 null 참조를 수정해줘",
    "재시도 로직을 구현해주세요",
    "auth 미들웨어를 리팩터링",
    "이 동작을 왜 이렇게 했는지 설명하고 고쳐줘", // change verb wins over the question
    "README 업데이트하고 플래그 이름 변경",
  ]) {
    expect(promptWantsReview(p)).toBe(true);
  }
});

test("parseReviewVerdict: tokens, case, fence/quote, last-match, absence", () => {
  expect(parseReviewVerdict("CCR_REVIEW: request")).toBe("request");
  expect(parseReviewVerdict("done.\nCCR_REVIEW: skip")).toBe("skip");
  expect(parseReviewVerdict("CCR_REVIEW:   skip (no code changed)")).toBe("skip");
  expect(parseReviewVerdict("ccr_review: REQUEST")).toBe("request");
  // fenced / blockquoted verdicts are ignored
  expect(parseReviewVerdict("```\nCCR_REVIEW: skip\n```")).toBeNull();
  expect(parseReviewVerdict("> CCR_REVIEW: skip")).toBeNull();
  // a real later line still wins over a fenced example
  expect(parseReviewVerdict("```\nCCR_REVIEW: skip\n```\nCCR_REVIEW: request")).toBe("request");
  // last match wins (a correction)
  expect(parseReviewVerdict("CCR_REVIEW: request\nCCR_REVIEW: skip")).toBe("skip");
  // absence -> null
  expect(parseReviewVerdict("just a normal reply")).toBeNull();
});

test("suppressReason: full precedence truth table", () => {
  // verdict skip always suppresses (regardless of prompt)
  expect(suppressReason("skip", null)).toBe("agent_verdict_skip");
  expect(suppressReason("skip", true)).toBe("agent_verdict_skip");
  expect(suppressReason("skip", false)).toBe("agent_verdict_skip");
  // verdict request always rescues (overrides a read-only prompt)
  expect(suppressReason("request", false)).toBeNull();
  expect(suppressReason("request", null)).toBeNull();
  // no verdict: prompt read-only suppresses, else proceed
  expect(suppressReason(null, false)).toBe("prompt_gate_readonly");
  expect(suppressReason(null, true)).toBeNull();
  expect(suppressReason(null, null)).toBeNull();
});

test("loop-safety: a verdict line is never a CCR handoff prompt", () => {
  expect(isCcrHandoffPrompt("CCR_REVIEW: skip")).toBe(false);
  expect(isCcrHandoffPrompt("CCR_REVIEW: request")).toBe(false);
});
