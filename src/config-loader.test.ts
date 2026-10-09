// Tests for GondolinConfig loading and merging (global + project).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeRepoKey,
  loadGondolinConfig,
  resolvePostBuild,
  resolveSecrets,
} from "./config-loader";

// Create a throwaway dir with a global config at <dir>/gondolin.json and an
// optional project dir with .pi/gondolin.json; returns both paths.
function makeEnv(
  globalCfg: object | null,
  projectCfg: object | null,
): { agentDir: string; localCwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cfg-"));
  const agentDir = path.join(root, "agent");
  const localCwd = path.join(root, "repo");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(localCwd, ".pi"), { recursive: true });
  if (globalCfg) {
    fs.writeFileSync(
      path.join(agentDir, "gondolin.json"),
      JSON.stringify(globalCfg),
    );
  }
  if (projectCfg) {
    fs.writeFileSync(
      path.join(localCwd, ".pi", "gondolin.json"),
      JSON.stringify(projectCfg),
    );
  }
  return { agentDir, localCwd };
}

test("missing config files yield an empty config", () => {
  const { agentDir, localCwd } = makeEnv(null, null);
  const cfg = loadGondolinConfig(localCwd, agentDir);
  assert.equal(cfg.vm, undefined);
  assert.equal(cfg.subagent, undefined);
  assert.equal(cfg.scratch, undefined);
  assert.equal(cfg.postStartup, undefined);
  assert.equal(cfg.postBuild, undefined);
  assert.equal(Object.keys(cfg.secrets ?? {}).length, 0);
});

test("invalid JSON is treated as empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-cfg-"));
  const agentDir = path.join(root, "agent");
  const localCwd = path.join(root, "repo");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(localCwd, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "gondolin.json"), "{ not json");
  const cfg = loadGondolinConfig(localCwd, agentDir);
  assert.equal(cfg.vm, undefined);
  assert.equal(cfg.scratch, undefined);
  assert.equal(Object.keys(cfg.secrets ?? {}).length, 0);
});

test("project values override global values field by field", () => {
  const { agentDir, localCwd } = makeEnv(
    { vm: { memory: "1G", cpus: 2 }, subagent: { memory: "512M" } },
    { vm: { memory: "4G" } },
  );
  const cfg = loadGondolinConfig(localCwd, agentDir);
  assert.deepEqual(cfg.vm, { memory: "4G", cpus: 2 });
  assert.deepEqual(cfg.subagent, { memory: "512M" });
});

test("postStartup is normalized to a string array", () => {
  // A bare string is accepted as a one-command list.
  let env = makeEnv({ postStartup: "npm install" }, null);
  let cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.deepEqual(cfg.postStartup, ["npm install"]);

  // A project string overrides the global list wholesale.
  env = makeEnv(
    { postStartup: ["echo global"] },
    { postStartup: "echo project" },
  );
  cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.deepEqual(cfg.postStartup, ["echo project"]);

  // Non-string entries are dropped; a list left empty is treated as unset.
  env = makeEnv({ postStartup: ["echo hi", 42, null] }, null);
  cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.deepEqual(cfg.postStartup, ["echo hi"]);
  env = makeEnv({ postStartup: [42, null] }, null);
  cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.equal(cfg.postStartup, undefined);

  // Any other shape (object, number, null) is treated as unset — it must
  // never crash a VM launch.
  env = makeEnv({ postStartup: { a: 1 } }, null);
  cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.equal(cfg.postStartup, undefined);
  env = makeEnv({ postStartup: 7 }, null);
  cfg = loadGondolinConfig(env.localCwd, env.agentDir);
  assert.equal(cfg.postStartup, undefined);
});

test("postStartup and postBuild are overridden wholesale", () => {
  const { agentDir, localCwd } = makeEnv(
    {
      postStartup: ["echo global-poststartup"],
      postBuild: { commands: ["apk add ripgrep"] },
    },
    { postStartup: ["echo project-poststartup"] },
  );
  const cfg = loadGondolinConfig(localCwd, agentDir);
  // Project replaces the global postStartup list entirely (no
  // concatenation) and inherits the global postBuild section it does not
  // set.
  assert.deepEqual(cfg.postStartup, ["echo project-poststartup"]);
  assert.deepEqual(cfg.postBuild, { commands: ["apk add ripgrep"] });
});

test("resolvePostBuild is null without a postBuild section", () => {
  const { agentDir, localCwd } = makeEnv(
    { postStartup: ["echo hi"] },
    { postStartup: ["echo hi"] },
  );
  assert.equal(resolvePostBuild(localCwd, agentDir), null);
});

