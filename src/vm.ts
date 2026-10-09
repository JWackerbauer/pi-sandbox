import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  VM,
  RealFSProvider,
  createHttpHooks,
} from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  computeRepoKey,
  loadGondolinConfig,
  resolveSecrets,
} from "./config-loader";
import {
  DEFAULT_SUBAGENT_SIZING,
  DEFAULT_VM_SIZING,
  DEFAULT_WORK_BRANCH,
  guestWorkspace,
  GUEST_GIT_DIR,
  GUEST_SCRATCH,
  GUEST_SCRATCH_LOCAL,
  GIT_EMAIL,
  GIT_HOOKS_DIR,
  GIT_NAME,
  hostScratchBranch,
  hostScratchShared,
  PREPARE_SCRIPT,
} from "./config";
import type { CommandHooks } from "./config";

export interface DetachedVmOptions {
  localCwd: string;
  localGitDir: string;
  /** Ref the new work branch is created from. Default: the repo HEAD. */
  branchStart?: string;
  /**
   * Launch with the smaller subagent sizing (config `subagent` / 512M/1 CPU
   * instead of `vm` / 1G/2 CPUs). Subagents run in parallel next to the
   * main VM, so they get less by default.
   */
  isSubagent?: boolean;
}

// Create a standalone VM for the given work branch: mounts the shared .git,
// installs the prepare script and git hook, and runs prepare.sh. On failure
// the half-configured VM is closed and the error is rethrown.
//
// Independent of any GondolinSandbox singleton, so several VMs can run at
// the same time (one per branch/worktree). The caller owns the returned VM.
export async function launchDetachedVm(
  branch: string,
  opts: DetachedVmOptions,
): Promise<VM> {
  const { localCwd, localGitDir, branchStart, isSubagent = false } = opts;

  // The config is a tiny JSON read; loading it per launch keeps this simple
  // and always current.
  const config = loadGondolinConfig(
    localCwd,
    path.join(os.homedir(), ".pi", "agent"),
  );

  // Subagent VMs run in parallel alongside the main VM, so they get the
  // smaller sizing by default. `isSubagent` is not set by the main session's
  // createSandbox, which therefore uses the main sizing.
  const sizing =
    (isSubagent ? config.subagent : config.vm) ??
    (isSubagent ? DEFAULT_SUBAGENT_SIZING : DEFAULT_VM_SIZING);

  // Shared secrets: values come from the host environment, the guest only
  // ever sees placeholders, and requests may only be sent to the hosts
  // listed in the config (see config-loader.ts / Gondolin secret SDK).
  const { httpHooks, env } = createHttpHooks({
    secrets: resolveSecrets(config),
  });

  const mounts: Record<string, RealFSProvider> = {
    [GUEST_GIT_DIR]: new RealFSProvider(localGitDir),
  };
  if (config.scratch !== false) {
    // Scratch dirs live under the host's tempdir so they persist across
    // VM/session restarts. RealFSProvider mounts a real host path, which
    // must exist before the VM starts.
    const repoKey = computeRepoKey(localCwd);
    const tempdir = os.tmpdir();
    const hostShared = hostScratchShared(tempdir, repoKey);
    const hostBranch = hostScratchBranch(tempdir, repoKey, branch);
    fs.mkdirSync(hostShared, { recursive: true });
    fs.mkdirSync(hostBranch, { recursive: true });
    mounts[GUEST_SCRATCH] = new RealFSProvider(hostShared);
    mounts[GUEST_SCRATCH_LOCAL] = new RealFSProvider(hostBranch);
  }

  const moduleRoot = path.resolve(__dirname);
  const created = await VM.create({
    sandbox: {
      imagePath: `${moduleRoot}/../image/assets`,
    },
    memory: sizing.memory,
    cpus: sizing.cpus,
    httpHooks,
    env,
    vfs: {
      mounts,
    },
  });

  try {
    // Install the prepare script and the git hook into the guest.
    await created.fs.writeFile(
      PREPARE_SCRIPT,
      fs.readFileSync(path.join(moduleRoot, "scripts", "prepare.sh")),
    );
    await created.fs.mkdir(GIT_HOOKS_DIR, { recursive: true });
    await created.fs.writeFile(
      path.join(GIT_HOOKS_DIR, "prepare-commit-msg"),
      fs.readFileSync(path.join(moduleRoot, "scripts", "prepare-commit-msg")),
    );
    // User-defined post-boot commands (config `commands.startup`), run
    // before the prepare script so they can prepare the guest for it.
    await runUserCommands(created, config.commands?.startup, "startup");

    // `branch` and `branchStart` are sanitized branch names ([a-z0-9-] only)
    // or commit hashes, so they are safe to interpolate into the shell
    // command. String form runs in /bin/sh -lc "..."
    const startExport = branchStart
      ? `export WORK_BRANCH_START='${branchStart}' &&\\`
      : "";
    const result = await created.exec(`
        export GIT_EMAIL='${GIT_EMAIL}' &&\\
        export GIT_NAME='${GIT_NAME}' &&\\
        export WORK_BRANCH_NAME='${branch}' &&\\
        ${startExport}
        export GUEST_GIT_DIR='${GUEST_GIT_DIR}' &&\\
        export GUEST_WORKSPACE='${guestWorkspace(branch)}' &&\\
        export GIT_HOOKS_DIR='${GIT_HOOKS_DIR}' &&\\
          chmod +x ${PREPARE_SCRIPT} && ${PREPARE_SCRIPT}
      `);

    if (result.exitCode !== 0) {
      const detail =
        [result.stdout.trim(), result.stderr.trim()]
          .filter((d) => d.length > 0)
          .join("\n") || "(no output)";
      throw new Error(
        `gondolin: prepare.sh failed with exit code ${result.exitCode}\n${detail}`,
      );
    }

    // User-defined post-prepare commands (config `commands.prepare`), run
    // after the worktree exists, so they can use /<branch>.
    await runUserCommands(created, config.commands?.prepare, "prepare");
    return created;
  } catch (err) {
    // Tear down the half-configured VM so a retry starts clean, then
    // surface the failure to the caller.
    try {
      await created.close();
    } catch {
      // ignore: the VM is unusable anyway
    }
    throw err;
  }
}

