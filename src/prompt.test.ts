import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCwdSection, buildPrewarmSystemPrompt } from "./prompt";

const base = {
  branch: "fix-the-bug",
  workspace: "/fix-the-bug",
  developMode: false,
  scratchEnabled: true,
};

test("cwd section names the workspace and branch", () => {
  const section = buildCwdSection(base);
  assert.ok(section.includes("cwd: /fix-the-bug"));
  assert.ok(section.includes("branch: fix-the-bug"));
  assert.ok(section.includes("You must commit all relevant work to your branch (fix-the-bug)"));
});

test("scratch text only appears when scratch is enabled", () => {
  assert.ok(buildCwdSection(base).includes("/scratch is shared"));
  assert.ok(!buildCwdSection({ ...base, scratchEnabled: false }).includes("/scratch is shared"));
});

test("develop mode text only appears when enabled", () => {
  assert.ok(buildCwdSection({ ...base, developMode: true }).includes("under development"));
  assert.ok(!buildCwdSection(base).includes("under development"));
});

test("prewarm system prompt embeds the cwd section verbatim", () => {
  const prompt = buildPrewarmSystemPrompt(base);
  assert.ok(prompt.includes(buildCwdSection(base)));
  assert.ok(prompt.includes("gondolin sandbox"));
});
