import path from "node:path";
import fs from "node:fs";
import { VM, RealFSProvider } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_WORK_BRANCH,
  guestWorkspace,
  GUEST_GIT_DIR,
  GIT_EMAIL,
  GIT_HOOKS_DIR,
  GIT_NAME,
  PREPARE_SCRIPT,
} from "./config";

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

      const created = await VM.create({
        sandbox: {
          imagePath: "./gondolin-sandbox/image-assets",
        },
        vfs: {
          mounts: {
            [GUEST_GIT_DIR]: new RealFSProvider(localGitDir),
          },
        },
      });

      // Install the prepare script and the git hook into the guest.
      const moduleRoot = path.resolve(__dirname);
      await created.fs.writeFile(
        PREPARE_SCRIPT,
        fs.readFileSync(path.join(moduleRoot, "scripts", "prepare.sh")),
      );
      await created.fs.mkdir(GIT_HOOKS_DIR, { recursive: true });
      await created.fs.writeFile(
        path.join(GIT_HOOKS_DIR, "prepare-commit-msg"),
        fs.readFileSync(path.join(moduleRoot, "scripts", "prepare-commit-msg")),
      );

      // `requested` is a sanitized branch name ([a-z0-9-] only), so it is
      // safe to interpolate into the shell command. String form runs in
      // /bin/sh -lc "..."
      const result = await created.exec(`
        export GIT_EMAIL='${GIT_EMAIL}' &&\\
        export GIT_NAME='${GIT_NAME}' &&\\
        export WORK_BRANCH_NAME='${requested}' &&\\
        export GUEST_GIT_DIR='${GUEST_GIT_DIR}' &&\\
        export GUEST_WORKSPACE='${guestWorkspace(requested)}' &&\\
        export GIT_HOOKS_DIR='${GIT_HOOKS_DIR}' &&\\
          chmod +x ${PREPARE_SCRIPT} && ${PREPARE_SCRIPT}
      `);

      if (result.exitCode !== 0) {
        // Tear down the half-configured VM so a retry starts clean,
        // then surface the failure to the caller.
        try {
          await created.close();
        } catch {
          // ignore: the VM is unusable anyway
        }
        const detail =
          [result.stdout.trim(), result.stderr.trim()]
            .filter((d) => d.length > 0)
            .join("\n") || "(no output)";
        throw new Error(
          `gondolin: prepare.sh failed with exit code ${result.exitCode}\n${detail}`,
        );
      }

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
