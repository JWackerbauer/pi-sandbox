import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOX_EXITED_TYPE } from "../config";
import type { GondolinSandbox } from "../vm";

export interface ExitCommandOptions {
  /**
   * Called once the sandbox is torn down, with the exited work branch. The
   * default implementation (index.ts) sends the exit notice — a non-display
   * custom message telling the agent that the session is back on the host,
   * in place of modifying the system prompt — and resets the preamble guard
   * so a re-entry sends a fresh sandbox preamble.
   */
  onSandboxExit?: (ctx: ExtensionContext, branch: string) => void;
}

// /sandbox-exit
//
// Ends the sandbox: tears down the VM, removes the session's worktree, and
// continues the session on the host (the wrapped tools fall back to the
// local host tools once the sandbox is no longer active). The work branch
// and its commits are kept in the shared .git for the user to review &
// merge, and an exit entry is appended so resuming this session does not
// bring the sandbox back up.
export function registerExitCommand(
  pi: ExtensionAPI,
  sandbox: GondolinSandbox,
  opts: ExitCommandOptions = {},
): void {
  pi.registerCommand("sandbox-exit", {
    description:
      "Exit the sandbox: tear down the VM and worktree, and continue the " +
      "session on the host (your work branch is kept)",
    handler: async (_args, ctx) => {
      if (!sandbox.active) {
        ctx.ui.notify("gondolin: the sandbox is not active", "warning");
        return;
      }
      // Commands run outside a turn; make sure any in-flight work has
      // finished before tearing the VM down (a running turn could be
      // mid-tool-call inside the guest).
      await ctx.waitForIdle();
      const branch = sandbox.branch;
      if (!branch) {
        ctx.ui.notify(
          "gondolin: no sandbox branch is known — nothing to exit",
          "warning",
        );
        return;
      }

      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", "gondolin: exiting…"),
      );
      try {
        // Tear down: await any in-flight launch, remove this session's
        // worktree in the guest (so its shared .git registration is cleaned
        // up), then close the VM.
        await sandbox.teardown();
      } catch (err) {
        // The sandbox state is cleared even when the VM close fails (the
        // wrapper nulls its state), so the session exits to the host
        // either way; the failure is reported, not fatal.
        ctx.ui.notify(
          `gondolin: sandbox teardown failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error",
        );
      }

      // Persist the exit so resuming this session continues on the host
      // instead of relaunching the sandbox. Custom entries are not sent to
      // the LLM.
      pi.appendEntry(SANDBOX_EXITED_TYPE, { branch });
      opts.onSandboxExit?.(ctx, branch);
      ctx.ui.setStatus("gondolin", undefined);
      ctx.ui.notify(
        `Sandbox exited. Your work is kept on branch ${branch}; the session ` +
          `continues on the host.`,
        "info",
      );
    },
  });
}
