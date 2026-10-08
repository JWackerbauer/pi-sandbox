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
  const stream = registry.streamSimple(model, context, {
    maxTokens: SUMMARY_MAX_TOKENS,
    reasoning: "minimal",
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
