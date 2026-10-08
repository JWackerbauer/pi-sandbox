import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestBranchName } from "../branch-name";
import { SANDBOX_ENTRY_TYPE, SESSION_NAME_PREFIX } from "../config";
import type { GondolinSandbox } from "../vm";

// /build-in-sandbox [prompt]
//
// Summarizes the prompt into a branch name with the current model,
// names the session after it, launches the sandbox VM for that branch,
// and starts the first agent turn with the user's prompt.
export function registerBuildCommand(
  pi: ExtensionAPI,
  sandbox: GondolinSandbox,
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

      await sandbox.launch(branch, ctx);
      // Only rename and persist after a successful launch, so a failed
      // start does not leave the session misnamed or marked as sandboxed.
      pi.setSessionName(SESSION_NAME_PREFIX + branch);
      // Persist the branch so /resume (and /reload) can relaunch the
      // sandbox for it. Custom entries are not sent to the LLM.
      pi.appendEntry(SANDBOX_ENTRY_TYPE, { branch });
      pi.sendUserMessage(prompt);
    },
  });
}
