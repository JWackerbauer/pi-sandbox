import { GUEST_SCRATCH, GUEST_SCRATCH_LOCAL } from "./config";

// The CWD section of the sandbox system prompt.
//
// This text is the single source of truth for what the agent is told about
// its workspace. It is injected into the real session by the
// `before_agent_start` hook (index.ts) and reused verbatim for the first-turn
// pre-warm (prewarm.ts), so the speculative completion runs with the same
// sandbox context as the turn it warms.
export interface CwdSectionOptions {
  /** The work branch the sandbox runs on. */
  branch: string;
  /** The guest workspace path for that branch (e.g. "/my-branch"). */
  workspace: string;
  developMode: boolean;
  scratchEnabled: boolean;
}

export function buildCwdSection(opts: CwdSectionOptions): string {
  const { branch, workspace, developMode, scratchEnabled } = opts;
  return (
    `You are working in a gondolin sandbox; cwd: ${workspace} (a git worktree owned by you, branch: ` +
    `${branch})\n` +
    `You share the source git repository with the user, the user can review & merge your changes on their host. ` +
    `Do not commit to any other branch; do not merge your branch. Ask the user to review & merge instead.\n` +
    `The shared git repository is the ONLY persistent storage in your workspace; the rest of the filesystem is ephemeral. ` +
    `You must commit all relevant work to your branch (${branch}) otherwise it will be lost.\n` +
    (developMode
      ? `This sandbox is under development. When you are done working, please report any issues you ` +
        `encountered with the sandbox itself (e.g. broken tools, missing packages, unexpected behavior) ` +
        `so the problems can be fixed.`
      : ``) +
    (scratchEnabled
      ? ` Two scratch directories persist across VM restarts (they live on the host's temp filesystem, not in git, so they stick around ` +
        `for a while but not forever - do not treat them as permanent storage): ` +
        `${GUEST_SCRATCH} is shared with every other session of this repository, so use it only for things that are ` +
        `universally useful to all of them (e.g. shared caches or downloaded artifacts); ` +
        `${GUEST_SCRATCH_LOCAL} is private to your branch and can hold anything else (build outputs, temporary data).`
      : ``)
  );
}

// A stand-in system prompt for pre-warming the model while the VM boots.
//
// It deliberately does NOT try to replicate pi's default system prompt
// (tool documentation, formatting rules, …): extensions have no access to it.
// The pre-warm only needs enough context to make a plausible first answer to
// the user's prompt, and it is only used when its result is a complete
// pure-text answer (see prewarm.ts), so the CWD section plus a short framing
// is sufficient.
export function buildPrewarmSystemPrompt(opts: CwdSectionOptions): string {
  return (
    "You are the pi coding agent, running inside a gondolin sandbox: a VM with " +
    "the shared git repository mounted, where you work on your own work branch. " +
    "You have the tools: bash, read, write, edit.\n" +
    "Work on the task the user gives you, and commit your work to your work branch.\n\n" +
    buildCwdSection(opts)
  );
}
