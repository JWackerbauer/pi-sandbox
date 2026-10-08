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

// Custom message type of the proactive subagent settlement notice, queued
// into the parent session when a subagent finishes.
export const SUBAGENT_RESULT_TYPE = "gondolin.subagent-result";

// Work branch used when the sandbox starts outside of /build-in-sandbox
// (e.g. a tool needs a VM before the user has requested a build).
export const DEFAULT_WORK_BRANCH = "gondolin-test";

// Limits for the branch-name summarizer model call.
export const SUMMARY_MAX_TOKENS = 32;
export const BRANCH_NAME_MAX_LENGTH = 40;

// Git identity for commits made inside the guest (attributed to the operator,
// with the pi-agent co-author trailer added by the prepare-commit-msg hook).
export const GIT_EMAIL = "jan.wackerbauer@gmail.com";
export const GIT_NAME = "Jan Wackerbauer";

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

/** A shared secret wired into every VM via the Gondolin secret SDK. */
export interface SecretConfig {
  /** Host patterns this secret may be sent to (e.g. ["github.com"]). */
  hosts: string[];
  /**
   * Guest-visible placeholder. When absent the Gondolin SDK generates a
   * random placeholder. The real value always comes from an environment
   * variable on the host, never from a config file.
   */
  placeholder?: string;
}

/**
 * The full configurable surface for the gondolin sandbox. Loaded by
 * config-loader.ts from `~/.pi/agent/gondolin.json` (global) merged with
 * `<repo>/.pi/gondolin.json` (project), with secrets sourced from the
 * process environment.
 */
export interface GondolinConfig {
  /** Sizing for the main session VM. */
  vm?: VmSizing;
  /** Sizing for subagent VMs (smaller by default). */
  subagent?: VmSizing;
  /**
   * Map of environment-variable name → secret config. For each entry the
   * value is read from `process.env[name]` at VM launch and shared with the
   * guest only for the listed hosts. An entry whose env var is unset is
   * skipped.
   */
  secrets?: Record<string, SecretConfig>;
  /**
   * Enable the per-repo and per-branch scratch mounts (host tempdir →
   * guest). Default true. Set false to disable both.
   */
  scratch?: boolean;
}

// Default sizing: the main VM keeps the runner defaults; subagent VMs are
// deliberately smaller since they run in parallel alongside the main VM.
export const DEFAULT_VM_SIZING: Required<VmSizing> = { memory: "1G", cpus: 2 };
export const DEFAULT_SUBAGENT_SIZING: Required<VmSizing> = { memory: "512M", cpus: 1 };

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
