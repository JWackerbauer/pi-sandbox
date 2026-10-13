// Builds the template context for gondolin's skill templates and renders the
// package's `skills/` templates into the repo's `.pi/skills/gondolin`
// directory (see config.ts hostSkillsDir). The rendered directory is
// returned for use as a `skillPaths` entry on resources_discover (see
// index.ts), so environment-specific info lives in on-demand skill content
// instead of the system prompt. The files are also copied into each guest
// worktree at VM launch (see vm.ts), so the agent can read them from inside
// the sandbox.

import fs from "node:fs";
import path from "node:path";
import type { GondolinConfig } from "./config";
import { renderTemplate, type TemplateContext } from "./skill-template";

/**
 * Build the template context for gondolin skills from the effective config:
 * - `github_hosts` — the union of every `config.secrets[*].hosts` entry,
 *   deduped, sorted, joined with `", "` (empty string when there are none).
 * - `secrets` — the sorted secret names, joined with `", "` (empty when none).
 * - `scratch` — `config.scratch !== false` (a boolean).
 * - `developMode` — `config.developMode === true` (a boolean).
 */
export function buildSkillContext(config: GondolinConfig): TemplateContext {
  const hosts = new Set<string>();
  for (const entry of Object.values(config.secrets ?? {})) {
    for (const host of entry.hosts ?? []) {
      hosts.add(host);
    }
  }
  return {
    github_hosts: [...hosts].sort().join(", "),
    secrets: Object.keys(config.secrets ?? {}).sort().join(", "),
    scratch: config.scratch !== false,
    developMode: config.developMode === true,
  };
}

/**
 * Render every `.md` template in `templateDir` with `context` into `outDir`
 * and return that directory's path (for use as a `skillPaths` entry on
 * resources_discover). Returns the dir even if it ends up empty.
 */
export function renderedSkillPaths(
  templateDir: string,
  context: TemplateContext,
  outDir: string,
): string {
  // Fresh output: clear any previous render, then recreate.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let names: string[];
  try {
    names = fs.readdirSync(templateDir);
  } catch {
    // No template dir — leave the (empty) output dir in place and return it.
    return outDir;
  }

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const srcPath = path.join(templateDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(srcPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    let rendered = renderTemplate(fs.readFileSync(srcPath, "utf8"), context);
    // Section tags leave blank lines where a block was omitted; collapse runs
    // of three or more newlines to a single blank line.
    rendered = rendered.replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(path.join(outDir, name), rendered);
  }
  return outDir;
}
