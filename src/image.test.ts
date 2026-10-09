// Tests for image.ts container-runtime detection (guards the off-Linux
// postBuild path, which must run inside Docker/Podman).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectContainerRuntime } from "./image";

// Build a temp dir containing a single executable `name` that exits 0, so
// execFileSync finds it on PATH and succeeds — standing in for a running
// docker/podman daemon.
function makeBinDir(base: string, name: string | null): string {
  const dir = path.join(base, name ?? "empty");
  fs.mkdirSync(dir, { recursive: true });
  if (name) {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
  }
  return dir;
}

test("detectContainerRuntime prefers docker, falls back to podman, null if none", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-rt-"));
  const withDocker = makeBinDir(tmp, "docker");
  const withPodman = makeBinDir(tmp, "podman");
  const empty = makeBinDir(tmp, null);
  const origPath = process.env.PATH;
  try {
    process.env.PATH = withDocker;
    assert.equal(detectContainerRuntime(), "docker");

    process.env.PATH = withPodman;
    assert.equal(detectContainerRuntime(), "podman");

    // Both present → docker wins (it is checked first).
    process.env.PATH = `${withPodman}:${withDocker}`;
    assert.equal(detectContainerRuntime(), "docker");

    // Neither present (and no real daemon on this minimal PATH) → null.
    process.env.PATH = empty;
    assert.equal(detectContainerRuntime(), null);
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
