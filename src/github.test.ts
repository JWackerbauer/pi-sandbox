// Tests for the pure helpers in github.ts (gh hosts file rendering and the
// system-prompt line). The magic-dir provider and gh install need a live VM
// and are not unit-tested here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_MAGIC_DIR,
  type ResolvedGitHubOrg,
} from "./config";
import { githubPromptLine, renderGhHostsYaml } from "./github";

const orgs: ResolvedGitHubOrg[] = [
  { host: "github.com", token: "ghp_abc", magicDir: true },
  { host: "myorg.ghe.com", token: "gho_def", magicDir: false },
];

test("renderGhHostsYaml writes a token per host", () => {
  const yaml = renderGhHostsYaml(orgs);
  assert.match(yaml, /github\.com:/);
  assert.match(yaml, /myorg\.ghe\.com:/);
  assert.match(yaml, /git_protocol: https/);
  assert.match(yaml, /oauth_token: ghp_abc/);
  assert.match(yaml, /oauth_token: gho_def/);
});

test("githubPromptLine is empty when no hosts are configured", () => {
  assert.equal(githubPromptLine([]), "");
});

test("githubPromptLine lists hosts and the magic dir only when enabled", () => {
  const line = githubPromptLine(orgs);
  assert.match(line, /github\.com, myorg\.ghe\.com/);
  // Only github.com has magicDir here, so it is the only host under /git.
  assert.match(line, new RegExp(`${GUEST_MAGIC_DIR}/github\\.com`));
  assert.doesNotMatch(line, new RegExp(`${GUEST_MAGIC_DIR}/myorg\\.ghe\\.com`));
  assert.match(line, /github/);
});

test("githubPromptLine omits the magic-dir clause when no host enables it", () => {
  const line = githubPromptLine([
    { host: "github.com", token: "ghp_abc", magicDir: false },
  ]);
  assert.match(line, /github\.com/);
  assert.doesNotMatch(line, /magic dir/);
});
