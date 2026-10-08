import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { GUEST_WORKSPACE, DEFAULT_WORK_BRANCH } from "./config";
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

  // The VM is started lazily: by /build-in-sandbox (with the generated
  // branch) or by the first tool call that needs it (default branch).
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!sandbox.vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    await sandbox.close();
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

  // Replace the CWD line in the system prompt so the model sees /workspace
  pi.on("before_agent_start", async (event, ctx) => {
    await sandbox.ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (sandboxed git worktree ${sandbox.branch ?? DEFAULT_WORK_BRANCH})`,
    );
    return { systemPrompt: modified };
  });
}
