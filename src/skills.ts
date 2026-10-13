// Builds the template context for gondolin's skill templates and renders the
// package's `skills/` templates into a per-process temp directory. The
// rendered directory is returned for use as a `skillPaths` entry on
// resources_discover (see index.ts), so environment-specific info lives in
// on-demand skill content instead of the system prompt. The files live on
// the host only; the wrapped read tool serves them to the agent (see
// index.ts), so the sandbox worktree is never touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GondolinConfig } from "./config";
import { resolveMagicDirHosts, resolveGhCliHosts } from "./config-loader";
import { renderTemplate, type TemplateContext } from "./skill-template";

/** Placeholder body for skill stubs written before the sandbox starts. */
const STUB_SKILL_BODY =
  "The gondolin sandbox is not active in this session yet. Run `" +
  "/build-in-sandbox` to start it — this skill's content is populated " +
  "when the sandbox starts.";

/**
 * Build the template context for gondolin skills from the effective config:
 * - `github_hosts` — every host the sandbox can reach: the union of the
 *   `config.secrets[*].hosts` entries, the `magicDir` hosts, and the
 *   `ghCliToken` hosts, deduped, sorted, joined with `", "` (empty when none).
 * - `magic_hosts` — the hosts with a magic dir enabled (sorted, joined).
 * - `gh_cli_hosts` — the hosts with the `gh` CLI installed in the guest
 *   (sorted, joined).
 * - `secrets` — the sorted secret names, joined with `", "` (empty when none).
 * - `scratch` — `config.scratch !== false` (a boolean).
 * - `developMode` — `config.developMode === true` (a boolean).
 */
export function buildSkillContext(config: GondolinConfig): TemplateContext {
  const magicHosts = resolveMagicDirHosts(config);
  const ghCliHosts = resolveGhCliHosts(config).map((h) => h.host);
  const hosts = new Set<string>([...magicHosts, ...ghCliHosts]);
  for (const entry of Object.values(config.secrets ?? {})) {
    for (const host of entry.hosts ?? []) {
      hosts.add(host);
    }
  }
  return {
    github_hosts: [...hosts].sort().join(", "),
    magic_hosts: [...new Set(magicHosts)].sort().join(", "),
    gh_cli_hosts: [...new Set(ghCliHosts)].sort().join(", "),
    secrets: Object.keys(config.secrets ?? {}).sort().join(", "),
    scratch: config.scratch !== false,
    developMode: config.developMode === true,
  };
}

/**
 * Write the package's skill files with their real (static, config-
 * independent) front matter and a placeholder body, into the same per-
 * process temp dir that renderedSkillPaths() uses. pi discovers skills
 * only at session start/reload and caches only the front matter (the
 * body is re-read from disk whenever the agent loads the skill), so the
 * stubs make the skills appear in the system prompt from turn one; the
 * real bodies are rendered in place (same paths) when the sandbox is
 * entered, with no system-prompt change.
 */
export function stubSkillPaths(templateDir: string): string {
  const outDir = skillOutputDir();
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
    const frontMatter = frontMatterBlock(fs.readFileSync(srcPath, "utf8"));
    fs.writeFileSync(
      path.join(outDir, name),
      `${frontMatter}\n${STUB_SKILL_BODY}\n`,
    );
  }
  return outDir;
}

/** The per-process output dir shared by stubSkillPaths/renderedSkillPaths. */
function skillOutputDir(): string {
  return path.join(os.tmpdir(), "gondolin-sandbox", `skills-${process.pid}`);
}

/** The leading `--- … ---` front matter block of a skill template. */
function frontMatterBlock(source: string): string {
  const match = source.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? match[0] : "";
}

/**
 * Render every `.md` template in `templateDir` with `context` into a fresh
 * per-process temp directory and return that directory's path (for use as a
 * `skillPaths` entry on resources_discover). Returns the dir even if it ends
 * up empty.
 */
export function renderedSkillPaths(
  templateDir: string,
  context: TemplateContext,
): string {
  const outDir = skillOutputDir();
  // Fresh per-process output: clear any previous render, then recreate.
  // When re-rendering over the stubs written at load time, the paths are
  // unchanged, so the system prompt stays untouched.
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

/**
 * Whether `p` (resolved against `localCwd`) is inside one of `hostRoots`.
 * The wrapped read tool uses this to serve skill files from the host (see
 * index.ts); the guest never sees them, and the containment check keeps
 * writes/edits out.
 */
export function isHostServedPath(
  localCwd: string,
  p: string,
  hostRoots: string[],
): boolean {
  const resolved = path.resolve(localCwd, p);
  return hostRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
}
