import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePrewarmResult } from "./prewarm";

test("pure text answer is usable", () => {
  const result = analyzePrewarmResult({
    content: [{ type: "text", text: "Here is the plan." }],
    stopReason: "end",
  });
  assert.equal(result.usable, true);
  assert.equal(result.text, "Here is the plan.");
  assert.equal(result.hasToolCalls, false);
  assert.equal(result.truncated, false);
  assert.equal(result.error, undefined);
});

test("text plus a tool call block is not usable", () => {
  const result = analyzePrewarmResult({
    content: [
      { type: "text", text: "Let me look at the repo." },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
    ],
    stopReason: "end",
  });
  assert.equal(result.usable, false);
  assert.equal(result.hasToolCalls, true);
  assert.equal(result.text, "Let me look at the repo.");
});

test("unknown block types are treated as non-text (conservative)", () => {
  const result = analyzePrewarmResult({
    content: [
      { type: "text", text: "Hi" },
      { type: "mystery_block" },
    ],
  });
  assert.equal(result.usable, false);
  assert.equal(result.hasToolCalls, true);
});

test("thinking blocks are inert: text + thinking is usable", () => {
  const result = analyzePrewarmResult({
    content: [
      { type: "thinking", text: "hmm" },
      { type: "text", text: "The answer." },
    ],
  });
  assert.equal(result.usable, true);
  assert.equal(result.text, "The answer.");
});

test("truncated answers are not usable", () => {
  const result = analyzePrewarmResult({
    content: [{ type: "text", text: "Incomple" }],
    stopReason: "maxTokens",
  });
  assert.equal(result.usable, false);
  assert.equal(result.truncated, true);
});

test("empty text is not usable", () => {
  const result = analyzePrewarmResult({
    content: [{ type: "text", text: "   " }],
  });
  assert.equal(result.usable, false);
});

test("missing content is not usable", () => {
  const result = analyzePrewarmResult({});
  assert.equal(result.usable, false);
  assert.equal(result.text, "");
});

test("errors are not usable and are surfaced", () => {
  const result = analyzePrewarmResult({
    content: [{ type: "text", text: "partial" }],
    stopReason: "error",
    errorMessage: "provider exploded",
  });
  assert.equal(result.usable, false);
  assert.equal(result.error, "provider exploded");
});

test("multiple text blocks are joined", () => {
  const result = analyzePrewarmResult({
    content: [
      { type: "text", text: "part one\n" },
      { type: "text", text: "part two" },
    ],
  });
  assert.equal(result.usable, true);
  assert.equal(result.text, "part one\n\npart two");
});
