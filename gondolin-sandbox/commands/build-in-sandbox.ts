import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestBranchName } from "../branch-name";
import { SANDBOX_ENTRY_TYPE } from "../config";
import type { GondolinSandbox } from "../vm";

// /build-in-sandbox <prompt>
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
      const prompt = args.trim();
      if (prompt.length === 0) {
        ctx.ui.notify(
          "Usage: /build-in-sandbox <what do you want to build?>",
          "error",
        );
        return;
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
        ctx.ui.theme.fg("accent", "Gondolin: naming branch…"),
      );
      const branch = await requestBranchName(
        model,
        ctx.modelRegistry,
        prompt,
      );
      pi.setSessionName(branch);

      await sandbox.launch(branch, ctx);
      // Persist the branch so /resume (and /reload) can relaunch the
      // sandbox for it. Custom entries are not sent to the LLM.
      pi.appendEntry(SANDBOX_ENTRY_TYPE, { branch });
      pi.sendUserMessage(prompt);
    },
  });
}
