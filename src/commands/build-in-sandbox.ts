import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestBranchName } from "../branch-name";
import { SANDBOX_ENTRY_TYPE, SESSION_NAME_PREFIX } from "../config";
import type { GondolinSandbox } from "../vm";

export interface BuildCommandOptions {
  /**
   * Called with the new branch just before the first user prompt is sent.
   * The default implementation (index.ts) sends the sandbox preamble — a
   * non-display custom message telling the agent that its session
   * parameters have changed, in place of modifying the system prompt.
   */
  onSandboxStart?: (ctx: ExtensionContext, branch: string) => void;
}

// /build-in-sandbox [prompt]
//
// Summarizes the prompt into a branch name with the current model, launches
// the sandbox VM for that branch, and starts the first agent turn with the
// user's prompt.
//
// The VM launch and the first turn are started concurrently: they have no
// dependency on one another. The model can stream its first response while
// the VM boots; when the turn needs a tool, the tool wrapper's ensureVm()
// awaits the in-flight launch (see vm.ts), so the agent loop blocks on the
// VM exactly as long as necessary.
export function registerBuildCommand(
  pi: ExtensionAPI,
  sandbox: GondolinSandbox,
  opts: BuildCommandOptions = {},
): void {
  pi.registerCommand("build-in-sandbox", {
    description:
      "Build in the sandbox: summarize the idea into a branch name, " +
      "start the VM, and begin working on it",
    handler: async (args, ctx) => {
      let prompt = args.trim();
      if (prompt.length === 0) {
        const entered = await ctx.ui.input("What do you want to build?");
        if (entered === undefined) return; // user cancelled the dialog
        prompt = entered.trim();
        if (prompt.length === 0) {
          ctx.ui.notify("gondolin: nothing to build — no prompt given", "warning");
          return;
        }
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify(
          "gondolin: no model selected — pick one with /model first",
          "error",
        );
        return;
      }

      // Commands run outside a turn; make sure any in-flight work has
      // finished before starting a new one.
      await ctx.waitForIdle();

      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", "gondolin: naming branch…"),
      );
      const branch = await requestBranchName(
        model,
        ctx.modelRegistry,
        prompt,
      );

      // Rename and persist the branch so /resume (and /reload) can relaunch
      // the sandbox for it. Custom entries are not sent to the LLM.
      pi.setSessionName(SESSION_NAME_PREFIX + branch);
      pi.appendEntry(SANDBOX_ENTRY_TYPE, { branch });

      // Tell the agent its session parameters have changed: the sandbox
      // preamble is a non-display custom message appended ahead of the
      // first user prompt (no system prompt modification, so the inference
      // prefix cache stays intact).
      opts.onSandboxStart?.(ctx, branch);

      // Start the first turn and the VM launch concurrently. The model can
      // stream its response while the VM boots; the first tool call blocks
      // on the in-flight launch (ensureVm in vm.ts).
      pi.sendUserMessage(prompt);

      const launch = sandbox.launch(branch, ctx);
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
