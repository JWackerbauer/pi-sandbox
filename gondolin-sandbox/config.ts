// Sandbox configuration: fixed guest layout and git identity.
//
// The guest mounts the host's .git at GUEST_GIT_DIR and checks out a work
// branch as a worktree at GUEST_WORKSPACE. The agent works in GUEST_WORKSPACE;
// review/merge back to the main branch happens on the host.

export const GUEST_WORKSPACE = "/workspace";
export const GUEST_GIT_DIR = "/source/.git";
export const GIT_HOOKS_DIR = "/root/.git/hooks";
export const PREPARE_SCRIPT = "/prepare.sh";

// Custom session entry type persisting the sandbox work branch, so a
// resumed session can bring the sandbox back up.
export const SANDBOX_ENTRY_TYPE = "gondolin.sandbox";
export interface SandboxEntryData {
  branch: string;
}

// Work branch used when the sandbox starts outside of /build-in-sandbox
// (e.g. a tool needs a VM before the user has requested a build).
export const DEFAULT_WORK_BRANCH = "gondolin-test";

// Limits for the branch-name summarizer model call.
export const SUMMARY_MAX_TOKENS = 24;
export const BRANCH_NAME_MAX_LENGTH = 40;

// Git identity for commits made inside the guest (attributed to the operator,
// with the pi-agent co-author trailer added by the prepare-commit-msg hook).
export const GIT_EMAIL = "jan.wackerbauer@gmail.com";
export const GIT_NAME = "Jan Wackerbauer";
