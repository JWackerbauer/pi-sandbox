// Sandbox configuration: fixed guest layout and git identity.
//
// The guest mounts the host's .git at GUEST_GIT_DIR and checks out a work
// branch as a worktree at its per-branch guest workspace. The agent works
// in that workspace; review/merge back to the main branch happens on the
// host.

// The guest's worktree path for a work branch. The host's .git is shared by
// all sandbox guests, and git identifies worktrees by path, so the guest
// workspace must be unique per branch. Branch names are sanitized to
// [a-z0-9-] (see branch-name.ts), so this is a safe absolute path.
export function guestWorkspace(branch: string): string {
  return `/${branch}`;
}
export const GUEST_GIT_DIR = "/source/.git";
export const GIT_HOOKS_DIR = "/root/.git/hooks";
export const PREPARE_SCRIPT = "/prepare.sh";

// Prefix for session names of sandbox sessions, so they are recognizable
// in the /resume menu. The work branch itself is persisted separately
// (SANDBOX_ENTRY_TYPE), so the prefix is purely cosmetic.
export const SESSION_NAME_PREFIX = "gondolin: ";

// Custom session entry type persisting the sandbox work branch, so a
// resumed session can bring the sandbox back up.
export const SANDBOX_ENTRY_TYPE = "gondolin.sandbox";
export interface SandboxEntryData {
  branch: string;
}

// Custom message type of the sandbox preamble: the context sent (as a
// non-display custom message) when a session switches into the sandbox, in
// place of modifying the system prompt (which would invalidate the inference
// prefix cache).
export const SANDBOX_PREAMBLE_TYPE = "gondolin.sandbox-preamble";

// Custom message type of the proactive subagent settlement notice, queued
// into the parent session when a subagent finishes.
export const SUBAGENT_RESULT_TYPE = "gondolin.subagent-result";

// Custom message type of a deferred subagent status check, queued into the
// parent session when a scheduled status check (subagent_status with
// defer_time) fires.
export const SUBAGENT_STATUS_TYPE = "gondolin.subagent-status";

// Tuning for subagent_status problem detection (see subagents.ts). A
// running subagent with no activity for this long is flagged as "may be
// stuck"; `SUBAGENT_LOOP_WINDOW` identical recent tool calls are flagged as
// "may be looping".
export const SUBAGENT_STUCK_IDLE_MS = 120_000;
export const SUBAGENT_LOOP_WINDOW = 3;
// How many recent tool-call fingerprints to retain for loop detection.
export const SUBAGENT_RECENT_TOOL_WINDOW = 5;

// Limits for the branch-name summarizer model call. Naming is
// best-effort: when the model call fails, times out, or returns no usable
// text, a deterministic name is derived from the prompt instead.
export const SUMMARY_MAX_TOKENS = 32;
export const BRANCH_NAME_MAX_LENGTH = 40;
/** Give up on the model after this long and name the branch from the prompt. */
export const BRANCH_NAME_TIMEOUT_MS = 60_000;

// Git identity used for commits made inside the guest (with an optional
// pi-agent co-author trailer added by the prepare-commit-msg hook, enabled
// by config `coAuthor: true`). Resolved by config-loader.ts:
// config `git` override → the host's effective `git config` → the
// fallback defaults below (matching the co-author identity).
export interface GitIdentity {
  name: string;
  email: string;
}
export const FALLBACK_GIT_IDENTITY: GitIdentity = {
  name: "pi-agent",
  email: "pi-agent@localhost",
};

// ─── Configurable VM options ─────────────────────────────────────────────
//
// A GondolinConfig is loaded from config files (see config-loader.ts) and
// controls VM sizing, shared secrets, and scratch mounts. Every value is
// optional; the defaults below apply when a field is absent.

/** Sizing for a Gondolin VM, in the guest runner's native syntax. */
export interface VmSizing {
  /** Memory in qemu syntax (e.g. "512M", "1G"). Default per VmSizingDefaults. */
  memory?: string;
  /** CPU count. Default per VmSizingDefaults. */
  cpus?: number;
}

/**
 * Rootfs disk options. The guest's root disk is grown to the guest image's
 * own size plus `extra` at every launch (see src/rootfs.ts), so the agent
 * always gets the configured amount of additional disk space, no matter how
 * large the image is (e.g. a `postBuild` image with a big toolchain baked in).
 */
export interface RootfsConfig {
  /**
   * Additional rootfs disk space beyond the guest image's own size, in qemu
   * disk size syntax (a positive integer with an optional K/M/G/T/P/E
   * suffix, e.g. "5G" or "20G"). Default per DEFAULT_ROOTFS_EXTRA.
   */
  extra?: string;
}

/**
 * The `postBuild` section of a Gondolin image config (mirrors the SDK's
 * `BuildConfig.postBuild`). When present in a gondolin.json, a custom image
 * is built at startup with these commands run inside the rootfs after
 * package installation — use it to bake the project's dev dependencies
 * into the image (the rootfs is sized to fit them).
 */
