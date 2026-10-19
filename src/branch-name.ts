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

// Ask the given model for a short summary of a build request and
// sanitize the answer into a branch name. Never throws: a failed, hung,
// or empty model call degrades to the deterministic prompt-derived name,
// so branch naming can never block or fail a launch.
export async function requestBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  timeoutMs: number = BRANCH_NAME_TIMEOUT_MS,
): Promise<string> {
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
  try {
    // No `reasoning` option: streamSimple defaults to thinking "off", so
    // the whole maxTokens budget is available for the answer.
    const stream = registry.streamSimple(model, context, {
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    result = await withTimeout(stream.result(), timeoutMs);
  } catch {
    // Naming is best-effort: a throwing call, a timeout, or a hung
    // provider all fall through to the prompt-derived name below.
  }
  // Only a completed response counts. A thinking model that spent its
  // token budget on reasoning, a provider error (stopReason "error"),
  // or an aborted call yields no usable text — use the prompt instead of
  // the static "build" fallback that toBranchName would return.
  const text =
    result && (result.stopReason === "stop" || result.stopReason === "length")
      ? result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(" ")
          .trim()
      : "";
  const fromModel = text.length > 0 ? toBranchName(text) : "";
  return fromModel.length > 0 ? fromModel : nameFromPrompt(prompt);
}

// Reject with a timeout error after `ms`, whichever settles first.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
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
export async function requestDistinctBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<string> {
  let name = await requestBranchName(model, registry, prompt);
  if (!(await isTaken(name))) return name;

  // The model's pick collided. Ask it again, telling it the names already in
  // use, up to 2 extra times.
  const taken = new Set<string>([name]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryPrompt =
      `The branch name "${name}" you just suggested is already in use in ` +
      `this repository. Pick a DIFFERENT short git branch name for the ` +
      `build request below. Avoid these names that are already taken: ` +
      `[${[...taken].join(", ")}]. Reply with a fresh kebab-case branch ` +
      `name only, no explanation, no quotes.\n\nBuild request:\n${prompt}`;
    name = await requestBranchName(model, registry, retryPrompt);
    if (!(await isTaken(name))) return name;
    taken.add(name);
  }

  // Every model suggestion collided: give up on the model and fall back to a
  // deterministic unique suffix so spawn always succeeds.
  return uniqueBranchName(name, isTaken);
}
