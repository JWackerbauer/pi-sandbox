import { test } from "node:test";
import assert from "node:assert/strict";
import { toBranchName } from "./branch-name";

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
