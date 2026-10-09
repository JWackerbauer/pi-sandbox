import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestBranchName } from "../branch-name";
import {
  guestWorkspace,
  PREWARM_PROMPT_TYPE,
  PREWARM_REPLY_TYPE,
  SANDBOX_ENTRY_TYPE,
  SESSION_NAME_PREFIX,
} from "../config";
import { loadGondolinConfig } from "../config-loader";
import { buildPrewarmSystemPrompt } from "../prompt";
import { startPrewarm } from "../prewarm";
import type { GondolinSandbox } from "../vm";

// /build-in-sandbox [prompt]
//
// Summarizes the prompt into a branch name with the current model,
// launches the sandbox VM for that branch, and starts the first agent turn
// with the user's prompt.
//
// First-turn pre-warm: the LLM generation for the first turn is started in
// parallel with the (slow) VM startup (see prewarm.ts). If the speculative
// completion finishes as a complete pure-text answer, it is handed off to
// the session as the first turn and no second model call is made; otherwise
// the normal first turn runs (with a warm provider connection).
export function registerBuildCommand(
  pi: ExtensionAPI,
  sandbox: GondolinSandbox,
  localCwd: string,
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

      // Pre-warm the model: start the speculative completion for the first
      // turn NOW, in parallel with the VM startup. It uses the same sandbox
      // CWD section the real first turn will see (see prompt.ts). The first
      // provider hit of the session was the branch-name call above, so the
      // connection is already warm.
      const prewarm = startPrewarm(
        model,
        ctx.modelRegistry,
        buildPrewarmSystemPrompt(prewarmPromptOptions(localCwd, branch)),
        prompt,
      );

      await sandbox.launch(branch, ctx);
      // Only rename and persist after a successful launch, so a failed
      // start does not leave the session misnamed or marked as sandboxed.
      // (If launch threw, the in-flight pre-warm is abandoned; it is
      // capped and finishes on its own — see prewarm.ts.)
      pi.setSessionName(SESSION_NAME_PREFIX + branch);
      // Persist the branch so /resume (and /reload) can relaunch the
      // sandbox for it. Custom entries are not sent to the LLM.
      pi.appendEntry(SANDBOX_ENTRY_TYPE, { branch });

      // The VM is ready. Wait for the pre-warm to settle (it usually already
      // has: its output is capped and the VM startup is the slow part).
      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `gondolin: ${branch} · pre-warming model…`),
      );
      const result = await prewarm.done;
      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", `gondolin: ${branch}`),
      );

      if (result.usable) {
        // Hand-off: seed the exchange as the session's first turn — the
        // user's prompt and the pre-generated answer appear in the session
        // without a second model call. By the time the VM was ready the
        // answer was usually already complete, so the first turn's model
        // wait (connection + generation) is eliminated. (Trade-offs:
        // prewarm.ts.)
        pi.sendMessage(
          {
            customType: PREWARM_PROMPT_TYPE,
            content: prompt,
            display: true,
            details: {},
          },
          {},
        );
        pi.sendMessage(
          {
            customType: PREWARM_REPLY_TYPE,
            content: result.text,
            display: true,
            details: { prewarmed: true },
          },
          {},
        );
      } else {
        // Fall back to the normal first turn: the agent loop makes its own
        // model call (with a warm connection), and its response — including
        // tool calls — is executed for real.
        pi.sendUserMessage(prompt);
      }
    },
  });
}

// The sandbox options for the pre-warm's system prompt: the work branch's
// workspace plus the config-driven prompt toggles, matching what the
// before_agent_start hook (index.ts) will inject for the real turn. Config
// load failures are best-effort and just disable the optional sections.
function prewarmPromptOptions(
  localCwd: string,
  branch: string,
): {
  branch: string;
  workspace: string;
  developMode: boolean;
  scratchEnabled: boolean;
} {
  let developMode = false;
  let scratchEnabled = true;
  try {
    const config = loadGondolinConfig(
      localCwd,
      path.join(os.homedir(), ".pi", "agent"),
    );
    developMode = config.developMode === true;
    scratchEnabled = config.scratch !== false;
  } catch {
    // keep defaults
  }
  return {
    branch,
    workspace: guestWorkspace(branch),
    developMode,
    scratchEnabled,
  };
}