// Remove a detached VM's worktree (and its shared .git registration),
// targeting only that branch's guest path. Best-effort: a crash before this
// runs leaves a stale registration that prepare.sh detects at the next start.

// Run user-defined commands (config `commands.startup` / `commands.prepare`)
// inside the guest, in list order. Each entry is a shell line run via
// /bin/sh -lc. A non-zero exit fails the VM launch with the command output
// surfaced, mirroring the prepare.sh failure behavior — a broken toolchain
// setup should not be silently swallowed.
async function runUserCommands(
  vm: VM,
  commands: CommandHooks["startup"] | undefined,
  label: string,
): Promise<void> {
  for (const cmd of commands ?? []) {
    const result = await vm.exec(cmd);
    if (result.exitCode !== 0) {
      const detail =
        [result.stdout.trim(), result.stderr.trim()]
          .filter((d) => d.length > 0)
          .join("\n") || "(no output)";
      throw new Error(
        `gondolin: ${label} command failed with exit code ${result.exitCode}: ${cmd}\n${detail}`,
      );
    }
  }
}
export async function removeDetachedWorktree(
  vm: VM,
  branch: string,
): Promise<void> {
  const ws = guestWorkspace(branch);
  try {
    await vm.exec([
      "/bin/sh",
      "-lc",
      `git -C ${GUEST_GIT_DIR} worktree remove --force ${ws}`,
    ]);
  } catch {
    // Best effort: a leftover registration is detected by prepare.sh at the
    // next start, which tells the user to prune it manually.
  }
}

export interface GondolinSandbox {
  /** The running VM, if any. */
  readonly vm: VM | null;
  /** The work branch of the running VM, if any. */
  readonly branch: string | null;
  /** The guest workspace of the running VM, if any. */
  readonly workspace: string | null;
  /**
   * Remove this VM's worktree (and its shared .git registration), targeting
   * only this session's branch path. Best-effort: a crash before this runs
   * leaves a stale registration that prepare.sh detects at the next start.
   */
  removeWorktree: () => Promise<void>;
  /**
   * Launch the VM for the given work branch. If a VM is already running
   * for that branch it is returned; a VM running for a different branch
   * is closed and replaced.
   */
  launch: (branch: string, ctx?: ExtensionContext) => Promise<VM>;
  /** The running VM, or one launched for the default work branch. */
  ensureVm: (ctx?: ExtensionContext) => Promise<VM>;
  /** Close the running VM, if any. */
  close: () => Promise<void>;
}

export function createSandbox(
  localCwd: string,
  localGitDir: string,
): GondolinSandbox {
  let vm: VM | null = null;
  let branch: string | null = null;
  let starting: { branch: string; promise: Promise<VM> } | null = null;

  async function doLaunch(
    requested: string,
    ctx?: ExtensionContext,
  ): Promise<VM> {
    try {
      setStatus(ctx, "starting…");
      const created = await launchDetachedVm(requested, {
        localCwd,
        localGitDir,
      });
      vm = created;
      branch = requested;
      setStatus(ctx, requested);
      ctx?.ui.notify(`
        Gondolin VM ready. Branch ${requested} of ${localCwd} created at ${guestWorkspace(requested)}`,
        "info",
      );
      return created;
    } catch (err) {
      branch = null;
      // Drop the "starting" status; the error itself is surfaced by
      // pi to the user.
      ctx?.ui.setStatus("gondolin", undefined);
      throw err;
    }
  }

  async function launch(
    requested: string,
    ctx?: ExtensionContext,
  ): Promise<VM> {
    if (vm && branch === requested) return vm;
    if (starting && starting.branch === requested) return starting.promise;
    if (starting) {
      try {
        await starting.promise;
      } catch {
        // replaced below
      }
    }
    if (vm) await close();

    const entry = { branch: requested, promise: doLaunch(requested, ctx) };
    starting = entry;
    try {
      return await entry.promise;
    } finally {
      if (starting === entry) starting = null;
    }
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    return launch(DEFAULT_WORK_BRANCH, ctx);
  }

  // Selective worktree removal for this session's branch only. Runs in the
  // guest (where the worktree path exists) and targets the exact path, so it
  // never touches other sessions' worktrees. --force: the branch's commits
  // are already in the shared .git, so a dirty worktree is fine to drop.
  async function removeWorktree(): Promise<void> {
    if (!vm || !branch) return;
    await removeDetachedWorktree(vm, branch);
  }

  async function close(): Promise<void> {
    if (!vm) return;
    try {
      await vm.close();
    } finally {
      vm = null;
      branch = null;
    }
  }

  return {
    launch,
    ensureVm,
    removeWorktree,
    close,
    get vm() {
      return vm;
    },
    get branch() {
      return branch;
    },
    get workspace() {
      return branch === null ? null : guestWorkspace(branch);
    },
  };
}

// Status-bar indicator: "gondolin: <state>" while the sandbox is
// starting/running, cleared when it is down.
function setStatus(ctx: ExtensionContext | undefined, state: string): void {
  if (!ctx) return;
  ctx.ui.setStatus(
    "gondolin",
    ctx.ui.theme.fg("accent", `gondolin: ${state}`),
  );
}
