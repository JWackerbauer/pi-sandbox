import { execFile } from "node:child_process";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { VM } from "@earendil-works/gondolin";
import { requestBranchName } from "./branch-name";
import { BRANCH_NAME_MAX_LENGTH } from "./config";
import { guestWorkspace } from "./config";
import { createGondolinBashOps } from "./ops/bash";
import { createGondolinEditOps } from "./ops/edit";
import { createGondolinReadOps } from "./ops/read";
import { createGondolinWriteOps } from "./ops/write";
import { launchDetachedVm, removeDetachedWorktree } from "./vm";

export type SubagentStatus = "running" | "completed" | "failed";

export interface SubagentRecord {
  /** Stable id for this subagent within the session, e.g. "sub-1". */
  id: string;
  /** The subagent's own work branch in the shared repository. */
  branch: string;
  /** Ref (branch name or commit) the subagent branch was created from. */
  branchStart: string;
  /** The task the subagent was spawned with. */
  prompt: string;
  status: SubagentStatus;
  /** Final assistant text (or partial text on failure). */
  summary?: string;
  /** `git log --oneline branchStart..branch`, if the run finished. */
  commits?: string[];
  /** Error message, when status is "failed". */
  error?: string;
}

export interface SubagentManager {
  /**
   * Spawn a subagent: name a branch from the prompt, launch a detached VM
   * for it (based on the parent's branch), and start a background agent
   * session on it. Resolves once the VM is up and the session has started;
   * the agent run itself continues in the background.
   */
  spawn: (prompt: string, ctx: ExtensionContext) => Promise<SubagentRecord>;
  /**
   * A text snapshot of all subagents. When `id` is given, only that
   * subagent is considered. Blocks until at least one of the considered
   * subagents has finished (unless results are already available or there
   * are none), so the caller can use it to "stop and wait".
   */
  results: (id?: string, signal?: AbortSignal) => Promise<string>;
  /** Number of subagents still running. */
  runningCount: () => number;
  /** All subagents, in spawn order. */
  list: () => SubagentRecord[];
  /**
   * Abort every running subagent and wait for its cleanup (session
   * disposal, worktree removal, VM close). Called on session shutdown.
   */
  shutdown: () => Promise<void>;
}

interface InternalRecord extends SubagentRecord {
  vm: VM;
  session: AgentSession | null;
  settle: Promise<void>;
}

export interface SubagentManagerOptions {
  localCwd: string;
  localGitDir: string;
  /** The parent session's work branch; subagent branches are based on it. */
  parentBranch: () => string;
  /** Called after any status change, so the host can refresh UI. */
  onStatusChange?: () => void;
}

