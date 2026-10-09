import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import { PREWARM_MAX_TOKENS } from "./config";

// First-turn pre-warm: start the LLM generation for the first turn in
// parallel with the (slow) sandbox VM startup, so there is less wait time
// for the first token.
//
// Mechanism
// ─────────
// `startPrewarm` kicks off a speculative streaming completion for the user's
// prompt as soon as the /build-in-sandbox command runs (right after the fast
// branch-name call), while the VM boots in the background. When the VM is
// ready, the caller inspects the completed result:
//
//  - If it is a complete, pure-text answer (no tool calls, not truncated, no
//    error), the answer is handed off to the session as the first turn: the
//    user's prompt and the pre-generated answer are seeded into the session
//    as visible messages, and NO second model call is made. The user saw the
//    answer flow before the VM was even ready.
//
//  - Otherwise (the common case for coding tasks: the model's first response
//    wants to call tools), the pre-warm result is discarded and the normal
//    first turn is started. That turn still benefits from a warm provider
//    connection (the branch-name call and the pre-warm already hit the API).
//
// Why no true stream hand-off?
// ────────────────────────────
// A true hand-off (reusing the in-flight stream as the first turn's model
// call, with the agent loop executing the pre-generated tool calls) is not
// possible with the extension SDK surface available here: extensions can
// issue model streams via `modelRegistry.streamSimple` (pi-ai), but the
// agent loop's model call is owned by the session and there is no API to
// inject a pre-generated assistant message (with tool calls) into it and
// have the loop continue from there. `pi.sendUserMessage` always starts a
// fresh turn, and `pi.sendMessage` only appends custom messages, which are
// not part of the LLM conversation.
//
// Trade-offs (documented for the parent review):
//  - The pre-warm is capped at PREWARM_MAX_TOKENS output; a coding task's
//    first response usually contains tool calls, so the speculative call is
//    wasted in the common case (bounded cost).
//  - In the usable path, the seeded prompt/answer are custom session
//    messages: they are visible in the TUI but not sent to the LLM. If the
//    user continues the conversation, the model does not see this exchange
//    and may repeat itself. The exchange is what the user asked for, so in
//    practice the turn is "done" at that point.
//  - The pre-warm runs with a stand-in system prompt (the sandbox CWD
//    section, see prompt.ts); pi's default system prompt is not available to
//    extensions, so the speculative answer may differ slightly from the real
//    first turn's.
//  - If the VM launch fails, the in-flight pre-warm is abandoned; it is
//    capped, so it finishes on its own.

export interface PrewarmResult {
  /** True when the result can be handed off to the session as the first turn. */
  usable: boolean;
  /** The assistant's text content (may be empty). */
  text: string;
  /** Whether the message contains any non-text block (tool calls, …). */
  hasToolCalls: boolean;
  /** Whether the message was cut off by the token budget. */
  truncated: boolean;
  /** Error message, when the stream failed. */
  error?: string;
}

export interface PrewarmHandle {
  /** Resolves with the analysis of the completed (or failed) pre-warm. */
  done: Promise<PrewarmResult>;
}

// Block types that carry no actions: a pre-warm result is usable only when
// every block is one of these and there is text.
const INERT_BLOCK_TYPES = new Set(["text", "thinking", "reasoning"]);

// Structural, so tests can pass fakes without the pi-ai runtime.
export interface PrewarmMessageLike {
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string | null;
  errorMessage?: string;
}

// Analyze a completed pre-warm message and decide whether it can be handed
// off to the session as the first turn.
//
// Conservative on purpose: anything that is not unambiguously a pure-text
// answer (unknown block types, truncation, errors, empty text) falls back to
// the normal first turn. A false negative only costs the speculative call;
// a false positive would hand the user an answer that silently dropped tool
// calls.
export function analyzePrewarmResult(
  message: PrewarmMessageLike,
): PrewarmResult {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const hasToolCalls = blocks.some(
    (b) => b.type !== undefined && !INERT_BLOCK_TYPES.has(b.type),
  );
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  const truncated = /max[-_ ]?tokens|length|truncat/i.test(stopReason);
  const error =
    typeof message.errorMessage === "string" && message.errorMessage.length > 0
      ? message.errorMessage
      : undefined;
  return {
    usable: text.length > 0 && !hasToolCalls && !truncated && !error,
    text,
    hasToolCalls,
    truncated,
    error,
  };
}

// Kick off the speculative first-turn completion. The stream starts
// immediately (while the VM boots) and is consumed in the background; the
// caller gets a handle to await once the VM is ready.
export function startPrewarm(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  systemPrompt: string,
  prompt: string,
): PrewarmHandle {
  const userMessage: UserMessage = {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
  const context: Context = {
    systemPrompt,
    messages: [userMessage],
  };
  // Bounded output: the pre-warm is a speculative call whose cost is a
  // write-off whenever the result is not a complete pure-text answer.
  // No `reasoning` option: streamSimple defaults to thinking "off", so the
  // whole budget is available for the answer (same as branch-name.ts).
  const stream = registry.streamSimple(model, context, {
    maxTokens: PREWARM_MAX_TOKENS,
  });
  const done = stream.result().then(
    (message: AssistantMessage) => analyzePrewarmResult(message),
    (err: unknown) => ({
      usable: false,
      text: "",
      hasToolCalls: false,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return { done };
}
