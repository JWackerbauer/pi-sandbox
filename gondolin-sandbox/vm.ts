import path from "node:path";
import fs from "node:fs";
import { VM, RealFSProvider } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_WORK_BRANCH,
  GUEST_WORKSPACE,
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
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

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
        export GUEST_WORKSPACE='${GUEST_WORKSPACE}' &&\\
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
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${requested} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(`
        Gondolin VM ready. Branch ${requested} of ${localCwd} created at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    } catch (err) {
      branch = null;
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
    close,
    get vm() {
      return vm;
    },
    get branch() {
      return branch;
    },
  };
}
