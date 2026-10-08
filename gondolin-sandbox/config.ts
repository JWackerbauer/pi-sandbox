// Sandbox configuration: fixed guest layout and git identity.
//
// The guest mounts the host's .git at GUEST_GIT_DIR and checks out
// WORK_BRANCH_NAME as a worktree at GUEST_WORKSPACE. The agent works in
// GUEST_WORKSPACE; review/merge back to the main branch happens on the host.

export const GUEST_WORKSPACE = "/workspace";
export const GUEST_GIT_DIR = "/source/.git";
export const WORK_BRANCH_NAME = "gondolin-test";
export const GIT_HOOKS_DIR = "/root/.git/hooks";
export const PREPARE_SCRIPT = "/prepare.sh";

// Git identity for commits made inside the guest (attributed to the operator,
// with the pi-agent co-author trailer added by the prepare-commit-msg hook).
export const GIT_EMAIL = "jan.wackerbauer@gmail.com";
export const GIT_NAME = "Jan Wackerbauer";