export interface PostBuildConfig {
  /** Host files/directories copied into the rootfs before the commands run. */
  copy?: { src: string; dest: string }[];
  /** Shell commands executed in the rootfs after package installation. */
  commands?: string[];
}

/** A shared secret wired into every VM via the Gondolin secret SDK. */
export interface SecretConfig {
  /** Host patterns this secret may be sent to (e.g. ["github.com"]). */
  hosts: string[];
  /**
   * Literal secret value. When absent the value is read from the host
   * environment variable named by the map key. Prefer the env var — the
   * config file is a less secret place to live.
   */
  value?: string;
  /**
   * Guest-visible placeholder. When absent the Gondolin SDK generates a
   * random placeholder.
   */
  placeholder?: string;
}

/**
 * A GitHub host entry in the config. Two independent opt-in features:
 * - `magicDir`: expose the host's repos as a read-only, lazily-cloned magic
 *   dir (host-side; uses the host's own `gh` authentication).
 * - `ghCliToken`: install & authenticate the `gh` CLI for this host inside
 *   the guest (the token is shared with the guest as a Gondolin secret with
 *   egress restricted to this host).
 */
export interface GitHubOrgConfig {
  /**
   * The GitHub host: `github.com` or a GitHub Enterprise host such as
   * `myorg.ghe.com`.
   */
  host: string;
  /**
   * When true, expose this host's repos as a read-only magic dir under
   * `GUEST_MAGIC_DIR/<host>/`. Uses the host machine's `gh` authentication
   * (`gh auth login`), no token in the config. Default false.
   */
  magicDir?: boolean;
  /**
   * When set, install & authenticate the `gh` CLI for this host in the
   * guest. Either a literal token value, or the name of a host environment
   * variable that holds the token (a set env var takes precedence over a
   * literal; an unset env-var-name entry is skipped). The token is passed
   * to the guest as a secret with egress restricted to this host.
   */
  ghCliToken?: string;
}

/**
 * A GitHub host with its gh CLI token resolved (from an env var or a
 * literal). Only hosts with a usable token are included.
 */
export interface GhCliHost {
  host: string;
  token: string;
}

/**
 * Guest-visible env var name (Gondolin secret name) carrying the gh CLI
 * token for a host. The guest only ever sees the secret's placeholder in
 * this var; the real value is substituted at egress by the http hooks.
 */
