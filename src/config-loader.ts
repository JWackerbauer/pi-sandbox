// Loads the GondolinConfig from JSON config files and derives per-repo
// helpers. See config.ts for the shape of the config.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretDefinition } from "@earendil-works/gondolin";
import type {
  GondolinConfig,
  GitHubOrgConfig,
  GhCliHost,
  PostBuildConfig,
  SecretConfig,
  VmSizing,
} from "./config";

const CONFIG_FILE_NAME = "gondolin.json";

// Read and parse a single config file. Missing files, unreadable files, and
// invalid JSON all yield an empty config — config is best-effort and must
// never break a VM launch.
function readConfigFile(file: string): GondolinConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const config = parsed as GondolinConfig;
    config.env = normalizeEnv(config.env);
    config.postStartup = normalizePostStartup(config.postStartup);
    config.github = normalizeGithub(config.github);
    return config;
  } catch {
    return {};
  }
}

// `env` should be a map of name → string value, but a hand-written JSON file
// can hold anything. Normalize it so an ill-shaped value never crashes the
// launch: non-string values are dropped, and any value that is not a plain
// object (array, string, number, null) is treated as unset.
function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [name, val] of Object.entries(value)) {
    if (typeof val === "string") env[name] = val;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

// `github` should be a list of { host, magicDir, ghCliToken } objects, but a
// hand-written JSON file can hold anything. Normalize it so an ill-shaped
// value never crashes the launch: non-object entries and entries missing a
// string host are dropped, entries that enable neither feature are dropped,
// and a non-array value is treated as unset.
function normalizeGithub(
  value: unknown,
): GitHubOrgConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const orgs: GitHubOrgConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.host !== "string") continue;
    // An entry must enable at least one of the two features.
    if (e.magicDir !== true && typeof e.ghCliToken !== "string") continue;
    orgs.push({
      host: e.host,
      magicDir: e.magicDir === true,
      ghCliToken: typeof e.ghCliToken === "string" ? e.ghCliToken : undefined,
    });
  }
  return orgs.length > 0 ? orgs : undefined;
}

// `postStartup` should be a list of shell commands, but a hand-written JSON
// file can hold anything. Normalize it to a string array so an ill-shaped
// value never crashes the launch: a bare string becomes a one-command list,
// non-string entries are dropped, and any other value (object, number, null)
// is treated as unset.
function normalizePostStartup(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const commands = value.filter(
      (cmd): cmd is string => typeof cmd === "string",
    );
    return commands.length > 0 ? commands : undefined;
  }
  return undefined;
}

function mergeSizing(
  global: VmSizing | undefined,
  project: VmSizing | undefined,
): VmSizing | undefined {
  if (!global && !project) return undefined;
  return { ...global, ...project };
}

// Env maps merge per key (a project config can override one variable while
// inheriting the rest); the result stays `undefined` when both are empty.
function mergeEnv(
  global: Record<string, string> | undefined,
  project: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const env = { ...global, ...project };
  return Object.keys(env).length > 0 ? env : undefined;
}

// `github` entries are keyed by host, so a project config can add a host or
// override an existing one (e.g. swap a token) while inheriting the rest.
function mergeGithub(
  global: GitHubOrgConfig[] | undefined,
  project: GitHubOrgConfig[] | undefined,
): GitHubOrgConfig[] | undefined {
  if (!global && !project) return undefined;
  const byHost = new Map<string, GitHubOrgConfig>();
  for (const entry of global ?? []) byHost.set(entry.host, entry);
  for (const entry of project ?? []) byHost.set(entry.host, entry);
  return [...byHost.values()];
}

// Project values override global values field by field, so a project config
// can override just `vm.memory` while inheriting `vm.cpus` from the global
// config. `postStartup` and `postBuild` are overridden wholesale (a project
// config that sets them replaces the global value; it does not concatenate).
function mergeConfigs(
  global: GondolinConfig,
  project: GondolinConfig,
): GondolinConfig {
  const merged: GondolinConfig = {
    vm: mergeSizing(global.vm, project.vm),
    subagent: mergeSizing(global.subagent, project.subagent),
    secrets: { ...global.secrets, ...project.secrets },
    env: mergeEnv(global.env, project.env),
    github: mergeGithub(global.github, project.github),
  };
  if (global.scratch !== undefined || project.scratch !== undefined) {
    merged.scratch = project.scratch ?? global.scratch;
  }
  if (global.coAuthor !== undefined || project.coAuthor !== undefined) {
    merged.coAuthor = project.coAuthor ?? global.coAuthor;
  }
  if (global.developMode !== undefined || project.developMode !== undefined) {
    merged.developMode = project.developMode ?? global.developMode;
  }
  if (global.postStartup || project.postStartup) {
    merged.postStartup = project.postStartup ?? global.postStartup;
  }
  if (global.postBuild || project.postBuild) {
    merged.postBuild = project.postBuild ?? global.postBuild;
  }
  return merged;
}

