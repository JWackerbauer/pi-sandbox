// Tests for skill rendering and the rendered-skill path check (src/skills.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRenderedSkillPath, renderedSkillPaths } from "./skills";

test("isRenderedSkillPath matches the skills dir and its files", () => {
  const dir = "/tmp/gondolin-sandbox/skills-1234";
  assert.equal(isRenderedSkillPath("/host/cwd", dir, dir), true);
  assert.equal(isRenderedSkillPath("/host/cwd", `${dir}/sandbox.md`, dir), true);
  // A relative path that resolves outside the skills dir does not match.
  assert.equal(isRenderedSkillPath("/host/cwd", ".pi/skills/gondolin/sandbox.md", dir), false);
  // A sibling dir sharing the prefix is not inside the skills dir.
  assert.equal(isRenderedSkillPath("/host/cwd", `${dir}-2/sandbox.md`, dir), false);
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
