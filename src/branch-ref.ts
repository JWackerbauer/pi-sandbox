// Host-side resolution of a branch name for /sandbox-on-branch.
//
// Maps a local branch name (e.g. `main`) or a remote-tracking branch name
// (e.g. `origin/main`) to the local branch the sandbox will check out as its
// worktree, plus — for a remote branch — the remote ref it is created from,
// and whether that local branch is already checked out in a worktree.
//
// This runs on the host against the shared .git. The guest then creates the
// worktree from the resolved ref at VM launch (see scripts/prepare.sh: an
// existing local branch is checked out as-is; otherwise a new branch is
// created from `WORK_BRANCH_START`).

import { execFile } from "node:child_process";

/** The local branch to check out as the worktree, and how to obtain it. */
export interface ResolvedSandboxBranch {
  /** The local branch name to check out as the worktree. */
  branch: string;
  /**
   * Ref to create the local branch from when it does not exist yet (the
   * remote-tracking branch for a remote input, e.g. `origin/main`). Absent
   * for an existing local branch. The guest ignores this for an existing
   * local branch and checks it out as-is.
   */
  startRef?: string;
  /** True when `branch` is already checked out in a worktree. */
  checkedOut: boolean;
  /** The worktree path where `branch` is checked out (when `checkedOut`). */
  checkedOutAt?: string;
}

// Run a git command at `cwd`. Never throws: a non-zero exit (e.g. a missing
// ref) is reported as `ok: false` so callers can branch on it.
function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (err, stdout) => {
      resolve({ ok: err === null, stdout: stdout ?? "" });
    });
  });
}

/** True when `ref` resolves in the repo at `cwd`. */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  const res = await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
  return res.ok;
}

/** Map of `refs/heads/<name>` → worktree path for every registered worktree. */
async function worktreeBranches(cwd: string): Promise<Map<string, string>> {
  const res = await git(cwd, ["worktree", "list", "--porcelain"]);
  const map = new Map<string, string>();
  if (!res.ok) return map;
  let path: string | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && path !== undefined) {
      map.set(line.slice("branch ".length), path);
    }
  }
  return map;
}

/**
 * Resolve `name` to the local branch /sandbox-on-branch will check out.
 *
 * - A local branch (`refs/heads/<name>`) resolves to itself.
 * - A remote-tracking branch (`refs/remotes/<remote>/<name>`) resolves to the
 *   conventional local name (`<name>`, the `<remote>/` prefix stripped) with
 *   `startRef` set to the remote ref it is created from. If a local branch
 *   with that name already exists, it is checked out as-is (the guest ignores
 *   `startRef` for an existing branch).
 * - Anything else resolves to `null` (no such local or remote branch).
 *
 * The result also reports whether the resolved local branch is already
 * checked out in a worktree (host or guest) — a branch can only live in one
 * worktree at a time, so such a branch cannot be sandboxed.
 */
export async function resolveSandboxBranch(
  cwd: string,
  name: string,
): Promise<ResolvedSandboxBranch | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;

  let branch: string;
  let startRef: string | undefined;
  if (await refExists(cwd, `refs/heads/${trimmed}`)) {
    branch = trimmed;
  } else if (await refExists(cwd, `refs/remotes/${trimmed}`)) {
    const slash = trimmed.indexOf("/");
    branch = slash === -1 ? trimmed : trimmed.slice(slash + 1);
    if (branch.length === 0) return null;
    startRef = trimmed;
  } else {
    return null;
  }

  const checkedOutAt = (await worktreeBranches(cwd)).get(`refs/heads/${branch}`);
  return {
    branch,
    ...(startRef !== undefined ? { startRef } : {}),
    checkedOut: checkedOutAt !== undefined,
    ...(checkedOutAt !== undefined ? { checkedOutAt } : {}),
  };
}

/**
 * The branches /sandbox-on-branch can offer in its selection list: local
 * branches plus remote-tracking branches, minus anything already checked out
 * in a worktree (a branch can live in only one worktree at a time). Local
 * branches come first, then remote branches, each group sorted. Remote
 * branches appear by their remote-ref name (e.g. `origin/feature`); remote
 * `HEAD` symrefs (e.g. `origin/HEAD`) are skipped. A remote branch whose
 * derived local name is checked out is omitted (it can't be sandboxed).
 */
export async function listSandboxableBranches(
  cwd: string,
): Promise<string[]> {
  const checkedOut = await worktreeBranches(cwd);
  const res = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/",
    "refs/remotes/",
  ]);
  const local: string[] = [];
  const remote: string[] = [];
  if (res.ok) {
    for (const line of res.stdout.split("\n")) {
      const refname = line.trim();
      if (refname.startsWith("refs/heads/")) {
        const name = refname.slice("refs/heads/".length);
        if (name.length > 0 && !checkedOut.has(refname)) local.push(name);
      } else if (refname.startsWith("refs/remotes/")) {
        const remoteRef = refname.slice("refs/remotes/".length);
        if (remoteRef.endsWith("/HEAD")) continue; // remote HEAD symref
        const slash = remoteRef.indexOf("/");
        const localName = slash === -1 ? remoteRef : remoteRef.slice(slash + 1);
        if (localName.length > 0 && !checkedOut.has(`refs/heads/${localName}`)) {
          remote.push(remoteRef);
        }
      }
    }
  }
  local.sort();
  remote.sort();
  return [...local, ...remote];
}
