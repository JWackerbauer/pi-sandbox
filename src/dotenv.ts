// Loads a host `.env` file into `process.env` so its values are available
// for secret resolution (see config-loader.ts resolveSecrets). Loading is
// opt-in via config `envFile: true` (see maybeLoadDotEnv). This is a
// minimal, dependency-free `.env` parser: it reads `KEY=VALUE` lines and
// adds each to the process environment only when that variable is not
// already set, so a real environment always wins over the file.

import fs from "node:fs";
import path from "node:path";
import type { GondolinConfig } from "./config";

/**
 * Read the `.env` file at `file` and add its `KEY=VALUE` pairs to
 * `process.env`, overwriting nothing that is already set (an existing env var
 * wins). Returns the number of variables actually added.
 *
 * Rules:
 * - Missing / unreadable files yield 0 and do nothing.
 * - Blank lines and lines whose first non-space character is `#` are skipped.
 * - An optional leading `export ` prefix on the key is allowed.
 * - Keys and values are trimmed.
 * - One pair of matching surrounding single or double quotes is stripped from
 *   the value (only when both ends match and the value is at least 2 chars).
 * - Lines with no `=` are skipped.
 *
 * Never throws: any read/parse problem is swallowed and reported as "nothing
 * set" so a stray `.env` can never break startup.
 */
export function loadDotEnv(file: string): number {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    // Missing or unreadable — nothing to load.
    return 0;
  }

  let set = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    // Skip blank lines and comments (first non-space char is `#`).
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    let key = trimmed.slice(0, eq).trim();
    // Optional leading `export ` prefix.
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (key === "") continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip one pair of matching surrounding quotes.
    if (value.length >= 2) {
      const first = value[0]!;
      const last = value[value.length - 1]!;
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    // Existing env vars win: only add variables not already set.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      set += 1;
    }
  }
  return set;
}

/**
 * When the config opts in (`envFile: true`), load the host's `.env` file
 * (the `.env` in `localCwd`) into `process.env` so its values are available
 * for secret / gh CLI token resolution. No-op otherwise. Call it after the
 * config is loaded and before any resolver that reads the host environment
 * (resolveSecrets, resolveGhCliHosts). See loadDotEnv for the rules: existing
 * env vars win, missing/unreadable files are ignored, and nothing is ever
 * exposed to the guest.
 */
export function maybeLoadDotEnv(
  localCwd: string,
  config: GondolinConfig,
): void {
  if (config.envFile !== true) return;
  loadDotEnv(path.join(localCwd, ".env"));
}
