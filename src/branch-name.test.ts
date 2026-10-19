import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  describeBranchNameFallback,
  nameFromPrompt,
  requestBranchName,
  requestDistinctBranchName,
  toBranchName,
} from "./branch-name";

test("toBranchName lowercases and kebab-cases", () => {
  assert.equal(toBranchName("Fix The Bug"), "fix-the-bug");
});

test("toBranchName strips leading/trailing and repeated separators", () => {
  assert.equal(toBranchName("--hotfix//urgent--"), "hotfix-urgent");
});

test("toBranchName truncates to 40 chars without trailing dash", () => {
  const name = toBranchName("a".repeat(50));
  assert.equal(name, "a".repeat(40));
  const name2 = toBranchName("x".repeat(39) + "-y");
  assert.ok(name2.length <= 40);
  assert.ok(!name2.endsWith("-"));
});

test("toBranchName falls back to 'build' for empty input", () => {
  assert.equal(toBranchName("!!!"), "build");
  assert.equal(toBranchName(""), "build");
});

test("nameFromPrompt uses the first words of the prompt", () => {
  assert.equal(
    nameFromPrompt("Re-examine the branch naming error handling in detail"),
    "re-examine-the-branch-naming-error",
  );
});

test("nameFromPrompt caps at the max length on a word boundary", () => {
  const name = nameFromPrompt("word ".repeat(20).trim());
  assert.ok(name.length <= 40);
  assert.ok(!name.endsWith("-"));
  assert.equal(name, "word-word-word-word-word-word-word-word");
});

test("nameFromPrompt falls back to 'build' for empty input", () => {
  assert.equal(nameFromPrompt(""), "build");
  assert.equal(nameFromPrompt("   "), "build");
});

test("describeBranchNameFallback describes a prompt-derived name", () => {
  const message = describeBranchNameFallback({
    name: "fix-the-login-bug",
    source: "prompt",
    reason: "the model returned no text (the token budget may have been consumed by thinking)",
  });
  assert.match(message, /model-based branch naming failed: the model returned no text/);
  assert.match(message, /using "fix-the-login-bug" derived from the prompt instead/);
});

test("describeBranchNameFallback describes a unique-suffix name", () => {
  const message = describeBranchNameFallback({
    name: "taken-branch-3",
    source: "model",
    reason: '"taken-branch" was already in use',
  });
  assert.match(message, /"taken-branch" was already in use/);
  assert.match(message, /using "taken-branch-3" \(a unique suffix\)/);
});

// ─── requestBranchName (fake registry) ──────────────────────────────────

type ModelRegistry = ExtensionContext["modelRegistry"];

const fakeModel = {} as Model<any>;

function assistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
  } as AssistantMessage;
}

// A registry whose streamSimple returns a stream resolving to `message`.
// `throw` makes the result reject; `delayMs` delays it.
function fakeRegistry(
  message: AssistantMessage,
  opts: { throw?: boolean; delayMs?: number } = {},
): ModelRegistry {
  return {
    streamSimple: () => ({
      result: async () => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.throw) throw new Error("model call failed");
        return message;
      },
    }),
  } as unknown as ModelRegistry;
}

test("requestBranchName sanitizes the model's answer", async () => {
  const registry = fakeRegistry(assistantMessage("Fix The Bug!"));
  const result = await requestBranchName(fakeModel, registry, "do something");
  assert.equal(result.name, "fix-the-bug");
  assert.equal(result.source, "model");
  assert.equal(result.reason, undefined);
});

test("requestBranchName falls back to the prompt when the model returns no text", async () => {
  // A thinking model that spent its token budget on reasoning returns an
  // empty answer — the name must come from the prompt, not be "build".
  const registry = fakeRegistry(assistantMessage(""));
  const result = await requestBranchName(fakeModel, registry, "Fix the login bug");
  assert.equal(result.name, "fix-the-login-bug");
  assert.equal(result.source, "prompt");
  assert.match(result.reason ?? "", /no text/);
});

test("requestBranchName reports a provider error in the fallback reason", async () => {
  const registry = fakeRegistry(assistantMessage("", "error"));
  const result = await requestBranchName(fakeModel, registry, "Fix the login bug");
  assert.equal(result.name, "fix-the-login-bug");
  assert.equal(result.source, "prompt");
  assert.match(result.reason ?? "", /provider error/);
});

test("requestBranchName reports a rejected call in the fallback reason", async () => {
  const registry = fakeRegistry(assistantMessage("ignored"), { throw: true });
  const result = await requestBranchName(fakeModel, registry, "Fix the login bug");
  assert.equal(result.name, "fix-the-login-bug");
  assert.equal(result.source, "prompt");
  assert.match(result.reason ?? "", /model call failed/);
});

test("requestBranchName reports a timeout in the fallback reason", async () => {
  const registry = fakeRegistry(assistantMessage("too-slow-name"), {
    delayMs: 50,
  });
  const result = await requestBranchName(fakeModel, registry, "Fix the login bug", 10);
  assert.equal(result.name, "fix-the-login-bug");
  assert.equal(result.source, "prompt");
  assert.match(result.reason ?? "", /timed out/);
});

// ─── requestDistinctBranchName ───────────────────────────────────────────

test("requestDistinctBranchName accepts a free name (one model call)", async () => {
  const calls: number[] = [];
  const registry: ModelRegistry = {
    streamSimple: () => ({
      result: async () => {
        calls.push(1);
        return assistantMessage("my-branch");
      },
    }),
  } as unknown as ModelRegistry;
  const result = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async () => false,
  );
  assert.equal(result.name, "my-branch");
  assert.equal(result.source, "model");
  assert.equal(calls.length, 1);
});

test("requestDistinctBranchName retries the model on a collision", async () => {
  const answers = ["taken-branch", "fresh-branch"];
  let i = 0;
  const registry: ModelRegistry = {
    streamSimple: () => ({
      result: async () => assistantMessage(answers[i++] ?? "x"),
    }),
  } as unknown as ModelRegistry;
  const result = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async (n) => n === "taken-branch",
  );
  assert.equal(result.name, "fresh-branch");
  assert.equal(result.source, "model");
});

test("requestDistinctBranchName falls back to a unique suffix when every suggestion collides", async () => {
  const registry = fakeRegistry(assistantMessage("taken-branch"));
  const taken = new Set(["taken-branch", "taken-branch-2"]);
  const result = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async (n) => taken.has(n),
  );
  assert.equal(result.name, "taken-branch-3");
  // The model's name collided and the deterministic suffix was used, so
  // the collision is reported alongside the model's (successful) answer.
  assert.equal(result.source, "model");
  assert.match(result.reason ?? "", /already in use/);
});