export function createSubagentManager(
  opts: SubagentManagerOptions,
): SubagentManager {
  const { localCwd, localGitDir, parentBranch, onStatusChange } = opts;

  const records: InternalRecord[] = [];
  let counter = 0;
  let shuttingDown = false;

  // Serialize the part of a spawn that touches the shared .git (branch name
  // allocation, start-point resolution, worktree creation) so concurrent
  // spawns cannot pick the same branch name or race on the same refs. The
  // long agent run itself is never serialized.
  let spawnChain: Promise<unknown> = Promise.resolve();
  function withSerial<T>(fn: () => Promise<T>): Promise<T> {
    const p = spawnChain.then(fn, fn);
    spawnChain = p.catch(() => undefined);
    return p;
  }

  async function spawn(
    prompt: string,
    ctx: ExtensionContext,
  ): Promise<SubagentRecord> {
    if (shuttingDown) throw new Error("gondolin: session is shutting down");
    const model = ctx.model;
    if (!model) throw new Error("no model selected — pick one with /model first");

    return withSerial(async () => {
      const base = await requestBranchName(model, ctx.modelRegistry, prompt);
      const branch = await uniqueBranchName(base);

      // Base the subagent branch on the parent's branch when it exists in
      // the shared .git, otherwise on the current HEAD commit, so the
      // parent can always merge the result back in cleanly.
      const parent = parentBranch();
      const branchStart = (await refExists(parent))
        ? parent
        : await hostGit(["rev-parse", "HEAD"]);

      const vm = await launchDetachedVm(branch, {
        localCwd,
        localGitDir,
        branchStart,
      });

      counter += 1;
      let resolveSettle: () => void;
      const settle = new Promise<void>((r) => (resolveSettle = r));
      const record: InternalRecord = {
        id: `sub-${counter}`,
        branch,
        branchStart,
        prompt,
        status: "running",
        vm,
        session: null,
        settle,
      };
      records.push(record);
      onStatusChange?.();

      // The agent run is fully in the background: this resolves as soon as
      // the VM is up and the session has been started. The promise executor
      // runs synchronously, so the resolver is assigned by now.
      void run(record, model, resolveSettle!);
      return record;
    });
  }

  async function run(
    record: InternalRecord,
    model: Model<any>,
    resolveSettle: () => void,
  ): Promise<void> {
    let session: AgentSession | null = null;
    try {
      session = await createSubagentSession(record, model);
      record.session = session;
      await session.prompt(record.prompt);
      record.summary = session.getLastAssistantText() ?? "";
      record.status = "completed";
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      if (session) record.summary = session.getLastAssistantText() ?? "";
    } finally {
      if (session) session.dispose();
      try {
        record.commits = (
          await hostGit(["log", "--oneline", `${record.branchStart}..${record.branch}`])
        ).split("\n");
        if (record.commits.length === 1 && record.commits[0] === "") {
          record.commits = [];
        }
      } catch {
        record.commits = [];
      }
      // The branch (the persistent artifact) stays; drop the worktree and
      // the VM while the guest still has them.
      await removeDetachedWorktree(record.vm, record.branch);
      try {
        await record.vm.close();
      } catch {
        // best effort
      }
      onStatusChange?.();
      resolveSettle();
    }
  }

  // A detached SDK agent session: in-memory (no session file), no
  // extensions/skills/templates/themes/context files (so the parent's
  // gondolin extension is not loaded twice), and the four built-in tools
  // re-created with operations routed into this subagent's guest VM.
  async function createSubagentSession(
    record: InternalRecord,
    model: Model<any>,
  ): Promise<AgentSession> {
    const ws = guestWorkspace(record.branch);
    const loader = new DefaultResourceLoader({
      cwd: localCwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: subagentSystemPrompt(record),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: localCwd,
      model,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: loader,
      noTools: "builtin",
      customTools: [
        createReadToolDefinition(localCwd, {
          operations: createGondolinReadOps(record.vm, localCwd, ws),
        }) as ToolDefinition,
        createWriteToolDefinition(localCwd, {
          operations: createGondolinWriteOps(record.vm, localCwd, ws),
        }) as ToolDefinition,
        createEditToolDefinition(localCwd, {
          operations: createGondolinEditOps(record.vm, localCwd, ws),
        }) as ToolDefinition,
        createBashToolDefinition(localCwd, {
          operations: createGondolinBashOps(record.vm, localCwd, ws),
        }) as ToolDefinition,
      ],
    });
    return session;
  }

  async function results(id?: string, signal?: AbortSignal): Promise<string> {
    const relevant = () => records.filter((r) => !id || r.id === id);
    if (id && !records.some((r) => r.id === id)) {
      return `No subagent with id ${id} exists. Known ids: ${
        records.map((r) => r.id).join(", ") || "(none)"
      }`;
    }
    for (;;) {
      const settled = relevant().filter((r) => r.status !== "running");
      const running = relevant().filter((r) => r.status === "running");
      if (settled.length > 0 || running.length === 0) {
        return formatResults();
      }
      // The caller was aborted while subagents are still running: return
      // the current snapshot instead of waiting (or spinning).
      if (signal?.aborted) return formatResults();
      // Nothing finished yet: wait until at least one running subagent
      // settles (or the caller is aborted).
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return; // no signal: wait indefinitely
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([
        Promise.allSettled(running.map((r) => r.settle)),
        aborted,
      ]);
    }
  }

  function runningCount(): number {
    return records.filter((r) => r.status === "running").length;
  }

  function list(): SubagentRecord[] {
    return records.map((r) => ({
      id: r.id,
      branch: r.branch,
      branchStart: r.branchStart,
      prompt: r.prompt,
      status: r.status,
      summary: r.summary,
      commits: r.commits,
      error: r.error,
    }));
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    // Wait for an in-flight spawn (VM launch) to finish first, then abort
    // every running session; each run() cleans up its worktree and VM.
    await spawnChain;
    for (const r of records) {
      if (r.session) r.session.dispose();
    }
    await Promise.allSettled(records.map((r) => r.settle));
  }

  // The branch name must not already exist in the shared repository: a
  // subagent always gets a fresh branch to commit to. Suffix with -2, -3, …
  // (trimming the stem to stay within BRANCH_NAME_MAX_LENGTH) until unique.
  async function uniqueBranchName(base: string): Promise<string> {
    if (!(await refExists(base))) return base;
    let stem = base;
    for (let i = 2; ; i++) {
      const suffix = `-${i}`;
      const maxStem = BRANCH_NAME_MAX_LENGTH - suffix.length;
      if (stem.length > maxStem) stem = stem.slice(0, maxStem).replace(/-+$/, "");
      const candidate = `${stem}${suffix}`;
      if (!(await refExists(candidate))) return candidate;
    }
  }

  // Host-side git helpers: the shared .git is the host's .git, so refs and
  // history can be inspected directly from the host.
  function hostGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["-C", localCwd, ...args],
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`${stderr.trim() || err.message}`));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  function refExists(ref: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-C", localCwd, "show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
        { timeout: 30_000 },
        (err) => resolve(err === null),
      );
    });
  }

  function formatResults(): string {
    if (records.length === 0) {
      return "No subagents have been spawned. Use spawn_subagent to start one.";
    }
    const lines: string[] = ["Subagents:"];
    for (const r of records) {
      lines.push(
        `[${r.id}] branch: ${r.branch} — ${r.status === "failed" ? "FAILED" : r.status}`,
      );
      if (r.status === "running") continue;
      lines.push(`  based on: ${r.branchStart}`);
      if (r.status === "failed" && r.error) {
        lines.push(`  error: ${r.error}`);
      }
      if (r.commits && r.commits.length > 0) {
        lines.push("  commits:");
        for (const c of r.commits) lines.push(`    ${c}`);
      } else {
        lines.push("  commits: (none)");
      }
      if (r.summary) {
        lines.push("  summary:");
        for (const s of r.summary.split("\n")) lines.push(`    ${s}`);
      }
    }
    lines.push(
      "",
      "Review a finished branch with `git log <branch>` / `git diff <start>..<branch>`,",
      "then merge it into your branch with `git merge <branch>` if the work is good.",
    );
    return lines.join("\n");
  }

  return { spawn, results, runningCount, list, shutdown };
}

// ─── Subagent system prompt ─────────────────────────────────────────────

function subagentSystemPrompt(record: InternalRecord): string {
  return `You are a subagent of the pi coding agent, running inside a gondolin sandbox. A parent agent spawned you to complete the task given in the user message, on your own work branch.

<tools>
- bash: Execute bash commands (ls, grep, find, etc.)
- read: Read the contents of a file (text or image)
- edit: Edit a file using exact text replacements
- write: Write content to a file
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<cwd>
You are working in a gondolin sandbox; cwd: ${guestWorkspace(record.branch)} (a git worktree owned by you, branch: ${record.branch})
Your branch was created from ${record.branchStart}. You share the source git repository with the parent agent and the user, so your commits are visible to them as soon as you make them.
Do not commit to any other branch; do not merge your branch.
The shared git repository is the ONLY persistence in the sandbox; the rest of the filesystem is ephemeral. You must commit all relevant work to your branch (${record.branch}) otherwise it will be lost.
</cwd>

When you have finished the task, stop working and end with a short summary of what you did: the changes you made, the commits you created, and any caveats. The parent agent will read this summary and review your branch.`;
}
