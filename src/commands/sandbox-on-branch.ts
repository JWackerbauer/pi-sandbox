import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOX_ENTRY_TYPE, SESSION_NAME_PREFIX } from "../config";
import type { ResolvedSandboxBranch } from "../branch-ref";
import { BranchSelectComponent } from "../branch-select";
import type { GondolinSandbox } from "../vm";

export interface SandboxOnBranchOptions {
  /**
   * Called with the branch just before the sandbox is entered. The default
   * implementation (index.ts) enters the sandbox (registers the session
   * hooks) and sends the sandbox preamble — a non-display custom message
   * telling the agent its session parameters have changed, in place of
   * modifying the system prompt.
   */
  onSandboxStart?: (ctx: ExtensionContext, branch: string) => void;
  /**
   * Resolve a local or remote branch name (host-side, against the shared
   * .git) to the local branch to check out, the remote ref to create it
   * from (for remote branches), and whether it is already checked out in a
   * worktree. Returns null when the name is neither a local nor a remote
   * branch.
   */
  resolveBranch: (name: string) => Promise<ResolvedSandboxBranch | null>;
  /**
   * The branches the command can sandbox (local + remote, minus any already
   * checked out), for the no-argument selection list. Local branches first,
   * then remote, each group sorted.
   */
  listBranches: () => Promise<string[]>;
}

// /sandbox-on-branch <branch>
//
// Spin up a sandbox on an existing local or remote branch — one that is not
// currently checked out in any worktree. Unlike /build-in-sandbox this does
// not name a branch or start a build turn: it checks out (or, for a remote
// branch, creates a local tracking branch from) the given branch as the
// sandbox worktree and lets the user drive the first turn.
//
// A branch that is already checked out (in the host worktree or another
// sandbox's guest worktree) is rejected: git allows a branch in only one
// worktree at a time, and silently checking it out twice would corrupt the
// shared .git.
export function registerSandboxOnBranchCommand(
  pi: ExtensionAPI,
  sandbox: GondolinSandbox,
  opts: SandboxOnBranchOptions,
): void {
  pi.registerCommand("sandbox-on-branch", {
    description:
      "Sandbox an existing local or remote branch that is not currently " +
      "checked out: start the VM on that branch and continue in the sandbox",
    handler: async (args, ctx) => {
      let name = args.trim();
      if (name.length === 0) {
        // No explicit branch: offer the branches that can be sandboxed
        // (local + remote, minus any already checked out). Fall back to
        // free text when there is nothing to list, so a name that exists
        // but wasn't listed can still be entered.
        const candidates = await opts.listBranches();
        if (candidates.length > 0) {
          const chosen = await selectBranch(
            ctx,
            "Choose a branch to sandbox (checked-out branches are omitted):",
            candidates,
          );
          if (chosen === undefined) return; // user cancelled the selector
          name = chosen.trim();
        } else {
          const entered = await ctx.ui.input(
            "No sandboxable branches found — enter a branch name:",
          );
          if (entered === undefined) return; // user cancelled the dialog
          name = entered.trim();
          if (name.length === 0) {
            ctx.ui.notify("gondolin: no branch given", "warning");
            return;
          }
        }
      }

      // Commands run outside a turn; make sure any in-flight work has
      // finished before starting a new launch.
      await ctx.waitForIdle();

      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", "gondolin: resolving branch…"),
      );
      let resolved: ResolvedSandboxBranch | null;
      try {
        resolved = await opts.resolveBranch(name);
      } catch (err) {
        ctx.ui.setStatus("gondolin", undefined);
        ctx.ui.notify(
          `gondolin: resolving the branch failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error",
        );
        return;
      }
      if (!resolved) {
        ctx.ui.setStatus("gondolin", undefined);
        ctx.ui.notify(
          `gondolin: no local or remote branch named '${name}'`,
          "error",
        );
        return;
      }
      if (resolved.checkedOut) {
        ctx.ui.setStatus("gondolin", undefined);
        ctx.ui.notify(
          `gondolin: branch '${resolved.branch}' is already checked out` +
            (resolved.checkedOutAt ? ` at ${resolved.checkedOutAt}` : "") +
            " — check out a different branch there first",
          "error",
        );
        return;
      }

      // Rename and persist the branch so /resume (and /reload) can relaunch
      // the sandbox for it. Custom entries are not sent to the LLM.
      pi.setSessionName(SESSION_NAME_PREFIX + resolved.branch);
      pi.appendEntry(SANDBOX_ENTRY_TYPE, { branch: resolved.branch });

      // Tell the agent its session parameters have changed (the sandbox
      // preamble is a non-display custom message; no system prompt
      // modification, so the inference prefix cache stays intact).
      opts.onSandboxStart?.(ctx, resolved.branch);

      // Start the VM launch in the background. For a remote branch the local
      // branch is created from the remote ref (branchStart); for an existing
      // local branch it is checked out as-is. No first user message is sent:
      // the user is sandboxing an existing branch, not starting a build, so
      // their next message drives the first turn (the first tool call blocks
      // on the in-flight launch via requireVm in vm.ts).
      const launch = sandbox.launch(
        resolved.branch,
        ctx,
        resolved.startRef ? { branchStart: resolved.startRef } : undefined,
      );
      // Surface a launch failure even if the turn never calls a tool
      // (otherwise the rejection would go unhandled).
      launch.catch((err: unknown) => {
        ctx.ui.notify(
          `gondolin: VM launch failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error",
        );
      });
    },
  });
}

// The no-argument branch selector. Prefers the fuzzy branch selector
// (type to filter, via the interactive TUI's `custom` component slot); on
// hosts without TUI support (e.g. RPC mode, where `custom` resolves to
// undefined without showing anything) it falls back to the plain selector.
async function selectBranch(
  ctx: ExtensionContext,
  title: string,
  candidates: string[],
): Promise<string | undefined> {
  let shown = false;
  const chosen = await ctx.ui.custom<string | undefined>(
    (_tui, theme, keybindings, done) => {
      shown = true;
      return new BranchSelectComponent({
        title,
        branches: candidates,
        theme,
        keybindings,
        onDone: done,
      });
    },
  );
  if (chosen !== undefined) return chosen;
  if (shown) return undefined; // user cancelled the fuzzy selector
  return ctx.ui.select(title, candidates);
}
