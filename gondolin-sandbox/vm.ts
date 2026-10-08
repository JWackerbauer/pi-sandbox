import path from "node:path";
import fs from "node:fs";
import { VM, RealFSProvider } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GUEST_WORKSPACE,
  GUEST_GIT_DIR,
  GIT_EMAIL,
  GIT_HOOKS_DIR,
  GIT_NAME,
  PREPARE_SCRIPT,
  WORK_BRANCH_NAME,
} from "./config";

export interface GondolinSandbox {
  // Start the VM on first use (and return the existing one afterwards).
  ensureVm: (ctx?: ExtensionContext) => Promise<VM>;
  close: () => Promise<void>;
  readonly vm: VM | null;
}

export function createSandbox(
  localCwd: string,
  localGitDir: string,
): GondolinSandbox {
  let vm: VM | null = null;
  let starting: Promise<VM> | null = null;

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (starting) return starting;

    starting = (async () => {
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

      // String form runs in /bin/sh -lc "..."
      const result = await created.exec(`
        export GIT_EMAIL='${GIT_EMAIL}' &&\\
        export GIT_NAME='${GIT_NAME}' &&\\
        export WORK_BRANCH_NAME='${WORK_BRANCH_NAME}' &&\\
        export GUEST_GIT_DIR='${GUEST_GIT_DIR}' &&\\
        export GUEST_WORKSPACE='${GUEST_WORKSPACE}' &&\\
        export GIT_HOOKS_DIR='${GIT_HOOKS_DIR}' &&\\
          chmod +x ${PREPARE_SCRIPT} && ${PREPARE_SCRIPT} || mkdir ${GUEST_WORKSPACE}
      `);

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${WORK_BRANCH_NAME} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(`
        exitCode: ${result.exitCode}
        stdout: ${result.stdout}
        stderr: ${result.stderr}
        Gondolin VM ready. Branch ${WORK_BRANCH_NAME} of ${localCwd} created at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return starting;
  }

  async function close(): Promise<void> {
    if (!vm) return;
    try {
      await vm.close();
    } finally {
      vm = null;
      starting = null;
    }
  }

  return {
    ensureVm,
    close,
    get vm() {
      return vm;
    },
  };
}
