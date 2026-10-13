// Tests for the pure helpers in github.ts (gh hosts file rendering and the
// system-prompt line). The magic-dir provider and gh install need a live VM
// (and host-side gh) and are not unit-tested here.

import test from "node:test";
import assert from "node:assert/strict";
import { GUEST_MAGIC_DIR } from "./config";
import { githubPromptLine, renderGhHostsYaml } from "./github";

test("renderGhHostsYaml writes a token per host", () => {
  const yaml = renderGhHostsYaml([
    { host: "github.com", token: "placeholder-abc" },
    { host: "myorg.ghe.com", token: "placeholder-def" },
  ]);
  assert.match(yaml, /github\.com:/);
  assert.match(yaml, /myorg\.ghe\.com:/);
  assert.match(yaml, /git_protocol: https/);
  assert.match(yaml, /oauth_token: placeholder-abc/);
  assert.match(yaml, /oauth_token: placeholder-def/);
});

test("githubPromptLine is empty when no features are configured", () => {
  assert.equal(githubPromptLine([], []), "");
});

test("githubPromptLine lists the magic dir and gh CLI hosts separately", () => {
  const line = githubPromptLine(["github.com"], ["myorg.ghe.com"]);
  // Magic dir: only the magic hosts appear under /git.
  assert.match(line, new RegExp(`${GUEST_MAGIC_DIR}/github\\.com`));
  assert.doesNotMatch(line, new RegExp(`${GUEST_MAGIC_DIR}/myorg\\.ghe\\.com`));
  // gh CLI: usage instructions are included inline.
  assert.match(line, /myorg\.ghe\.com/);
  assert.match(line, /GH_HOST=<host>/);
  assert.match(line, /`github` skill/);
});

test("githubPromptLine omits each feature when its host list is empty", () => {
  // Magic dir only.
  const magicOnly = githubPromptLine(["github.com"], []);
  assert.match(magicOnly, new RegExp(`${GUEST_MAGIC_DIR}/github\\.com`));
  assert.doesNotMatch(magicOnly, /`gh` CLI/);
  // gh CLI only.
  const ghOnly = githubPromptLine([], ["github.com"]);
  assert.match(ghOnly, /`gh` CLI/);
  assert.doesNotMatch(ghOnly, /magic dir/);
});