test("resolvePostBuild: project section builds into <repo>/.pi/assets", () => {
  const { agentDir, localCwd } = makeEnv(
    null,
    { postBuild: { commands: ["apk add ripgrep"] } },
  );
  const resolved = resolvePostBuild(localCwd, agentDir);
  assert.deepEqual(resolved?.postBuild, { commands: ["apk add ripgrep"] });
  assert.equal(resolved?.assetDir, path.join(localCwd, ".pi", "assets"));
});

test("resolvePostBuild: global-only section builds into <agentDir>/assets, project overrides wholesale", () => {
  const { agentDir, localCwd } = makeEnv(
    { postBuild: { commands: ["apk add jq"] } },
    { postBuild: { copy: [{ src: "a", dest: "/a" }] } },
  );
  const resolved = resolvePostBuild(localCwd, agentDir);
  assert.deepEqual(resolved?.postBuild, { copy: [{ src: "a", dest: "/a" }] });
  assert.equal(resolved?.assetDir, path.join(localCwd, ".pi", "assets"));

  const { agentDir: g2, localCwd: l2 } = makeEnv(
    { postBuild: { commands: ["apk add jq"] } },
    null,
  );
  const globalOnly = resolvePostBuild(l2, g2);
  assert.deepEqual(globalOnly?.postBuild, { commands: ["apk add jq"] });
  assert.equal(globalOnly?.assetDir, path.join(g2, "assets"));
});

test("secrets merge per key", () => {
  const { agentDir, localCwd } = makeEnv(
    { secrets: { GH_TOKEN: { hosts: ["github.com"] } } },
    { secrets: { NPM_TOKEN: { hosts: ["registry.npmjs.org"] } } },
  );
  const cfg = loadGondolinConfig(localCwd, agentDir);
  assert.equal(Object.keys(cfg.secrets ?? {}).length, 2);
});

test("resolveSecrets skips entries whose env var is unset", () => {
  const { agentDir, localCwd } = makeEnv(
    { secrets: { SET_VAR: { hosts: ["example.com"] }, UNSET_VAR: { hosts: ["example.com"] } } },
    null,
  );
  process.env.SET_VAR = "s3cret";
  delete process.env.UNSET_VAR;
  const cfg = loadGondolinConfig(localCwd, agentDir);
  const resolved = resolveSecrets(cfg);
  assert.equal(resolved.SET_VAR?.value, "s3cret");
  assert.equal(resolved.UNSET_VAR, undefined);
  delete process.env.SET_VAR;
});

test("resolveSecrets prefers a plain value over the env var", () => {
  const { agentDir, localCwd } = makeEnv(
    { secrets: { MY_TOKEN: { hosts: ["example.com"], value: "from-config" } } },
    null,
  );
  process.env.MY_TOKEN = "from-env";
  const cfg = loadGondolinConfig(localCwd, agentDir);
  const resolved = resolveSecrets(cfg);
  assert.equal(resolved.MY_TOKEN?.value, "from-config");
  delete process.env.MY_TOKEN;
});

test("resolveSecrets uses a plain value when the env var is unset", () => {
  const { agentDir, localCwd } = makeEnv(
    { secrets: { MY_TOKEN: { hosts: ["example.com"], value: "from-config" } } },
    null,
  );
  delete process.env.MY_TOKEN;
  const cfg = loadGondolinConfig(localCwd, agentDir);
  const resolved = resolveSecrets(cfg);
  assert.equal(resolved.MY_TOKEN?.value, "from-config");
});

test("resolveSecrets skips entries with no value in config or env", () => {
  const { agentDir, localCwd } = makeEnv(
    { secrets: { EMPTY: { hosts: ["example.com"], value: "" }, MISSING: { hosts: ["example.com"] } } },
    null,
  );
  delete process.env.EMPTY;
  delete process.env.MISSING;
  const cfg = loadGondolinConfig(localCwd, agentDir);
  const resolved = resolveSecrets(cfg);
  assert.equal(resolved.EMPTY, undefined);
  assert.equal(resolved.MISSING, undefined);
});

test("computeRepoKey is stable and path-sensitive", () => {
  const a = computeRepoKey("/tmp/my-repo");
  const b = computeRepoKey("/tmp/my-repo");
  const c = computeRepoKey("/tmp/other-repo");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-z0-9-]+$/);
});
