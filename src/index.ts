import os from "node:os";
import path from "node:path";
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
  SANDBOX_ENTRY_TYPE,
  SANDBOX_PREAMBLE_TYPE,
  SUBAGENT_RESULT_TYPE,
  SUBAGENT_STATUS_TYPE,
  type SandboxEntryData,
} from "./config";
import { loadGondolinConfig } from "./config-loader";
import { loadDotEnv } from "./dotenv";
import { renderPreamble, skillNames } from "./preamble";
import {
  buildSkillContext,
  isHostServedPath,
  renderedSkillPaths,
  stubSkillPaths,
} from "./skills";
import { createSandbox } from "./vm";
import { VmStartupWidget } from "./startup-widget";
import { registerBuildCommand } from "./commands/build-in-sandbox";
import {
  createSubagentManager,
  formatSettledNotice,
  type SubagentManager,
} from "./subagents";
import { createGondolinReadOps } from "./ops/read";
import { createGondolinWriteOps } from "./ops/write";
import { createGondolinEditOps } from "./ops/edit";
import { createGondolinBashOps } from "./ops/bash";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localGitDir = `${localCwd}/.git`;
  // The pi agent dir, where the global gondolin.json lives.
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  // Load the host's .env into process.env so its values are available for
  // secret resolution (see config-loader.ts resolveSecrets). Only variables
  // not already set in the environment are added.
  loadDotEnv(path.join(localCwd, ".env"));

  // Package root and the skills template dir, shared by the preamble and
  // the resources_discover hook below.
  const packageDir = path.resolve(__dirname, "..");
  const skillsTemplateDir = path.join(packageDir, "skills");

  // Write the skill stubs at load time: real (static, config-independent)
  // front matter plus a placeholder body. pi discovers skills only at
  // session start/reload and caches only the front matter — the body is
  // re-read from disk whenever the agent loads the skill — so the real
  // bodies can be rendered in place (same paths) when the sandbox is
  // entered, with no system-prompt change. The files live on the host only:
  // pi's skill loader reads the front matter there, and the wrapped read
  // tool serves the files to the agent (see below), so the sandbox worktree
  // is never touched.
  const skillsDir = stubSkillPaths(skillsTemplateDir);

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  // Host dirs served to the agent by the read tool instead of the guest:
  // the rendered gondolin skills (host temp dir) and the global skill roots
  // (pi's system prompt lists every skill by its host path — repo-local
  // skills are under the repo root and map into the worktree, but global
  // skills live outside it and would fail the containment check). Writes
  // and edits to these dirs are still rejected by the containment check,
  // so they stay read-only from the agent's view.
  const hostServedSkillRoots = [
    skillsDir,
    path.join(agentDir, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];

  const sandbox = createSandbox(localCwd, localGitDir, {
    onLaunchStart: (branch) => showStartupWidget(branch),
    onNotice: (_branch, message) => updateStartupLine(message),
    onLaunchSettled: () => hideStartupWidget(),
  });

  // Send the sandbox preamble: a non-display custom message telling the
  // agent that its session parameters have changed (new cwd, branch,
  // persistence rules) and which skills carry the further detail. Sent in
  // place of modifying the system prompt — the latter invalidates the
  // inference prefix cache. No triggerTurn: the preamble only appends
  // context; the next user message starts the turn. One preamble per branch
  // per session (force bypasses the guard), so the first tool call awaiting
  // /build-in-sandbox's in-flight launch does not duplicate it.
  let preambleSentFor: string | null = null;
  function sendSandboxPreamble(
    ctx: ExtensionContext,
    branch: string,
    force = false,
  ): void {
    if (!force && preambleSentFor === branch) return;
    preambleSentFor = branch;
    pi.sendMessage(
      {
        customType: SANDBOX_PREAMBLE_TYPE,
        content: renderPreamble(
          packageDir,
          branch,
          skillNames(skillsTemplateDir),
        ),
        display: false,
        details: { branch },
      },
    );
  }

  // Latest ExtensionContext seen by a hook or tool, used to refresh the
  // status bar and the subagent spinner from background state changes.
  let lastCtx: ExtensionContext | undefined;
  let shuttingDown = false;
  // The subagent manager exists only once the sandbox is entered.
  let subagentManager: SubagentManager | null = null;
  // Braille spinner frames, animated while at least one subagent runs.
  const spinnerFrames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u280f", "\u2866", "\u2827", "\u2807", "\u280f"];
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;
  function touch(ctx: ExtensionContext): void {
    lastCtx = ctx;
  }
  function stopSpinner(): void {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    spinnerFrame = 0;
  }
  function renderSpinner(ctx: ExtensionContext): void {
    const running = subagentManager?.runningCount() ?? 0;
    if (running === 0) {
      stopSpinner();
      ctx.ui.setWidget("gondolin-subagents", undefined);
      return;
    }
    const frame = spinnerFrames[spinnerFrame % spinnerFrames.length]!;
    spinnerFrame += 1;
    ctx.ui.setWidget(
      "gondolin-subagents",
      [
        ctx.ui.theme.fg(
          "accent",
          `${frame} ${running} subagent${running > 1 ? "s" : ""} running`,
        ),
      ],
    );
  }
  function startSpinner(ctx: ExtensionContext): void {
    if (spinnerTimer) return;
    renderSpinner(ctx);
    spinnerTimer = setInterval(() => {
      if (lastCtx) renderSpinner(lastCtx);
    }, 80);
  }

  // VM startup progress widget: an animated spinner plus the latest boot
  // log line, above the editor (next to the "Working" spinner). Shown
  // while the main VM launches, cleared when it is ready. Keeping the
  // boot logs out of the transcript means they never mix with the first
  // turn's output.
  let startupWidget: VmStartupWidget | undefined;
  function showStartupWidget(branch: string): void {
    if (!lastCtx || startupWidget) return;
    lastCtx.ui.setWidget("gondolin-startup", (tui, theme) => {
      startupWidget = new VmStartupWidget(tui, theme, branch);
      return startupWidget;
    });
  }
  function updateStartupLine(message: string): void {
    if (startupWidget) startupWidget.latestLine = message;
  }
  function hideStartupWidget(): void {
    if (!startupWidget) return;
    startupWidget = undefined;
    if (lastCtx) lastCtx.ui.setWidget("gondolin-startup", undefined);
  }
  function updateStatus(ctx: ExtensionContext | undefined): void {
    if (!ctx || shuttingDown) return;
    const running = subagentManager?.runningCount() ?? 0;
    const parts = [`gondolin: ${sandbox.branch ?? "stopped"}`];
    if (running > 0) {
      parts.push(`${running} subagent${running > 1 ? "s" : ""} running`);
    }
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", parts.join(" \u00b7 ")),
    );
    // Animate a spinner widget above the editor while subagents run; clear
    // it once the last one settles.
    if (running > 0) {
      startSpinner(ctx);
    } else {
      stopSpinner();
      ctx.ui.setWidget("gondolin-subagents", undefined);
    }
  }

  // Enter the sandbox: render the real skill bodies in place (over the
  // stubs, same paths — no system-prompt change), create the subagent
  // manager, and register the session-scoped hooks (shutdown cleanup,
  // user-! routing). Runs once, from /build-in-sandbox or session_start
  // (resuming a sandbox session).
  let entered = false;
  function enterSandbox(ctx: ExtensionContext): void {
    if (entered) return;
    entered = true;
    touch(ctx);

    // Render the real skill bodies over the stubs. The config is a tiny
    // JSON read; loading it here (at entry, not load) keeps the stub path
    // config-free and the render always current.
    const config = loadGondolinConfig(localCwd, agentDir);
    renderedSkillPaths(skillsTemplateDir, buildSkillContext(config));

    // Detached subagent sessions: each gets its own VM and work branch,
    // runs in the background, and is checked via the subagent_status tool.
    // When a subagent settles, its result is proactively queued into this
    // session as a custom message that triggers the agent's next turn — the
    // agent does not have to poll for it.
    subagentManager = createSubagentManager({
      localCwd,
      localGitDir,
      parentBranch: () => sandbox.branch,
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

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      stopSpinner();
      hideStartupWidget();
      ctx.ui.setWidget("gondolin-subagents", undefined);
      ctx.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("muted", "gondolin: stopping"),
      );
      // Abort background subagents first: each cleans up its own worktree
      // and VM while the guests are still up.
      if (subagentManager) await subagentManager.shutdown();
      // Remove this session's worktree (selective) while the guest still has it,
      // so its shared .git registration is cleaned up. A crash skips this; the
      // next start detects the leftover in prepare.sh and asks the user to
      // prune it manually.
      await sandbox.removeWorktree();
      await sandbox.close();
      ctx.ui.setStatus("gondolin", undefined);
    });

    // Run user `!` commands inside the VM too
    pi.on("user_bash", (_event, _ctx) => {
      if (!sandbox.vm || !sandbox.workspace) return;
      return { operations: createGondolinBashOps(sandbox.vm, localCwd, sandbox.workspace) };
    });

    updateStatus(ctx);
  }

  // All tools are registered at load time (not in enterSandbox) so the
  // system prompt is built once at session start and never modified:
  // re-registering tools mid-session rebuilds it and invalidates the
  // inference prefix cache. The wrapped tools are behaviorally inert until
  // the sandbox is entered (they fall back to the local host tools), and
  // the subagent tools report that the sandbox is not active.
  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      touch(ctx);
      // Skill files listed in the prompt (gondolin's rendered skills and
      // global skills) live on the host only; serve them with the plain
      // read tool so the agent can check them. Everything else routes to
      // the guest (repo-local skills map into the worktree). Writes/
      // edits to the skills dirs are still rejected by the containment
      // check — the skills are read-only from the agent's view.
      if (
        typeof params.path === "string" &&
        isHostServedPath(localCwd, params.path, hostServedSkillRoots)
      ) {
        return localRead.execute(id, params, signal, onUpdate);
      }
      // No VM running and no launch in flight: the sandbox is not active,
      // so the tool runs locally.
      if (!sandbox.active) {
        return localRead.execute(id, params, signal, onUpdate);
      }
      const activeVm = await sandbox.requireVm(ctx);
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
      if (!sandbox.active) {
        return localWrite.execute(id, params, signal, onUpdate);
      }
      const activeVm = await sandbox.requireVm(ctx);
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
      if (!sandbox.active) {
        return localEdit.execute(id, params, signal, onUpdate);
      }
      const activeVm = await sandbox.requireVm(ctx);
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
      if (!sandbox.active) {
        return localBash.execute(id, params, signal, onUpdate);
      }
      const activeVm = await sandbox.requireVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd, sandbox.workspace!),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Result for subagent tools called before the sandbox is entered.
  function sandboxNotActive() {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "gondolin: the sandbox is not active — run /build-in-sandbox first",
        },
      ],
      details: {},
      isError: true,
    };
  }

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
        if (!subagentManager) return sandboxNotActive();
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
          const rec = await subagentManager.spawn(params.prompt, ctx);
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
        if (!subagentManager) return sandboxNotActive();
        const text = subagentManager.status(params.id, params.defer_time);
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
        if (!subagentManager) return sandboxNotActive();
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
        const rec = subagentManager.abort(id);
        if (!rec) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No subagent with id ${id} exists. Known ids: ${
                  subagentManager.list().map((r) => r.id).join(", ") || "(none)"
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

  // /build-in-sandbox <prompt>: names a branch, launches the VM for it,
  // and starts the first agent turn with the user's prompt (concurrently with
  // the VM launch). onSandboxStart activates the sandbox and sends the
  // preamble ahead of the first user prompt.
  registerBuildCommand(pi, sandbox, {
    onSandboxStart: (ctx, branch) => {
      enterSandbox(ctx);
      sendSandboxPreamble(ctx, branch);
    },
  });

  // Bring the sandbox back up when a session that ran in the sandbox is
  // started, resumed, reloaded, or forked. /build-in-sandbox persists the
  // work branch as a custom entry.
  pi.on("session_start", async (_event, ctx) => {
    touch(ctx);
    const branch = lastSandboxBranch(ctx.sessionManager.getBranch());
    if (branch) {
      enterSandbox(ctx);
      await sandbox.launch(branch, ctx);
      // Refresh the sandbox context: the session resumes in the sandbox, and
      // a fresh preamble is cheap and covers config changes since the
      // original session (the stale one stays in the conversation history).
      sendSandboxPreamble(ctx, branch, true);
    }
  });

  // Serve gondolin's skills as rendered templates: the raw .md files in the
  // package's skills/ directory are templates, rendered with a context
  // derived from the config (available github hosts, secrets, features).
  // Stubs go in at load time (session start); the real bodies are rendered
  // over them in enterSandbox.
  pi.on("resources_discover", () => {
    return { skillPaths: [skillsDir] };
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
