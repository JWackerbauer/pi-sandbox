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
