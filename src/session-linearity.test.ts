// Tests that entering and exiting the gondolin sandbox repeatedly keeps the
// session history fully linear, so the inference prefix cache is never
// evicted:
//
// - Every turn appends to the tail of the history; the session tree never
//   forks. Every entry lies on the active leaf path, in append order —
//   nothing is dropped, rewritten, or reordered.
// - Consequently the LLM-visible message list only ever grows as a prefix
//   extension: each new context starts with exactly the messages the
//   previous context had, so the provider can keep its prefix cache warm
//   across sandbox enter, exit, and resume.
//
// The test drives the real extension factory (src/index.ts) through a
// realistic lifecycle — host turn, /sandbox-build, sandbox turn,
// /sandbox-exit, host turn, re-enter, resume while sandboxed (session_start),
// exit, resume on the host — with a mock pi API whose
// sendMessage/sendUserMessage/appendEntry implement pi's append-to-leaf
// session semantics, and a mock GondolinSandbox (no real VM). Everything
// session-related (the commands, the preamble/exit notices, the
// session_start wiring) is the real factory code.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CustomEntry,
  CustomMessageEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  SANDBOX_ENTRY_TYPE,
  SANDBOX_EXIT_TYPE,
  SANDBOX_EXITED_TYPE,
  SANDBOX_PREAMBLE_TYPE,
  SESSION_NAME_PREFIX,
} from "./config";
import type { GondolinSandbox } from "./vm";

// ─── Messages ──────────────────────────────────────────────────────────────

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

// ─── Mock session: pi's append-only tree semantics ─────────────────────────

/**
 * Models pi's SessionManager: entries form a tree via parentId, all appends
 * attach to the current leaf, and getBranch() walks leaf→root (the path pi
 * sends to the LLM). pi is append-only: entries are never modified,
 * deleted, or re-parented.
 */
class MockSession {
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private counter = 0;

  private add(
    entry: Omit<
      SessionMessageEntry | CustomMessageEntry | CustomEntry,
      "id" | "parentId" | "timestamp"
    >,
  ): SessionEntry {
    const full = {
      ...entry,
      id: `e${++this.counter}`,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    this.entries.push(full);
    this.byId.set(full.id, full);
    this.leafId = full.id;
    return full;
  }

  appendMessage(message: AgentMessage): string {
    return this.add({ type: "message", message } as SessionMessageEntry).id;
  }

  appendCustomMessage(
    customType: string,
    content: string | unknown[],
    display: boolean,
    details?: unknown,
  ): string {
    return this.add({
      type: "custom_message",
      customType,
      content,
      display,
      details,
    } as CustomMessageEntry).id;
  }

  appendEntry(customType: string, data?: unknown): string {
    return this.add({ type: "custom", customType, data } as CustomEntry).id;
  }

  /** The active branch: leaf→root path, root first (pi's getBranch). */
  getBranch(): SessionEntry[] {
    const branch: SessionEntry[] = [];
    let current = this.leafId ? this.byId.get(this.leafId) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId
        ? this.byId.get(current.parentId)
        : undefined;
    }
    branch.reverse();
    return branch;
  }

  /** All entries in append order (pi's getEntries). */
  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /**
   * The messages pi would send to the LLM, mirroring pi's
   * sessionEntryToContextMessages projection for the entry types this
   * flow produces: `message` entries project to their message,
   * `custom_message` entries to a `custom` message, plain `custom` entries
   * (state, e.g. the persisted sandbox branch) to nothing.
   */
  llmMessages(): AgentMessage[] {
    return this.getBranch().flatMap((entry): AgentMessage[] => {
      if (entry.type === "message") return [entry.message];
      if (entry.type === "custom_message") {
        const cm = entry as CustomMessageEntry;
        return [
          {
            role: "custom",
            customType: cm.customType,
            content: cm.content,
            display: cm.display,
            details: cm.details,
            timestamp: new Date(cm.timestamp).getTime(),
          },
        ] as unknown as AgentMessage[];
      }
      return [];
    });
  }
}

// ─── Linearity + prefix-cache assertions ───────────────────────────────────

/**
 * The history is fully linear: the active branch is a single chain (each
 * entry is the direct child of the previous one), and every entry lies on
 * that chain — no forks, no orphaned entries.
 */
function assertLinear(session: MockSession): void {
  const branch = session.getBranch();
  const entries = session.getEntries();
  assert.equal(
    branch.length,
    entries.length,
    "every entry must lie on the active path (no forks or orphaned entries)",
  );
  if (branch.length > 0) {
    assert.equal(
      branch[0]!.parentId,
      null,
      "the branch root must have no parent",
    );
    for (let i = 1; i < branch.length; i++) {
      assert.equal(
        branch[i]!.parentId,
        branch[i - 1]!.id,
        `entry ${i} must be the direct child of the previous entry`,
      );
    }
  }
}

