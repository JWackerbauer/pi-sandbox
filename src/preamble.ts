// The sandbox preamble: context sent to the agent when a session switches
// into (or back into) a gondolin sandbox, in place of modifying the system
// prompt. Modifying the system prompt invalidates the inference prefix
// cache, so the preamble travels as a (non-display) custom message attached
// to the first sandbox turn's user prompt (see index.ts / build-in-sandbox.ts).
//
// The preamble is a template (templates/preamble.md) rendered with the work
// branch, the guest workspace, and the list of the package's skills — the
// on-demand reference material for everything else.

import fs from "node:fs";
import path from "node:path";
import { guestWorkspace } from "./config";
import { renderTemplate } from "./skill-template";

/** Name of the preamble template inside the package's `templates/` dir. */
export const PREAMBLE_TEMPLATE_FILE = "preamble.md";

/**
 * The `.md` file names (without extension) in `dir`, sorted. Returns `[]`
 * when the directory does not exist.
 */
export function skillNames(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -3))
    .sort();
}

/**
 * Render the sandbox preamble for `branch` from the package's
 * `templates/preamble.md`. `packageDir` is the package root (the parent of
 * this `src` directory); `skills` is the list of available skill names
 * (typically `skillNames(<packageDir>/skills)`).
 */
export function renderPreamble(
  packageDir: string,
  branch: string,
  skills: string[],
): string {
  const templatePath = path.join(
    packageDir,
    "templates",
    PREAMBLE_TEMPLATE_FILE,
  );
  const template = fs.readFileSync(templatePath, "utf8");
  const rendered = renderTemplate(template, {
    branch,
    workspace: guestWorkspace(branch),
    // Backtick each skill name so the rendered list reads as skill references.
    skills: skills.map((s) => `\`${s}\``),
  });
  // Section tags can leave extra blank lines; collapse runs of three or more
  // newlines to a single blank line.
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}
