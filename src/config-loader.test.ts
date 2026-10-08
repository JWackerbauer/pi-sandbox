// Tests for GondolinConfig loading and merging (global + project).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeRepoKey,
  loadGondolinConfig,
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
  assert.equal(cfg.commands, undefined);
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

test("commands lists are overridden wholesale per list", () => {
  const { agentDir, localCwd } = makeEnv(
    {
      commands: {
        startup: ["echo global-startup"],
        prepare: ["echo global-prepare"],
      },
    },
    {
      commands: {
        startup: ["echo project-startup"],
      },
    },
  );
  const cfg = loadGondolinConfig(localCwd, agentDir);
  // Project replaces the global startup list entirely (no concatenation)
  // and inherits the global prepare list it does not set.
  assert.deepEqual(cfg.commands?.startup, ["echo project-startup"]);
  assert.deepEqual(cfg.commands?.prepare, ["echo global-prepare"]);
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

test("computeRepoKey is stable and path-sensitive", () => {
  const a = computeRepoKey("/tmp/my-repo");
  const b = computeRepoKey("/tmp/my-repo");
  const c = computeRepoKey("/tmp/other-repo");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-z0-9-]+$/);
});
