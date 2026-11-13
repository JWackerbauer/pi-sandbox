// Tests for the sandbox preamble rendering (src/preamble.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXIT_PREAMBLE_TEMPLATE_FILE,
  PREAMBLE_TEMPLATE_FILE,
  renderExitPreamble,
  renderPreamble,
} from "./preamble";

// A temp dir with a minimal preamble template (the package's templates/ dir
// shape), so the tests do not depend on the package's own templates.
function makeTemplateDir(template: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-preamble-"));
  fs.writeFileSync(path.join(dir, PREAMBLE_TEMPLATE_FILE), template);
  return dir;
}

test("renderPreamble interpolates branch and guest workspace", () => {
  const dir = makeTemplateDir("cwd: {{workspace}} branch: {{branch}}");
  const out = renderPreamble(dir, "my-branch", []);
  assert.equal(out, "cwd: /my-branch branch: my-branch");
});

test("renderPreamble backticks the skill names and joins them", () => {
  const dir = makeTemplateDir("skills: {{skills}}");
  const out = renderPreamble(dir, "b", ["sandbox", "subagents"]);
  assert.equal(out, "skills: `sandbox`, `subagents`");
});

test("renderPreamble omits the skills line when there are no skills", () => {
  const dir = makeTemplateDir(
    "start{{#skills}} more: {{skills}}.{{/skills}}end",
  );
  assert.equal(renderPreamble(dir, "b", []), "startend");
});

test("renderPreamble collapses blank-line runs and trims the result", () => {
  const dir = makeTemplateDir("a\n\n\n\nb\n");
  assert.equal(renderPreamble(dir, "b", []), "a\n\nb");
});

// The shipped templates (templates/preamble.md, templates/exit-preamble.md)
// are covered by the behavior test (session-linearity.test.ts), which
// asserts the content of the rendered messages the agent actually receives.

test("renderExitPreamble interpolates branch and host cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-preamble-"));
  fs.writeFileSync(
    path.join(dir, EXIT_PREAMBLE_TEMPLATE_FILE),
    "cwd: {{cwd}} branch: {{branch}}",
  );
  const out = renderExitPreamble(dir, "my-branch", "/host/repo");
  assert.equal(out, "cwd: /host/repo branch: my-branch");
});

test("renderExitPreamble collapses blank-line runs and trims the result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-preamble-"));
  fs.writeFileSync(path.join(dir, EXIT_PREAMBLE_TEMPLATE_FILE), "a\n\n\n\nb\n");
  assert.equal(renderExitPreamble(dir, "b", "/c"), "a\n\nb");
});
