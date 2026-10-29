// Tests for skill rendering and the rendered-skill path check (src/skills.ts).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isHostServedPath,
  renderedSkillPaths,
  skillNames,
  stubSkillPaths,
  buildSkillContext,
} from "./skills";

const FRONT_MATTER = "---\nname: a\ndescription: a test skill\n---\n";

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

test("buildSkillContext surfaces magic and gh CLI hosts from the github config", () => {
  const ctx = buildSkillContext({
    github: [
      { host: "github.com", magicDir: true, ghCliToken: "literal-token" },
      { host: "myorg.ghe.com", magicDir: true },
    ],
    secrets: { NPM_TOKEN: { hosts: ["registry.npmjs.org"] } },
  });
  // magic_hosts / gh_cli_hosts come from the github config.
  assert.equal(ctx.magic_hosts, "github.com, myorg.ghe.com");
  assert.equal(ctx.gh_cli_hosts, "github.com");
  // github_hosts is the union of secrets hosts + magic + gh CLI hosts.
  assert.equal(ctx.github_hosts, "github.com, myorg.ghe.com, registry.npmjs.org");
  assert.equal(ctx.secrets, "NPM_TOKEN");
});

test("buildSkillContext is empty of github hosts when none are configured", () => {
  const ctx = buildSkillContext({});
  assert.equal(ctx.github_hosts, "");
  assert.equal(ctx.magic_hosts, "");
  assert.equal(ctx.gh_cli_hosts, "");
});

test("skillNames lists the skill templates (front-matter .md files), sorted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-skills-"));
  fs.writeFileSync(path.join(dir, "subagents.md"), FRONT_MATTER + "body");
  fs.writeFileSync(path.join(dir, "sandbox.md"), FRONT_MATTER + "body");
  // A plain .md without front matter is not a skill template.
  fs.writeFileSync(path.join(dir, "plain.md"), "no front matter");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a template");
  fs.mkdirSync(path.join(dir, "nested"));
  assert.deepEqual(skillNames(dir), ["sandbox", "subagents"]);
});

test("skillNames returns [] for a missing directory", () => {
  assert.deepEqual(skillNames(path.join(os.tmpdir(), "no-such-dir-xyz")), []);
});

test("stubSkillPaths stubs only the skill templates", () => {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-stub-"));
  fs.writeFileSync(path.join(templateDir, "a.md"), FRONT_MATTER + "body");
  fs.writeFileSync(path.join(templateDir, "plain.md"), "no front matter");

  const out = stubSkillPaths(templateDir);
  assert.deepEqual(fs.readdirSync(out), ["a.md"]);
  const stub = fs.readFileSync(path.join(out, "a.md"), "utf8");
  assert.ok(stub.startsWith(FRONT_MATTER));
  assert.ok(stub.includes("/build-in-sandbox"));
});

test("renderedSkillPaths renders templates into a fresh per-process temp dir", () => {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-template-"));
  fs.writeFileSync(path.join(templateDir, "a.md"), FRONT_MATTER + "hello {{name}}");
  // A plain .md without front matter is not a skill template.
  fs.writeFileSync(path.join(templateDir, "plain.md"), "no front matter");
  fs.writeFileSync(path.join(templateDir, "notes.txt"), "not a template");
  fs.mkdirSync(path.join(templateDir, "nested"));

  const out = renderedSkillPaths(templateDir, { name: "world" });
  assert.ok(out.startsWith(os.tmpdir()));
  assert.equal(
    fs.readFileSync(path.join(out, "a.md"), "utf8"),
    FRONT_MATTER + "hello world",
  );
  // Non-.md files, front-matter-less .md files, and directories are skipped.
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