/**
 * Records the LLM-visible message list after each phase and asserts the
 * prefix-cache invariant: every new context is a prefix extension of every
 * earlier context — the shared prefix is byte-identical, so the provider's
 * prefix cache is never evicted.
 */
class PrefixRecorder {
  private snapshots: { label: string; messages: AgentMessage[] }[] = [];

  record(label: string, session: MockSession): AgentMessage[] {
    const messages = session.llmMessages();
    for (const prev of this.snapshots) {
      assert.ok(
        messages.length >= prev.messages.length,
        `LLM context shrank at "${label}" (${messages.length} messages) vs ` +
          `"${prev.label}" (${prev.messages.length} messages)`,
      );
      for (let i = 0; i < prev.messages.length; i++) {
        assert.deepEqual(
          messages[i],
          prev.messages[i],
          `message ${i} changed between "${prev.label}" and "${label}" — ` +
            `the shared prefix must stay identical for the prefix cache`,
        );
      }
    }
    this.snapshots.push({ label, messages });
    return messages;
  }
}

/** Compact, readable signature of an LLM message list. */
function signature(messages: AgentMessage[]): string[] {
  const textOf = (m: AgentMessage): string => {
    const content = (m as { content: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" && b !== null && (b as { type: string }).type === "text",
        )
        .map((b) => b.text)
        .join(" ");
    }
    return "";
  };
  return messages.map((m) => {
    switch (m.role) {
      case "user":
        return `user: ${textOf(m)}`;
      case "assistant":
        return `assistant: ${textOf(m)}`;
      case "custom":
        return `custom: ${(m as { customType: string }).customType}`;
      default:
        return m.role;
    }
  });
}

// ─── Mock pi API: pi's append-to-leaf session semantics ────────────────────

class MockPi {
  session: MockSession;
  commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  sessionName: string | undefined;
  sentMessages: {
    message: {
      customType: string;
      content: unknown;
      display: boolean;
      details: unknown;
    };
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }[] = [];
  sentUserMessages: string[] = [];

  constructor(session: MockSession) {
    this.session = session;
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerTool(_tool: unknown): void {}

  registerCommand(
    name: string,
    options: { handler: (args: string, ctx: unknown) => Promise<void> },
  ): void {
    this.commands.set(name, options.handler);
  }

  setSessionName(name: string): void {
    this.sessionName = name;
  }

  // pi appends custom messages as CustomMessageEntry children of the current
  // leaf (idle: immediately; streaming: queued, then appended at the turn
  // end — the session stays linear either way).
  sendMessage(
    message: {
      customType: string;
      content: unknown;
      display: boolean;
      details: unknown;
    },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ): void {
    this.sentMessages.push({ message, options });
    this.session.appendCustomMessage(
      message.customType,
      (message.content ?? []) as string | unknown[],
      message.display,
      message.details,
    );
  }

  // pi's sendUserMessage appends a user message child of the current leaf
  // and starts a turn.
  sendUserMessage(content: string | { type: string; text: string }[]): void {
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    this.sentUserMessages.push(text);
    this.session.appendMessage(userMessage(text));
  }

  // pi's appendEntry appends a plain CustomEntry child of the current leaf
  // (state only — never sent to the LLM).
  appendEntry(customType: string, data?: unknown): void {
    this.session.appendEntry(customType, data);
  }
}

// ─── Mock sandbox: no real VM ──────────────────────────────────────────────

class MockSandbox {
  vm: unknown = null;
  branch: string | null = null;
  workspace: string | null = null;
  launches: string[] = [];
  teardowns: (string | null)[] = [];

  get active(): boolean {
    return this.vm !== null;
  }

  async launch(branch: string): Promise<unknown> {
    this.branch = branch;
    this.vm = {};
    this.workspace = `/${branch}`;
    this.launches.push(branch);
    return this.vm;
  }

  async teardown(): Promise<void> {
    this.teardowns.push(this.branch);
    this.branch = null;
    this.vm = null;
    this.workspace = null;
  }