/**
 * The effective `postBuild` section and the directory the custom image's
 * assets should be built into. A project-level postBuild is repo-specific,
 * so its assets live under `<localCwd>/.pi/assets`; a global-only
 * postBuild applies to every repo, so its assets live under
 * `<agentDir>/assets`. Returns null when no postBuild section is set.
 */
export interface PostBuildResolution {
  postBuild: PostBuildConfig;
  /** Directory to build (and cache) the custom image assets in. */
  assetDir: string;
}

export function resolvePostBuild(
  localCwd: string,
  agentDir: string,
): PostBuildResolution | null {
  const global = readConfigFile(path.join(agentDir, CONFIG_FILE_NAME));
  const project = readConfigFile(
    path.join(localCwd, ".pi", CONFIG_FILE_NAME),
  );
  const postBuild = project.postBuild ?? global.postBuild;
  if (!postBuild) return null;
  const assetDir = project.postBuild
    ? path.join(localCwd, ".pi", "assets")
    : path.join(agentDir, "assets");
  return { postBuild, assetDir };
}

/**
 * Load the effective GondolinConfig: `~/.pi/agent/gondolin.json` (global,
 * where `agentDir` points) merged with `<localCwd>/.pi/gondolin.json`
 * (project overrides global). Missing/invalid files are treated as empty.
 */
export function loadGondolinConfig(
  localCwd: string,
  agentDir: string,
): GondolinConfig {
  const global = readConfigFile(path.join(agentDir, CONFIG_FILE_NAME));
  const project = readConfigFile(
    path.join(localCwd, ".pi", CONFIG_FILE_NAME),
  );
  return mergeConfigs(global, project);
}

/**
 * A stable, filesystem-safe per-repo key: the repo's basename sanitized to
 * [a-z0-9-], plus the first 8 hex chars of the sha256 of its resolved
 * absolute path (so two repos with the same name in different locations
 * never collide).
 */
export function computeRepoKey(localCwd: string): string {
  const resolved = path.resolve(localCwd);
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const hash = crypto
    .createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, 8);
  return base ? `${base}-${hash}` : hash;
}

/**
 * The hosts with `magicDir` enabled. These are served host-side (the host's
 * own `gh` authentication is used; no config token is involved), so every
 * enabled host is usable. Duplicate hosts are collapsed to the first.
 */
export function resolveMagicDirHosts(config: GondolinConfig): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const entry of config.github ?? []) {
    const host = entry.host.trim();
    if (host.length === 0 || !entry.magicDir) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

// The shape of an env var name (uppercase identifier), which is not a
// plausible literal token. Used to detect an entry whose `ghCliToken` is an
// *unset* env var name: such an entry is skipped rather than the name being
// used as the token literal (which would authenticate as the literal string
// and fail with 401, e.g. a token sourced into a shell but not exported).
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Resolve the config's `ghCliToken` entries into hosts with a usable token.
 * For each entry the token comes from `process.env[ghCliToken]` when that
 * env var is set, otherwise from the (literal) `ghCliToken` value itself.
 * A value that looks like an env var name whose var is unset is treated as
 * unresolvable and skipped (so a non-exported shell variable fails loudly
 * at the config level instead of as a 401 deep in the guest). Entries with
 * no usable token are skipped, and duplicate hosts are collapsed to the
 * first. The result is empty when the feature is not configured, so callers
 * can treat a non-empty list as "the feature is opt-in".
 */
export function resolveGhCliHosts(config: GondolinConfig): GhCliHost[] {
  const resolved: GhCliHost[] = [];
  const seen = new Set<string>();
  for (const entry of config.github ?? []) {
    const host = entry.host.trim();
    if (host.length === 0 || entry.ghCliToken === undefined) continue;
    const envValue = process.env[entry.ghCliToken];
    const token = envValue ?? entry.ghCliToken;
    if (!token) continue;
    if (envValue === undefined && ENV_VAR_NAME_RE.test(token)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    resolved.push({ host, token });
  }
  return resolved;
}

/**
 * Resolve the config's `secrets` map into Gondolin secret definitions. The
 * value of each secret comes from its `value` field when present, otherwise
 * from the host environment variable named by the map key; entries with no
 * value in either source are skipped.
 */
export function resolveSecrets(
  config: GondolinConfig,
): Record<string, SecretDefinition> {
  const resolved: Record<string, SecretDefinition> = {};
  for (const [name, entry] of Object.entries(config.secrets ?? {})) {
    const value = entry.value ?? process.env[name];
    if (!value) continue;
    const def: SecretDefinition = { hosts: entry.hosts, value };
    if (entry.placeholder !== undefined) {
      def.placeholder = entry.placeholder;
    }
    resolved[name] = def;
  }
  return resolved;
}
