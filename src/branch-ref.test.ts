// Tests for resolveSandboxBranch (src/branch-ref.ts): the host-side resolver
// for /sandbox-on-branch. It maps a local or remote branch name to the local
// branch the sandbox checks out (creating a local tracking branch from a
// remote ref when needed) and reports whether that branch is already checked
// out in a worktree.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listSandboxableBranches,
  resolveSandboxBranch,
} from "./branch-ref";
function run(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 15_000 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * A throwaway repo with:
 * - local branch `main` (checked out in the main worktree)
 * - local branch `feature-local` (not checked out)
 * - a local bare remote `origin` with remote-tracking branches
 *   `origin/main` and `origin/feature-remote`
 * - `feature-remote` present ONLY as a remote branch (no local branch)
 */
async function makeRepo(): Promise<{ dir: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-branch-ref-"));
  const remote = path.join(dir, "origin.git");
  try {
    fs.mkdirSync(remote);
    await run(remote, ["init", "-q", "--bare", "-b", "main"]);

    await run(dir, ["init", "-q", "-b", "main"]);
    await run(dir, ["config", "user.email", "test@example.com"]);
    await run(dir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    await run(dir, ["add", "a.txt"]);
    await run(dir, ["commit", "-q", "-m", "init"]);

    await run(dir, ["branch", "feature-local"]);

    // Feature branch that will live only on the remote.
    await run(dir, ["branch", "feature-remote"]);
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    await run(dir, ["add", "b.txt"]);
    await run(dir, ["commit", "-q", "-m", "feature-remote"]);

    await run(dir, ["remote", "add", "origin", remote]);
    await run(dir, ["push", "-q", "origin", "main"]);
    await run(dir, ["push", "-q", "origin", "feature-remote"]);
    // Drop the local copy so `feature-remote` is remote-only.
    await run(dir, ["branch", "-D", "feature-remote"]);
    await run(dir, ["fetch", "-q", "origin"]);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("a local branch resolves to itself; the checked-out main is flagged", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    const main = await resolveSandboxBranch(dir, "main");
    assert.deepEqual(main, {
      branch: "main",
      checkedOut: true,
      checkedOutAt: dir,
    });

    const feature = await resolveSandboxBranch(dir, "feature-local");
    assert.deepEqual(feature, { branch: "feature-local", checkedOut: false });
    assert.equal(feature?.startRef, undefined);
  } finally {
    cleanup();
  }
});

test("a remote branch resolves to its conventional local name with a start ref", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    // `feature-remote` is remote-only: a local branch is created from the
    // remote ref.
    const res = await resolveSandboxBranch(dir, "origin/feature-remote");
    assert.deepEqual(res, {
      branch: "feature-remote",
      startRef: "origin/feature-remote",
      checkedOut: false,
    });
  } finally {
    cleanup();
  }
});

test("a remote branch whose local name exists resolves to the local branch", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    // `origin/main` → local `main`, which exists and is checked out in the
    // main worktree. The start ref is recorded but the guest would ignore it
    // for the existing local branch.
    const res = await resolveSandboxBranch(dir, "origin/main");
    assert.deepEqual(res, {
      branch: "main",
      startRef: "origin/main",
      checkedOut: true,
      checkedOutAt: dir,
    });
  } finally {
    cleanup();
  }
});

test("a branch checked out in a secondary worktree is flagged with its path", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    const wt = `${dir}-wt`;
    await run(dir, ["worktree", "add", "-q", wt, "feature-local"]);
    try {
      const res = await resolveSandboxBranch(dir, "feature-local");
      assert.equal(res?.checkedOut, true);
      assert.equal(res?.checkedOutAt, wt);
    } finally {
      await run(dir, ["worktree", "remove", "--force", wt]);
    }
  } finally {
    cleanup();
  }
});

test("unknown local and remote names resolve to null", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    assert.equal(await resolveSandboxBranch(dir, "nope"), null);
    assert.equal(await resolveSandboxBranch(dir, "origin/nope"), null);
    assert.equal(await resolveSandboxBranch(dir, "  "), null);
  } finally {
    cleanup();
  }
});

// listSandboxableBranches feeds /sandbox-on-branch's no-argument selection
// list: local + remote branches, minus anything already checked out, local
// first then remote (each group sorted), and without the origin/HEAD symref.
test("lists local + remote branches, omitting checked-out ones", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    // main is checked out in the main worktree (omitted); feature-local is a
    // free local branch; origin/main maps to the checked-out local main
    // (omitted); origin/feature-remote is a free remote branch; origin/HEAD
    // is a symref (omitted).
    assert.deepEqual(await listSandboxableBranches(dir), [
      "feature-local",
      "origin/feature-remote",
    ]);
  } finally {
    cleanup();
  }
});

test("a branch checked out in a secondary worktree drops out of the list", async () => {
  const { dir, cleanup } = await makeRepo();
  try {
    const wt = `${dir}-wt`;
    await run(dir, ["worktree", "add", "-q", wt, "feature-local"]);
    try {
      // feature-local is now checked out, so only the remote branch remains.
      assert.deepEqual(await listSandboxableBranches(dir), [
        "origin/feature-remote",
      ]);
    } finally {
      await run(dir, ["worktree", "remove", "--force", wt]);
    }
  } finally {
    cleanup();
  }
});
