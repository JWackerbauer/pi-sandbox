// Tests for the sandbox preamble rendering (src/preamble.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PREAMBLE_TEMPLATE_FILE, renderPreamble, skillNames } from "./preamble";

// A package-shaped temp dir with a minimal preamble template, so the tests
// do not depend on the package's own templates/ directory.
function makePackageDir(template: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-preamble-"));
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "templates", PREAMBLE_TEMPLATE_FILE),
    template,
  );
  return dir;
}

test("renderPreamble interpolates branch and guest workspace", () => {
  const pkg = makePackageDir("cwd: {{workspace}} branch: {{branch}}");
  const out = renderPreamble(pkg, "my-branch", []);
  assert.equal(out, "cwd: /my-branch branch: my-branch");
});

test("renderPreamble backticks the skill names and joins them", () => {
  const pkg = makePackageDir("skills: {{skills}}");
  const out = renderPreamble(pkg, "b", ["sandbox", "subagents"]);
  assert.equal(out, "skills: `sandbox`, `subagents`");
});

test("renderPreamble omits the skills line when there are no skills", () => {
  const pkg = makePackageDir(
    "start{{#skills}} more: {{skills}}.{{/skills}}end",
  );
  assert.equal(renderPreamble(pkg, "b", []), "startend");
});

test("renderPreamble collapses blank-line runs and trims the result", () => {
  const pkg = makePackageDir("a\n\n\n\nb\n");
  assert.equal(renderPreamble(pkg, "b", []), "a\n\nb");
});

test("skillNames lists sorted .md names without extensions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-skills-"));
  fs.writeFileSync(path.join(dir, "subagents.md"), "");
  fs.writeFileSync(path.join(dir, "sandbox.md"), "");
  fs.writeFileSync(path.join(dir, "notes.txt"), "");
  fs.mkdirSync(path.join(dir, "nested"));
  assert.deepEqual(skillNames(dir), ["sandbox", "subagents"]);
});

test("skillNames returns [] for a missing directory", () => {
  assert.deepEqual(skillNames(path.join(os.tmpdir(), "no-such-dir-xyz")), []);
});

test("the shipped preamble template renders for a branch", () => {
  // The real package template (templates/preamble.md) must render cleanly.
  const root = path.resolve(__dirname, "..");
  const out = renderPreamble(root, "demo-branch", ["sandbox", "subagents"]);
  assert.ok(out.includes("cwd is now /demo-branch"));
  assert.ok(out.includes("branch: demo-branch"));
  assert.ok(out.includes("`sandbox`, `subagents`"));
});
