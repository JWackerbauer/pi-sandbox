import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  GUEST_WORKSPACE,
  DEFAULT_WORK_BRANCH,
  SANDBOX_ENTRY_TYPE,
  type SandboxEntryData,
} from "./config";
import { createSandbox } from "./vm";
import { registerBuildCommand } from "./commands/build-in-sandbox";
import { createGondolinReadOps } from "./ops/read";
import { createGondolinWriteOps } from "./ops/write";
import { createGondolinEditOps } from "./ops/edit";
import { createGondolinBashOps } from "./ops/bash";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localGitDir = `${localCwd}/.git`;

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  const sandbox = createSandbox(localCwd, localGitDir);

  // /build-in-sandbox <prompt>: names a branch, launches the VM for it,
  // and starts the first turn with the user's prompt.
  registerBuildCommand(pi, sandbox);

  // Bring the sandbox back up when a session that ran in the sandbox is
  // started, resumed, reloaded, or forked. /build-in-sandbox persists the
  // work branch as a custom entry.
  pi.on("session_start", async (_event, ctx) => {
    const branch = lastSandboxBranch(ctx.sessionManager.getBranch());
    if (branch) {
      await sandbox.launch(branch, ctx);
    }
  });

  // The VM is started lazily: by /build-in-sandbox (with the generated
  // branch) or by the first tool call that needs it (default branch).
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!sandbox.vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "gondolin: stopping"),
    );
    await sandbox.close();
    ctx.ui.setStatus("gondolin", undefined);
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Run user `!` commands inside the VM too
  pi.on("user_bash", (_event, _ctx) => {
    if (!sandbox.vm) return;
    return { operations: createGondolinBashOps(sandbox.vm, localCwd) };
  });

  // Replace the CWD section in the system prompt so the model sees /workspace
  // and knows that only the git repository is persistent.
  pi.on("before_agent_start", async (event, ctx) => {
    await sandbox.ensureVm(ctx);
    event.systemPromptOptions.sections.cwd =
      `${GUEST_WORKSPACE} (sandboxed git worktree on branch ` +
      `${sandbox.branch ?? DEFAULT_WORK_BRANCH})\n` +
      `Only the shared git repository is persistent inside the sandbox; the rest ` +
      `of the filesystem is ephemeral. Commit your work to the current branch ` +
      `so it is not lost.`;
  });
}

// The work branch of the most recent /build-in-sandbox in this session
// branch, if any.
function lastSandboxBranch(
  entries: SessionEntry[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === SANDBOX_ENTRY_TYPE) {
      return (entry.data as SandboxEntryData | undefined)?.branch;
    }
  }
  return undefined;
}
