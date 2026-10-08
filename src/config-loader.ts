// Loads the GondolinConfig from JSON config files and derives per-repo
// helpers. See config.ts for the shape of the config.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretDefinition } from "@earendil-works/gondolin";
import type { GondolinConfig, SecretConfig, VmSizing } from "./config";

const CONFIG_FILE_NAME = "gondolin.json";

// Read and parse a single config file. Missing files, unreadable files, and
// invalid JSON all yield an empty config — config is best-effort and must
// never break a VM launch.
function readConfigFile(file: string): GondolinConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as GondolinConfig;
  } catch {
    return {};
  }
}

function mergeSizing(
  global: VmSizing | undefined,
  project: VmSizing | undefined,
): VmSizing | undefined {
  if (!global && !project) return undefined;
  return { ...global, ...project };
}

// Project values override global values field by field, so a project config
// can override just `vm.memory` while inheriting `vm.cpus` from the global
// config. For `commands`, each list is overridden wholesale (a project
// config that sets `commands.startup` replaces the global list; it does not
// concatenate).
function mergeConfigs(
  global: GondolinConfig,
  project: GondolinConfig,
): GondolinConfig {
  const merged: GondolinConfig = {
    vm: mergeSizing(global.vm, project.vm),
    subagent: mergeSizing(global.subagent, project.subagent),
    secrets: { ...global.secrets, ...project.secrets },
  };
  if (global.scratch !== undefined || project.scratch !== undefined) {
    merged.scratch = project.scratch ?? global.scratch;
  }
  if (global.commands || project.commands) {
    merged.commands = {
      startup:
        project.commands?.startup ?? global.commands?.startup,
      prepare:
        project.commands?.prepare ?? global.commands?.prepare,
    };
  }
  return merged;
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
 * Resolve the config's `secrets` map into Gondolin secret definitions. The
 * value of each secret comes from the host environment variable named by the
 * map key; entries whose env var is unset or empty are skipped, so a config
 * file never has to contain (or leak) a real secret.
 */
export function resolveSecrets(
  config: GondolinConfig,
): Record<string, SecretDefinition> {
  const resolved: Record<string, SecretDefinition> = {};
  for (const [name, entry] of Object.entries(config.secrets ?? {})) {
    const value = process.env[name];
    if (!value) continue;
    const def: SecretDefinition = { hosts: entry.hosts, value };
    if (entry.placeholder !== undefined) {
      def.placeholder = entry.placeholder;
    }
    resolved[name] = def;
  }
  return resolved;
}
