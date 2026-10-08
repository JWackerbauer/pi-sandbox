import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_WORK_BRANCH,
  SANDBOX_ENTRY_TYPE,
  SUBAGENT_RESULT_TYPE,
  SUBAGENT_STATUS_TYPE,
  type SandboxEntryData,
} from "./config";
import { createSandbox } from "./vm";
import { registerBuildCommand } from "./commands/build-in-sandbox";
import { createSubagentManager, formatSettledNotice } from "./subagents";
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

  // Latest ExtensionContext seen by a hook or tool, used to refresh the
  // status bar from background subagent state changes.
  let lastCtx: ExtensionContext | undefined;
  let shuttingDown = false;
  function touch(ctx: ExtensionContext): void {
    lastCtx = ctx;
  }
  function updateStatus(ctx: ExtensionContext | undefined): void {
    if (!ctx || shuttingDown) return;
    const running = subagents.runningCount();
    const parts = [`gondolin: ${sandbox.branch ?? "stopped"}`];
    if (running > 0) {
      parts.push(`${running} subagent${running > 1 ? "s" : ""} running`);
    }
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", parts.join(" \u00b7 ")),
    );
  }

  // Detached subagent sessions: each gets its own VM and work branch, runs
  // in the background, and is checked via the subagent_status tool.
  // When a subagent settles, its result is proactively queued into this
  // session as a custom message that triggers the agent's next turn — the
  // agent does not have to poll for it.
  const subagents = createSubagentManager({
    localCwd,
    localGitDir,
    parentBranch: () => sandbox.branch ?? DEFAULT_WORK_BRANCH,
    onStatusChange: () => updateStatus(lastCtx),
    onSettled: (rec) => {
      if (shuttingDown) return;
      pi.sendMessage(
        {
          customType: SUBAGENT_RESULT_TYPE,
          content: formatSettledNotice(rec),
          display: true,
          details: { id: rec.id, branch: rec.branch },
        },
        {
          triggerTurn: true,
          // Mid-turn: queued as a follow-up that starts a new turn once the
          // current run finishes. Idle: appended and starts a turn now.
          deliverAs: "followUp",
        },
      );
    },
    onDeferredStatus: (id, text) => {
      if (shuttingDown) return;
      pi.sendMessage(
        {
          customType: SUBAGENT_STATUS_TYPE,
          content: text,
          display: true,
          details: { id },
        },
        {
          triggerTurn: true,
          deliverAs: "followUp",
        },
      );
    },
  });

  // /build-in-sandbox <prompt>: names a branch, launches the VM for it,
  // and starts the first turn with the user's prompt.
  registerBuildCommand(pi, sandbox);

  // Bring the sandbox back up when a session that ran in the sandbox is
  // started, resumed, reloaded, or forked. /build-in-sandbox persists the
  // work branch as a custom entry.
  pi.on("session_start", async (_event, ctx) => {
    touch(ctx);
    const branch = lastSandboxBranch(ctx.sessionManager.getBranch());
    if (branch) {
      await sandbox.launch(branch, ctx);
    }
  });

  // The VM is started lazily: by /build-in-sandbox (with the generated
  // branch) or by the first tool call that needs it (default branch).
  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "gondolin: stopping"),
    );
    // Abort background subagents first: each cleans up its own worktree
    // and VM while the guests are still up.
    await subagents.shutdown();
    // Remove this session's worktree (selective) while the guest still has it,
    // so its shared .git registration is cleaned up. A crash skips this; the
    // next start detects the leftover in prepare.sh and asks the user to
    // prune it manually.
    await sandbox.removeWorktree();
    await sandbox.close();
    ctx.ui.setStatus("gondolin", undefined);
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      touch(ctx);
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd, sandbox.workspace!),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      touch(ctx);
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd, sandbox.workspace!),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      touch(ctx);
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd, sandbox.workspace!),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      touch(ctx);
      const activeVm = await sandbox.ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd, sandbox.workspace!),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Spawn a detached sandbox session for a subagent. Same interface as
  // /build-in-sandbox: the prompt is summarized into a branch name, a
  // detached VM is launched for that branch (based on the parent's
  // branch), and a background agent session works on the prompt. This tool
  // returns as soon as the VM is up; the subagent keeps running while the
  // parent continues its own work.
  pi.registerTool(
    defineTool({
      name: "spawn_subagent",
      label: "Spawn subagent",
      promptSnippet:
        "spawn_subagent: spawn a background subagent in its own detached " +
        "sandbox session (own VM + work branch based on yours)",
      description:
        "Spawn a subagent in its own detached sandbox session. The subagent " +
        "gets its own VM and a fresh work branch created from your current " +
        "branch, and works on the given task in the background while you " +
        "continue. You can spawn several subagents and let them run in " +
        "parallel. When a subagent finishes, its result (summary and " +
        "commits) is delivered to you proactively as a message on your next " +
        "turn — you do not have to poll for it. Use subagent_status to " +
        "check on a running subagent; pass defer_time (seconds) to schedule " +
        "a status check that arrives as a message later without blocking. " +
        "Review a finished branch and merge it into yours with git merge " +
        "if the work is good.",
      parameters: Type.Object({
        prompt: Type.String({
          description: "What the subagent should build or do",
        }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        touch(ctx);
        if (params.prompt.trim().length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "gondolin: spawn_subagent requires a non-empty prompt",
              },
            ],
            details: {},
            isError: true,
          };
        }
        try {
          const rec = await subagents.spawn(params.prompt, ctx);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Subagent ${rec.id} is running on branch ${rec.branch} ` +
                  `(created from ${rec.branchStart}). ` +
                  `Continue your work or spawn more subagents; its result ` +
                  `will be delivered to you when it finishes. To check on it ` +
                  `later without blocking, call subagent_status with ` +
                  `defer_time (seconds).`,
              },
            ],
            details: { id: rec.id, branch: rec.branch },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `gondolin: ${message}` }],
            details: {},
            isError: true,
          };
        }
      },
    }),
  );

  // Non-blocking subagent status check. Reports each subagent's state and, for
  // running ones, activity diagnostics (elapsed, last activity, recent tool
  // calls) with heuristics that flag a subagent that appears stuck or
  // looping. Results are also delivered proactively when a subagent
  // finishes, so this is for checking on running subagents. Pass defer_time
  // (seconds) to schedule the check in the background: the tool returns
  // immediately and the status is delivered to the agent as a message after
  // the delay — "dispatch a subagent and check on it in 5 minutes".
  pi.registerTool(
    defineTool({
      name: "subagent_status",
      label: "Subagent status",
      promptSnippet:
        "subagent_status: non-blocking check on spawned subagents; use " +
        "defer_time (seconds) to check later in the background",
      description:
        "Check on spawned subagents without blocking. Returns each " +
        "subagent's state; for running ones it includes elapsed time, last " +
        "activity, recent tool calls, and hints when a subagent appears stuck " +
        "(no recent activity) or looping (repeating the same action). " +
        "Finished subagents report themselves proactively, so use this to " +
        "monitor running ones. Optionally pass an id to inspect one " +
        "subagent. To check later without blocking, pass defer_time in " +
        "seconds: the tool returns now and the status is delivered to you as " +
        "a message after the delay.",
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Only report on this subagent id" }),
        ),
        defer_time: Type.Optional(
          Type.Number({
            description:
              "Seconds to wait before delivering the status as a message " +
              "(checked in the background, does not block this turn).",
          }),
        ),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        touch(ctx);
        const text = subagents.status(params.id, params.defer_time);
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    }),
  );

  // Stop a specific subagent. Use this when subagent_status shows one that is
  // stuck or looping. Aborting disposes the subagent's session (aborting the
  // in-flight run) and cleans up its VM and worktree, but keeps the branch
  // and any commits already made, so the parent can still review and merge.
  pi.registerTool(
    defineTool({
      name: "subagent_abort",
      label: "Abort subagent",
      promptSnippet:
        "subagent_abort: stop a running subagent by id (its branch/commits are kept)",
      description:
        "Stop a running subagent by id. Use this when a subagent appears " +
        "stuck or looping (see subagent_status). The subagent's session is " +
        "aborted and its VM and worktree are cleaned up, but any commits it " +
        "already made stay on its branch for you to review and merge. The " +
        "settlement notice will follow once cleanup finishes. If the " +
        "subagent has already finished, this is a no-op and reports its " +
        "final state.",
      parameters: Type.Object({
        id: Type.String({ description: "The subagent id to abort" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        touch(ctx);
        const id = params.id.trim();
        if (id.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "gondolin: subagent_abort requires an id",
              },
            ],
            details: {},
            isError: true,
          };
        }
        const rec = subagents.abort(id);
        if (!rec) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No subagent with id ${id} exists. Known ids: ${
                  subagents.list().map((r) => r.id).join(", ") || "(none)"
                }`,
              },
            ],
            details: {},
            isError: true,
          };
        }
        // abort() is synchronous; the actual stop + cleanup happens in the
        // background, confirmed by the settlement notice.
        const wasRunning = rec.status === "running";
        return {
          content: [
            {
              type: "text" as const,
              text: wasRunning
                ? `Aborted subagent ${rec.id} (branch ${rec.branch}). Its ` +
                  `session is stopping; any commits it already made remain on ` +
                  `the branch for you to review. You'll be notified when ` +
                  `cleanup finishes.`
                : `Subagent ${rec.id} is not running (status: ${rec.status}); ` +
                  `nothing to abort.`,
            },
          ],
          details: { id: rec.id, branch: rec.branch, status: rec.status },
        };
      },
    }),
  );

  // Run user `!` commands inside the VM too
  pi.on("user_bash", (_event, _ctx) => {
    if (!sandbox.vm || !sandbox.workspace) return;
    return { operations: createGondolinBashOps(sandbox.vm, localCwd, sandbox.workspace) };
  });

  // Replace the CWD section in the system prompt so the model sees /workspace
  // and knows that only the git repository is persistent.
  pi.on("before_agent_start", async (event, ctx) => {
    touch(ctx);
    await sandbox.ensureVm(ctx);
    event.systemPromptOptions.sections.cwd =
      `You are working in a gondolin sandbox; cwd: ${sandbox.workspace} (a git worktree owned by you, branch: ` +
      `${sandbox.branch ?? DEFAULT_WORK_BRANCH})\n` +
      `You share the source git repository with the user, the user can review & merge your changes on their host. ` +
      `Do not commit to any other branch; do not merge your branch. Ask the user to review & merge instead.\n` +
      `The shared git repository is the ONLY persistence in the sandbox; the rest of the filesystem is ephemeral. ` +
      `You must commit all relevant work to your branch (${sandbox.branch ?? DEFAULT_WORK_BRANCH}) otherwise it will be lost.\n` +
      `You can delegate work to subagents with the spawn_subagent tool: each runs in its own detached sandbox session ` +
      `on a fresh branch created from your branch, in the background. When one finishes, its result (summary and commits) ` +
      `is delivered to you as a message; review the branch and merge it into your branch with git merge if the work is good. ` +
      `Use subagent_status to check on running subagents (non-blocking); pass defer_time (seconds) to check on one later ` +
      `without blocking this turn. If one appears stuck or looping, stop it with subagent_abort (its commits are kept).`;
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
