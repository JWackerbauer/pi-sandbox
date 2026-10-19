import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import { BRANCH_NAME_MAX_LENGTH, BRANCH_NAME_TIMEOUT_MS, SUMMARY_MAX_TOKENS } from "./config";

// Sanitize arbitrary model output into a valid git branch name:
// lowercase, kebab-case, at most BRANCH_NAME_MAX_LENGTH characters.
// The result always matches /^[a-z0-9][a-z0-9-]*$/ and is never empty.
export function toBranchName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return name.length > 0 ? name : "build";
}

// Deterministic name derived from the prompt itself: the first words
// joined kebab-case, capped at BRANCH_NAME_MAX_LENGTH. Used whenever the
// model gives no usable answer, so the branch still reflects the request
// (a bare `toBranchName(prompt)` would truncate a long prompt mid-word).
export function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return "build";
  let name = words[0]!;
  for (const word of words.slice(1)) {
    const candidate = `${name}-${word}`;
    if (candidate.length > BRANCH_NAME_MAX_LENGTH) break;
    name = candidate;
  }
  return toBranchName(name);
}

// A user-facing explanation of a degraded branch name: one whose source
// is "prompt" (the model answer was not used) or that ended up on the
// deterministic unique suffix after collisions. The cause, if any, comes
// from `reason`.
export function describeBranchNameFallback(
  result: BranchNameResult,
): string {
  const cause = result.reason ? `: ${result.reason}` : "";
  const usage =
    result.source === "prompt"
      ? `using "${result.name}" derived from the prompt instead`
      : `using "${result.name}" (a unique suffix)`;
  return `model-based branch naming failed${cause} — ${usage}`;
}

// The outcome of a branch-name request: the name plus where it came
// from. Callers use `source`/`reason` to tell the user when the model
// answer was not used, so a degraded naming is never silent.
export interface BranchNameResult {
  name: string;
  /** "model" when the model's answer was used; "prompt" when the
   * deterministic prompt-derived fallback was used. */
  source: "model" | "prompt";
  /** Human-readable cause of a degraded naming: present exactly when the
   * final name is not the model's first suggestion (prompt fallback and/or
   * a unique suffix after collisions). Absent on the plain model path. */
  reason?: string;
}

// Ask the given model for a short summary of a build request and
// sanitize the answer into a branch name. Never throws: a failed, hung,
// or empty model call degrades to the deterministic prompt-derived name
// (reported via `source`/`reason`), so branch naming can never block or
// fail a launch.
export async function requestBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  timeoutMs: number = BRANCH_NAME_TIMEOUT_MS,
): Promise<BranchNameResult> {
  const userMessage: UserMessage = {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
  const context: Context = {
    systemPrompt:
      "Summarize the user's build request as a git branch name: " +
      "a few lowercase kebab-case words. Reply with the branch name " +
      "only, no explanation, no quotes.",
    messages: [userMessage],
  };
  let result: AssistantMessage | undefined;
  let failure: string | undefined;
  try {
    // No `reasoning` option: streamSimple defaults to thinking "off", so
    // the whole maxTokens budget is available for the answer.
    const stream = registry.streamSimple(model, context, {
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    result = await withTimeout(stream.result(), timeoutMs);
  } catch (err) {
    // Naming is best-effort: a throwing call, a timeout, or a hung
    // provider all fall through to the prompt-derived name below.
    failure = err instanceof Error ? err.message : String(err);
  }
  // Only a completed response counts. A thinking model that spent its
  // token budget on reasoning, a provider error (stopReason "error"),
  // or an aborted call yields no usable text — use the prompt instead of
  // the static "build" fallback that toBranchName would return.
  const completed =
    result !== undefined &&
    (result.stopReason === "stop" || result.stopReason === "length");
  const text = completed
    ? result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim()
    : "";
  const fromModel = text.length > 0 ? toBranchName(text) : "";
  if (fromModel.length > 0) return { name: fromModel, source: "model" };
  const reason = failure ?? (
    result?.stopReason === "error"
      ? "the model call ended in a provider error"
      : result !== undefined
        ? "the model returned no text (the token budget may have been consumed by thinking)"
        : "the model call did not complete"
  );
  return { name: nameFromPrompt(prompt), source: "prompt", reason };
}

// Reject with a BranchNameTimeoutError after `ms`, whichever settles first.
class BranchNameTimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new BranchNameTimeoutError(
            `the model call timed out after ${Math.round(ms / 1000)}s`,
          ),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Deterministic fallback for a taken branch name: suffix the base with -2,
// -3, … (trimming the stem to stay within BRANCH_NAME_MAX_LENGTH) until
// `isTaken` reports the candidate as free. Always terminates.
export async function uniqueBranchName(
  base: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  let stem = base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const maxStem = BRANCH_NAME_MAX_LENGTH - suffix.length;
    if (stem.length > maxStem) stem = stem.slice(0, maxStem).replace(/-+$/, "");
    const candidate = `${stem}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
}

// Ask the model for a branch name, and — if that name is already in use —
// recover by prompting the model again for a distinct name. Collision checks
// go through `isTaken` (the caller passes a real shared-`.git` lookup, not
// the guest). Falls back to a deterministic unique suffix so a branch name
// is always produced and spawn always succeeds. The first name is derived
// from `prompt` exactly once; only on a collision is the model called again.
// The returned `source`/`reason` describe the final name: a collision
// resolved by a model retry is "model"; a name that ended up on the
// deterministic suffix keeps the original fallback reason.
export async function requestDistinctBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<BranchNameResult> {
  let result = await requestBranchName(model, registry, prompt);
  if (!(await isTaken(result.name))) return result;

  // The model's pick collided. Ask it again, telling it the names already in
  // use, up to 2 extra times.
  const taken = new Set<string>([result.name]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryPrompt =
      `The branch name "${result.name}" you just suggested is already in use in ` +
      `this repository. Pick a DIFFERENT short git branch name for the ` +
      `build request below. Avoid these names that are already taken: ` +
      `[${[...taken].join(", ")}]. Reply with a fresh kebab-case branch ` +
      `name only, no explanation, no quotes.\n\nBuild request:\n${prompt}`;
    result = await requestBranchName(model, registry, retryPrompt);
    if (!(await isTaken(result.name))) return result;
    taken.add(result.name);
  }

  // Every model suggestion collided: give up on the model and fall back to a
  // deterministic unique suffix so spawn always succeeds.
  const name = await uniqueBranchName(result.name, isTaken);
  const collision = `"${result.name}" was already in use`;
  return {
    name,
    source: result.source,
    reason: result.reason ? `${result.reason}; ${collision}` : collision,
  };
}