export function ghCliSecretName(host: string): string {
  return `GONDOLIN_GH_CLI_${host.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The full configurable surface for the gondolin sandbox. Loaded by
 * config-loader.ts from `~/.pi/agent/gondolin.json` (global) merged with
 * `<repo>/.pi/gondolin.json` (project), with secrets sourced from the
 * process environment.
 *
 * `env` entries are plain (non-secret) environment values: they live in the
 * guest's environment unencrypted and must not be used for secrets — use
 * `secrets` for those.
 */
export interface GondolinConfig {
  /** Sizing for the main session VM. */
  vm?: VmSizing;
  /** Sizing for subagent VMs (smaller by default). */
  subagent?: VmSizing;
  /**
   * Additional rootfs disk space for the guest VMs (see RootfsConfig).
   * Applies to every VM (main and subagent). Merged per field.
   */
  rootfs?: RootfsConfig;
  /**
   * Environment variables set inside the guest VM, visible to every process
   * the agent runs. Merged per key with the global config; a key that also
   * appears in `secrets` keeps the secret's placeholder value.
   */
  env?: Record<string, string>;
  /**
   * Map of secret name → secret config. For each entry the value is taken
   * from the entry's `value` field, falling back to `process.env[name]` at
   * VM launch, and shared with the guest only for the listed hosts. An
   * entry with no value in either source is skipped.
   */
  secrets?: Record<string, SecretConfig>;
  /**
   * GitHub hosts the agent can access (see GitHubOrgConfig). Two
   * independent opt-in features per host: `magicDir` (host-side read-only
   * repo browser under GUEST_MAGIC_DIR, using the host's own `gh`
   * authentication) and `ghCliToken` (installs & authenticates the `gh`
   * CLI in the guest, token shared as a secret with egress restricted to
   * the host). Merged by host (a project entry overrides or adds a host).
   */
  github?: GitHubOrgConfig[];
  /**
   * Opt in to loading the host's `.env` file (the `.env` in the repo
   * root) into the host process's environment before secret and gh CLI
   * token resolution, so a `secrets` or `ghCliToken` value can be sourced
   * from the file. The file is never exposed to the guest or the agent.
   * Default false. Existing environment variables always win over the
   * file.
   */
  envFile?: boolean;
  /**
   * Enable the per-repo and per-branch scratch mounts (host tempdir →
   * guest). Default true. Set false to disable both.
   */
  scratch?: boolean;
  /**
   * Git identity for commits made inside the guest. Each field is optional
   * and overrides the corresponding value from the host's effective git
   * config (repo-local, then global); fields left unset fall back to the
   * host's value. Merged per field (a project config can override just
   * `git.name` while inheriting `git.email`).
   */
  git?: { name?: string; email?: string };
  /**
   * Add a `Co-Authored-By: pi-agent` trailer to commits made inside the
   * guest (via the prepare-commit-msg git hook). Default false. Set true
   * to enable the pi-agent co-author attribution.
   */
  coAuthor?: boolean;
  /**
   * Tell the agent that the sandbox is under development and that it should
   * report any issues it had with the sandbox once it is done working.
   * Default false.
   */
  developMode?: boolean;
  /**
   * Shell commands run in the agent's workspace (`/<branch>`) after the VM
   * has started up and the worktree is ready, in list order. Each entry is
   * a shell line run via /bin/sh -lc in the guest. Project values override
   * the global list wholesale.
   */
  postStartup?: string[];
  /**
   * Post-build section baked into a custom image at startup (see
   * PostBuildConfig). When set, the stock image is rebuilt with these
   * commands and the assets are cached under the repo's `.pi` folder (or
   * the global agent dir for a global-only postBuild). Project values
   * override the global section wholesale.
   */
  postBuild?: PostBuildConfig;
}

// Default sizing: the main VM keeps the runner defaults; subagent VMs are
// deliberately smaller since they run in parallel alongside the main VM.
export const DEFAULT_VM_SIZING: Required<VmSizing> = { memory: "1G", cpus: 2 };
export const DEFAULT_SUBAGENT_SIZING: Required<VmSizing> = { memory: "512M", cpus: 1 };

// Default additional rootfs space, on top of the guest image's own size.
// The root disk is a thin-provisioned qcow2 overlay, so the extra space
// costs nothing on the host until it is actually written.
export const DEFAULT_ROOTFS_EXTRA = "10G";

// ─── Scratch mounts ──────────────────────────────────────────────────────
//
// Scratch directories persist between session restarts because they live on
// the host (under the platform tempdir), not in the VM's ephemeral disk.
// There are two, both under a per-repo host root:
//
//   <tempdir>/gondolin/<repo-hash>/scratch            → /scratch          (shared, per repo)
//   <tempdir>/gondolin/<repo-hash>/<branch>/scratch   → /scratch-local    (per branch)

/** Guest mount point for the per-repo shared scratch dir. */
export const GUEST_SCRATCH = "/scratch";
/** Guest mount point for the per-branch scratch dir. */
export const GUEST_SCRATCH_LOCAL = "/scratch-local";

// ─── Magic git dir ────────────────────────────────────────────────────────
//
// When a configured GitHub host has `magicDir` enabled, its repos are
// browsable as a lazily-cloned, read-only tree mounted in the guest at
// GUEST_MAGIC_DIR. The layout is `/git/<host>/<owner>/<repo>/...`: the top
// level lists the enabled hosts, an owner level lists that owner's repos
// (via `gh repo list`), and a repo level serves the cloned repo's files.
//
// All of this runs *on the host*: the host's own `gh` (authenticated via
// `gh auth login`) lists repos and clones them into a host temp dir, which
// the host-side VFS provider serves read-only under GUEST_MAGIC_DIR. The
// guest never sees the token. Because the clone root lives on the host it
// is reused across VM restarts, so a repo is only cloned once per machine.

/** Guest mount point of the magic git dir (read-only repo browser). */
export const GUEST_MAGIC_DIR = "/git";
/** Host directory name used to scope a repo's scratch under the tempdir. */
export const SCRATCH_HOST_DIRNAME = "gondolin";

/**
 * The host root for a repo's scratch dirs, under the platform tempdir.
 * `repoKey` is a stable per-repo identifier (a sanitized repo name or a
 * hash) chosen by config-loader.ts so paths are safe and unique.
 */
export function hostScratchRoot(tempdir: string, repoKey: string): string {
  return `${tempdir}/${SCRATCH_HOST_DIRNAME}/${repoKey}`;
}
/** Host path of the per-repo shared scratch dir. */
export function hostScratchShared(tempdir: string, repoKey: string): string {
  return `${hostScratchRoot(tempdir, repoKey)}/scratch`;
}
/** Host path of the per-branch scratch dir. */
export function hostScratchBranch(tempdir: string, repoKey: string, branch: string): string {
  return `${hostScratchRoot(tempdir, repoKey)}/${branch}/scratch`;
}

/**
 * Host path backing the magic-git clone dir (served read-only under
 * GUEST_MAGIC_DIR by the host-side provider). Under the per-repo scratch
 * root so it persists across VM restarts and is unique per repo.
 */
export function hostMagicCloneRoot(tempdir: string, repoKey: string): string {
  return `${hostScratchRoot(tempdir, repoKey)}/magic-git`;
}
