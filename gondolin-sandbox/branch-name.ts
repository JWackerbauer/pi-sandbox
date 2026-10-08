import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import { BRANCH_NAME_MAX_LENGTH, SUMMARY_MAX_TOKENS } from "./config";

// Sanitize arbitrary model output into a valid git branch name:
// lowercase, kebab-case, at most BRANCH_NAME_MAX_LENGTH characters.
// The result always matches /^[a-z0-9][a-z0-9-]*$/.
export function toBranchName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return name.length > 0 ? name : "build";
}

// Ask the given model for a short summary of a build request and
// sanitize the answer into a branch name. When the model returns no
// usable text (e.g. the token budget was consumed by thinking), fall
// back to a deterministic name derived from the first words of the
// prompt, so the branch always reflects the request.
export async function requestBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
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
  // No `reasoning` option: streamSimple defaults to thinking "off", so
  // the whole maxTokens budget is available for the answer.
  const stream = registry.streamSimple(model, context, {
    maxTokens: SUMMARY_MAX_TOKENS,
  });
  const result: AssistantMessage = await stream.result();
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  const fromModel = toBranchName(text);
  return fromModel.length > 0 ? fromModel : toBranchName(prompt);
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
// is always produced and spawn always succeeds.
export async function requestDistinctBranchName(
  model: Model<any>,
  registry: ExtensionContext["modelRegistry"],
  prompt: string,
  takenName: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<string> {
  const first = await requestBranchName(model, registry, prompt);
  if (!(await isTaken(first))) return first;

  // The model's pick collided. Ask it again, telling it the name it just
  // chose is already in use (plus any other known-taken names), up to 2
  // extra times.
  const taken = new Set<string>([first]);
  if (takenName) taken.add(takenName);
  let last = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryPrompt =
      `The branch name "${last}" you just suggested is already in use in ` +
      `this repository. Pick a DIFFERENT short git branch name for the ` +
      `build request below. Avoid these names that are already taken: ` +
      `[${[...taken].join(", ")}]. Reply with a fresh kebab-case branch ` +
      `name only, no explanation, no quotes.\n\nBuild request:\n${prompt}`;
    const candidate = await requestBranchName(model, registry, retryPrompt);
    if (!(await isTaken(candidate))) return candidate;
    last = candidate;
    taken.add(candidate);
  }

  // Every model suggestion collided: give up on the model and fall back to a
  // deterministic unique suffix so spawn always succeeds.
  return uniqueBranchName(last, isTaken);
}