  async removeWorktree(): Promise<void> {}
  async close(): Promise<void> {}
  async requireVm(): Promise<unknown> {
    if (!this.vm) throw new Error("gondolin: no VM running");
    return this.vm;
  }
}

// ─── Mock context ───────────────────────────────────────────────────────────

function makeContext(
  session: MockSession,
  scriptedBranchNames: string[],
): ExtensionCommandContext {
  const model: Model<any> = { id: "test-model" } as Model<any>;
  // The branch-naming model: scripted answers, one per /sandbox-build.
  const modelRegistry = {
    streamSimple: (
      _model: Model<any>,
      _context: Context,
      _options?: unknown,
    ) => ({
      result: () =>
        Promise.resolve(
          assistantMessage(scriptedBranchNames.shift() ?? "unnamed-branch"),
        ),
    }),
  };
  return {
    ui: {
      input: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getBranch: () => session.getBranch() },
    modelRegistry,
    model,
    scopedModels: [],
    thinkingLevel: "off",
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    waitForIdle: async () => {},
    getSystemPromptOptions: () => ({}),
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function customEntries(session: MockSession, type: string): SessionEntry[] {
  return session
    .getEntries()
    .filter((e) => e.type === "custom" && e.customType === type);
}

function customMessages(session: MockSession, type: string): SessionEntry[] {
  return session
    .getEntries()
    .filter((e) => e.type === "custom_message" && e.customType === type);
}

function indexOfEntry(session: MockSession, entry: SessionEntry): number {
  return session.getEntries().indexOf(entry);
}

// ─── The lifecycle test ─────────────────────────────────────────────────────

test("repeated sandbox enter/exit/resume keeps the session history fully linear (prefix-cache safe)", async (t) => {
  // Hermetic environment: a private HOME (no global gondolin.json / skills)
  // and a scratch cwd that the factory adopts as the host repository root.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-linearity-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-linearity-cwd-"));
  process.env.HOME = home;
  process.chdir(cwd);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // The VM: a stateful mock standing in for the real GondolinSandbox.
  // (launchDetachedVm/removeDetachedWorktree are subagent-spawn only —
  // never called in this test.)
  const sandbox = new MockSandbox();
  t.mock.module("./vm", {
    exports: {
      createSandbox: () => sandbox as unknown as GondolinSandbox,
      launchDetachedVm: async () => ({}),
      removeDetachedWorktree: async () => {},
    },
  });

  const { default: factory } = await import("./index");
  const session = new MockSession();
  const pi = new MockPi(session);
  factory(pi as unknown as ExtensionAPI);

  const ctx = makeContext(session, ["first-branch", "second-branch"]);
  const prefix = new PrefixRecorder();
  const build = pi.commands.get("sandbox-build")!;
  const exit = pi.commands.get("sandbox-exit")!;
  const sessionStart = pi.handlers.get("session_start")![0]!;

  // Phase 0: a normal host turn before any sandbox.
  session.appendMessage(userMessage("hello"));
  session.appendMessage(assistantMessage("hi, how can I help?"));
  prefix.record("host turn", session);

  // Phase 1: enter the sandbox via /sandbox-build.
  await build("build a thing", ctx);
  // The first turn runs in the sandbox.
  session.appendMessage(assistantMessage("working on it (in sandbox)"));
  prefix.record("first enter", session);

  // The build persisted the branch, sent the preamble, and started the
  // first turn with the user's prompt — in that order on the linear history.
  assert.equal(pi.sessionName, SESSION_NAME_PREFIX + "first-branch");
  assert.deepEqual(sandbox.launches, ["first-branch"]);
  assert.equal(sandbox.branch, "first-branch");
  const sandboxEntry1 = customEntries(session, SANDBOX_ENTRY_TYPE)[0]!;
  assert.equal(
    ((sandboxEntry1 as CustomEntry).data as { branch: string }).branch,
    "first-branch",
  );
  const preamble1 = customMessages(session, SANDBOX_PREAMBLE_TYPE)[0]!;
  assert.equal((preamble1 as CustomMessageEntry).display, false);
  // The shipped template (templates/preamble.md) renders with the real
  // values — this is the coverage that lives here now, at the level the
  // agent sees it.
  const preambleText = (preamble1 as CustomMessageEntry).content as string;
  assert.ok(preambleText.includes("cwd is now /first-branch"));
  assert.ok(preambleText.includes("branch: first-branch"));
  assert.ok(
    preambleText.includes("`github`, `sandbox`, `subagents`"),
    "the skills list comes from the package's skill templates",
  );
  assert.ok(!preambleText.includes("{{"), "no unrendered template tags");
  assert.deepEqual(
    pi.sentUserMessages,
    ["build a thing"],
    "the build prompt starts the first turn",
  );
  const entries = session.getEntries();
  const userPrompt1 = entries.find(
    (e) =>
      e.type === "message" &&
      e.message.role === "user" &&
      (e.message as UserMessage).content === "build a thing",
  )!;
  assert.ok(
    indexOfEntry(session, sandboxEntry1) < indexOfEntry(session, preamble1),
    "the sandbox entry precedes the preamble",
  );
  assert.ok(
    indexOfEntry(session, preamble1) < indexOfEntry(session, userPrompt1),
    "the preamble precedes the first sandbox prompt",
  );

  // Phase 2: exit the sandbox via /sandbox-exit.
  await exit("", ctx);
  // The exit notice triggers the agent's turn, which now runs on the host.
  session.appendMessage(assistantMessage("back on the host"));
  prefix.record("first exit", session);

  assert.deepEqual(sandbox.teardowns, ["first-branch"]);
  assert.equal(sandbox.branch, null);
  const exitEntry1 = customEntries(session, SANDBOX_EXITED_TYPE)[0]!;
  assert.equal(
    ((exitEntry1 as CustomEntry).data as { branch: string }).branch,
    "first-branch",
  );
  const exitNotice1 = customMessages(session, SANDBOX_EXIT_TYPE)[0]!;
  assert.equal((exitNotice1 as CustomMessageEntry).display, false);
  // The shipped exit template (templates/exit-preamble.md) renders with the
  // real branch and host cwd.
  const exitText = (exitNotice1 as CustomMessageEntry).content as string;
  assert.ok(exitText.includes(`host repository root ${cwd}`));
  assert.ok(exitText.includes("git checkout first-branch"));
  assert.ok(exitText.includes("torn down"));
  assert.ok(!exitText.includes("{{"), "no unrendered template tags");
  assert.equal(
    pi.sentMessages.find(
      (s) => s.message.customType === SANDBOX_EXIT_TYPE,
    )?.options?.triggerTurn,
    true,
    "the exit notice triggers the agent's turn",
  );

  // Phase 3: re-enter the sandbox (a fresh branch, a fresh preamble — the
  // exit reset the once-per-branch preamble guard).
  await build("build another thing", ctx);
  session.appendMessage(assistantMessage("working again (in sandbox)"));
  prefix.record("re-enter", session);

  assert.equal(pi.sessionName, SESSION_NAME_PREFIX + "second-branch");
  assert.deepEqual(sandbox.launches, ["first-branch", "second-branch"]);
  const sandboxEntry2 = customEntries(session, SANDBOX_ENTRY_TYPE)[1]!;
  assert.equal(
    ((sandboxEntry2 as CustomEntry).data as { branch: string }).branch,
    "second-branch",
  );
  assert.equal(
    customMessages(session, SANDBOX_PREAMBLE_TYPE).length,
    2,
    "re-entry sends a fresh sandbox preamble",
  );

  // Phase 4: resume a session that ended in the sandbox (pi process
  // restart). session_start relaunches the VM for the last branch — and
  // sends no fresh preamble: the original is still in the conversation
  // history and resuming is not a transition.
  await sessionStart({}, ctx);
  session.appendMessage(assistantMessage("resumed in the sandbox"));
  prefix.record("resume while sandboxed", session);

  assert.deepEqual(
    sandbox.launches,
    ["first-branch", "second-branch", "second-branch"],
    "resume relaunches the VM for the last branch",
  );
  assert.equal(
    customMessages(session, SANDBOX_PREAMBLE_TYPE).length,
    2,
    "resume sends no fresh preamble (the original is in history)",
  );

  // Phase 5: exit the sandbox again.
  await exit("", ctx);
  session.appendMessage(assistantMessage("back on the host again"));
  prefix.record("second exit", session);

  assert.deepEqual(sandbox.teardowns, ["first-branch", "second-branch"]);
  assert.equal(customEntries(session, SANDBOX_EXITED_TYPE).length, 2);
  assert.equal(customMessages(session, SANDBOX_EXIT_TYPE).length, 2);

  // Phase 6: resume a session that ended on the host. The exit entry
  // suppresses the relaunch: no VM, no new entries, history untouched.
  const entriesBefore = session.getEntries().length;
  const messagesBefore = session.llmMessages();
  await sessionStart({}, ctx);
  assert.deepEqual(sandbox.launches, [
    "first-branch",
    "second-branch",
    "second-branch",
  ]);
  assert.equal(session.getEntries().length, entriesBefore);
  assert.deepEqual(session.llmMessages(), messagesBefore);

  // The full history is linear: 13 LLM messages + 2 sandbox entries + 2
  // exit entries (17 entries), each a direct child of the previous entry.
  assertLinear(session);
  assert.equal(session.getEntries().length, 17);
  assert.equal(session.llmMessages().length, 13);

  // The exact interleaving the agent sees: preamble before the first
  // sandbox prompt, exit notice before the post-exit reply, a fresh
  // preamble on re-entry (the exit reset the guard) — all appended at the
  // tail; resume adds nothing.
  assert.deepEqual(signature(session.llmMessages()), [
    "user: hello",
    "assistant: hi, how can I help?",
    `custom: ${SANDBOX_PREAMBLE_TYPE}`,
    "user: build a thing",
    "assistant: working on it (in sandbox)",
    `custom: ${SANDBOX_EXIT_TYPE}`,
    "assistant: back on the host",
    `custom: ${SANDBOX_PREAMBLE_TYPE}`,
    "user: build another thing",
    "assistant: working again (in sandbox)",
    "assistant: resumed in the sandbox",
    `custom: ${SANDBOX_EXIT_TYPE}`,
    "assistant: back on the host again",
  ]);
});
