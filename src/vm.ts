import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  VM,
  RealFSProvider,
  createHttpHooks,
} from "@earendil-works/gondolin";
import type { VirtualProvider, SecretDefinition } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  computeRepoKey,
  loadGondolinConfig,
  resolvePostBuild,
  resolveMagicDirHosts,
  resolveGhCliHosts,
  resolveSecrets,
} from "./config-loader";
import { resolveImageAssets } from "./image";
import {
  checkHostGhAuth,
  setupGhCli,
  MagicGitProvider,
} from "./github";
import {
  DEFAULT_SUBAGENT_SIZING,
  DEFAULT_VM_SIZING,
  DEFAULT_WORK_BRANCH,
  ghCliSecretName,
  guestWorkspace,
  GUEST_GIT_DIR,
  GUEST_MAGIC_DIR,
  GUEST_SCRATCH,
  GUEST_SCRATCH_LOCAL,
  GIT_EMAIL,
  GIT_HOOKS_DIR,
  GIT_NAME,
  hostMagicCloneRoot,
  hostScratchBranch,
  hostScratchShared,
  PREPARE_SCRIPT,
} from "./config";

// No-op prepare-commit-msg hook written when the pi-agent co-author
// attribution is disabled (config `coAuthor: false`): commits are left
// exactly as authored, with no trailer appended.
const NOOP_PREPARE_COMMIT_MSG_HOOK = `#!/bin/sh\n# pi-agent co-author attribution disabled (config coAuthor: false)\nexit 0\n`;

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
  /**
   * Optional notice callback: receives progress messages and the custom
   * image build log, line by line (rendered in the TUI).
   */
  onNotice?: (message: string) => void;
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
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const config = loadGondolinConfig(localCwd, agentDir);

  // Image assets: the stock image, or a custom image built from the config's
  // postBuild section (cached; built on first use).
  const imagePath = await resolveImageAssets(
    resolvePostBuild(localCwd, agentDir),
    opts.onNotice,
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
  // User-defined `env` entries are merged under the secret placeholders, so
  // an env entry can never shadow a secret's guest-visible placeholder.
  //
  // The gh CLI tokens are shared as secrets too: one per configured host,
  // with egress restricted to exactly that host. The guest only ever sees
  // each secret's placeholder (in hosts.yml and its env var); the http
  // hooks substitute the real token at egress.
  const ghCliHosts = resolveGhCliHosts(config);
  // Surface gh CLI entries that were configured but not resolvable (e.g. the
  // env var named by `ghCliToken` is not set in the process that started pi,
  // or is a sourced-but-not-exported shell variable) — otherwise the feature
  // is silently off and the guest has no `gh`.
  for (const entry of config.github ?? []) {
    if (entry.ghCliToken === undefined) continue;
    const host = entry.host.trim();
    if (!host || ghCliHosts.some((h) => h.host === host)) continue;
    opts.onNotice?.(
      `gondolin: gh CLI not enabled for ${host}: the token ` +
        `'${entry.ghCliToken}' is not resolvable. If it names an environment ` +
        `variable, make sure it is exported in the shell that starts pi.`,
    );
  }
  const ghCliSecrets: Record<string, SecretDefinition> = {};
  for (const h of ghCliHosts) {
    // gh's git traffic goes to the host itself, but its API calls go to
    // api.<host> (for GHE the API lives on the host, so the extra entry is
    // harmless there).
    ghCliSecrets[ghCliSecretName(h.host)] = {
      hosts: [h.host, `api.${h.host}`],
      value: h.token,
    };
  }
  const { httpHooks, env: secretsEnv } = createHttpHooks({
    secrets: { ...resolveSecrets(config), ...ghCliSecrets },
  });
  const env = { ...(config.env ?? {}), ...secretsEnv };

  const mounts: Record<string, VirtualProvider> = {
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

  // GitHub magic dir (opt-in, host-side): repos of the enabled hosts are
  // served read-only under GUEST_MAGIC_DIR. The host's own `gh`
  // (authenticated via `gh auth login`) lists repos and clones them into a
  // host temp dir, which the provider serves — no guest RPC and no token
  // ever enter the guest.
  const magicHosts = resolveMagicDirHosts(config);
  if (magicHosts.length > 0) {
    // Fail early with an actionable message when the host can't serve it.
    await checkHostGhAuth(magicHosts);
    const repoKey = computeRepoKey(localCwd);
    const cloneRoot = hostMagicCloneRoot(os.tmpdir(), repoKey);
    fs.mkdirSync(cloneRoot, { recursive: true });
    mounts[GUEST_MAGIC_DIR] = new MagicGitProvider({ hosts: magicHosts, cloneRoot });
  }

  const moduleRoot = path.resolve(__dirname);
  const created = await VM.create({
    sandbox: {
      imagePath,
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
    // The pi-agent co-author trailer is on by default; only an explicit
    // `coAuthor: false` in the config swaps in a no-op hook.
    const coAuthorEnabled = config.coAuthor !== false;
    await created.fs.writeFile(
      path.join(GIT_HOOKS_DIR, "prepare-commit-msg"),
      coAuthorEnabled
        ? fs.readFileSync(path.join(moduleRoot, "scripts", "prepare-commit-msg"))
        : NOOP_PREPARE_COMMIT_MSG_HOOK,
    );
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

    // Install & authenticate the `gh` CLI in the guest for the configured
    // hosts (opt-in; a no-op when none are configured). The token for each
    // host travels as a Gondolin secret: hosts.yml carries the secret's
    // placeholder, and the http hooks substitute the real token at egress,
    // restricted to that host. Runs before postStartup so a post-startup
    // command can already use `gh`.
    if (ghCliHosts.length > 0) {
      await setupGhCli(
        created,
        ghCliHosts.map((h) => ({
          host: h.host,
          placeholder: secretsEnv[ghCliSecretName(h.host)] ?? "",
        })),
      );
    }

    // User-defined post-startup commands (config `postStartup`), run in the
    // agent's workspace, which exists once prepare.sh created the worktree.
    await runPostStartupCommands(
      created,
      config.postStartup,
      guestWorkspace(branch),
    );
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

// Run user-defined post-startup commands (config `postStartup`) inside the
// guest, in list order, with the agent's workspace as the working
// directory. Each entry is a shell line run via /bin/sh -lc. A non-zero
// exit fails the VM launch with the command output surfaced, mirroring the
// prepare.sh failure behavior.
async function runPostStartupCommands(
  vm: VM,
  commands: string[] | undefined,
  workspace: string,
): Promise<void> {
  for (const cmd of commands ?? []) {
    const result = await vm.exec(cmd, { cwd: workspace });
    if (result.exitCode !== 0) {
      const detail =
        [result.stdout.trim(), result.stderr.trim()]
          .filter((d) => d.length > 0)
          .join("\n") || "(no output)";
      throw new Error(
        `gondolin: postStartup command failed with exit code ${result.exitCode}: ${cmd}\n${detail}`,
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

export interface SandboxCallbacks {
  /** Called when a launch starts (the VM is not up yet). */
  onLaunchStart?: (branch: string) => void;
  /** Called with each launch progress line (image build, boot). */
  onNotice?: (branch: string, message: string) => void;
  /** Called when a launch settles, success or failure. */
  onLaunchSettled?: (branch: string) => void;
}

export function createSandbox(
  localCwd: string,
  localGitDir: string,
  callbacks: SandboxCallbacks = {},
): GondolinSandbox {
  let vm: VM | null = null;
  let branch: string | null = null;
  let starting: { branch: string; promise: Promise<VM> } | null = null;

  async function doLaunch(
    requested: string,
    ctx?: ExtensionContext,
  ): Promise<VM> {
    try {
      callbacks.onLaunchStart?.(requested);
      setStatus(ctx, "starting…");
      const created = await launchDetachedVm(requested, {
        localCwd,
        localGitDir,
        // Progress lines go to the caller (index.ts renders them in the
        // startup widget), not to the transcript — boot logs must not mix
        // with the first turn's output.
        onNotice: (message) => callbacks.onNotice?.(requested, message),
      });
      vm = created;
      branch = requested;
      setStatus(ctx, requested);
      // The single transcript line confirming the VM is ready.
      ctx?.ui.notify(`
        Gondolin VM ready. Branch ${requested} of ${localCwd} created at ${guestWorkspace(requested)}`,
        "info",
      );
      callbacks.onLaunchSettled?.(requested);
      return created;
    } catch (err) {
      branch = null;
      // Drop the "starting" status; the error itself is surfaced by
      // pi to the user.
      ctx?.ui.setStatus("gondolin", undefined);
      callbacks.onLaunchSettled?.(requested);
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

    // The branch is known as soon as the launch starts, so readers (the CWD
    // system-prompt section, subagent parent-branch lookup) see the correct
    // branch while the VM is still booting.
    branch = requested;
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
    // A launch is already in flight (e.g. /build-in-sandbox started it in
    // parallel with the first turn): await that VM rather than starting a
    // second one for the default branch.
    if (starting) return starting.promise;
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
