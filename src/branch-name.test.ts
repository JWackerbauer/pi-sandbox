import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
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
  assert.equal(
    await requestBranchName(fakeModel, registry, "do something"),
    "fix-the-bug",
  );
});

test("requestBranchName falls back to the prompt when the model returns no text", async () => {
  // A thinking model that spent its token budget on reasoning returns an
  // empty answer — the name must come from the prompt, not be "build".
  const registry = fakeRegistry(assistantMessage(""));
  assert.equal(
    await requestBranchName(fakeModel, registry, "Fix the login bug"),
    "fix-the-login-bug",
  );
});

test("requestBranchName falls back to the prompt on a provider error", async () => {
  const registry = fakeRegistry(assistantMessage("", "error"));
  assert.equal(
    await requestBranchName(fakeModel, registry, "Fix the login bug"),
    "fix-the-login-bug",
  );
});

test("requestBranchName falls back to the prompt when the call rejects", async () => {
  const registry = fakeRegistry(assistantMessage("ignored"), { throw: true });
  assert.equal(
    await requestBranchName(fakeModel, registry, "Fix the login bug"),
    "fix-the-login-bug",
  );
});

test("requestBranchName falls back to the prompt on timeout", async () => {
  const registry = fakeRegistry(assistantMessage("too-slow-name"), {
    delayMs: 50,
  });
  assert.equal(
    await requestBranchName(fakeModel, registry, "Fix the login bug", 10),
    "fix-the-login-bug",
  );
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
  const name = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async () => false,
  );
  assert.equal(name, "my-branch");
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
  const name = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async (n) => n === "taken-branch",
  );
  assert.equal(name, "fresh-branch");
});

test("requestDistinctBranchName falls back to a unique suffix when every suggestion collides", async () => {
  const registry = fakeRegistry(assistantMessage("taken-branch"));
  const taken = new Set(["taken-branch", "taken-branch-2"]);
  const name = await requestDistinctBranchName(
    fakeModel,
    registry,
    "a prompt",
    async (n) => taken.has(n),
  );
  assert.equal(name, "taken-branch-3");
});
