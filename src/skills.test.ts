// Tests for skill rendering and the rendered-skill path check (src/skills.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHostServedPath, renderedSkillPaths } from "./skills";

test("isHostServedPath matches paths inside any of the given roots", () => {
  const skillsDir = "/tmp/gondolin-sandbox/skills-1234";
  const globalSkills = "/home/user/.pi/agent/skills";
  const roots = [skillsDir, globalSkills];
  assert.equal(isHostServedPath("/host/cwd", skillsDir, roots), true);
  assert.equal(isHostServedPath("/host/cwd", `${skillsDir}/sandbox.md`, roots), true);
  assert.equal(
    isHostServedPath("/host/cwd", `${globalSkills}/pdf-tools/SKILL.md`, roots),
    true,
  );
  // A relative path that resolves outside the roots does not match.
  assert.equal(
    isHostServedPath("/host/cwd", ".pi/skills/gondolin/sandbox.md", roots),
    false,
  );
  // A sibling dir sharing the prefix is not inside the skills dir.
  assert.equal(isHostServedPath("/host/cwd", `${skillsDir}-2/sandbox.md`, roots), false);
});

test("renderedSkillPaths renders templates into a fresh per-process temp dir", () => {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-template-"));
  fs.writeFileSync(path.join(templateDir, "a.md"), "hello {{name}}");
  fs.writeFileSync(path.join(templateDir, "notes.txt"), "not a template");
  fs.mkdirSync(path.join(templateDir, "nested"));

  const out = renderedSkillPaths(templateDir, { name: "world" });
  assert.ok(out.startsWith(os.tmpdir()));
  assert.equal(fs.readFileSync(path.join(out, "a.md"), "utf8"), "hello world");
  // Non-.md files and directories are not copied.
  assert.deepEqual(fs.readdirSync(out), ["a.md"]);
});

test("renderedSkillPaths returns an empty dir for a missing template dir", () => {
  const out = renderedSkillPaths(
    path.join(os.tmpdir(), "no-such-template-dir-xyz"),
    {},
  );
  assert.ok(fs.existsSync(out));
  assert.deepEqual(fs.readdirSync(out), []);
});
