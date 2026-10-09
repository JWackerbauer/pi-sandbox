// GitHub access for the sandbox: install & authenticate the `gh` CLI for the
// configured hosts (github.com and/or GitHub Enterprise hosts), and expose a
// host's repos as a lazily-cloned, read-only "magic" dir under /git.
//
// See config.ts (GitHubOrgConfig / ResolvedGitHubOrg) and config-loader.ts
// (resolveGitHubOrgs) for how the configured hosts and tokens are resolved.

import fs from "node:fs";
import path from "node:path";
import { getSystemErrorName } from "node:util";

import {
  RealFSProvider,
  ReadonlyProvider,
  VirtualProvider as VirtualProviderBase,
  ERRNO,
  createVirtualDirStats,
  formatVirtualEntries,
  isWriteFlag,
  normalizeVfsPath,
} from "@earendil-works/gondolin";
import type {
  VM,
  VirtualFileHandle,
  VirtualProvider,
} from "@earendil-works/gondolin";
import {
  GUEST_MAGIC_CLONES,
  GUEST_MAGIC_DIR,
  type ResolvedGitHubOrg,
} from "./config";

// The base VirtualProvider value is loaded from the SDK as a constructor
// signature that is not directly extendable; cast it once to keep the
// provider readable (mirrors the SDK's own ReadonlyVirtualProvider).
const VirtualProviderClass = VirtualProviderBase as unknown as {
  new (...args: any[]): any;
};

/** Runs a command inside the guest and returns its captured output. */
export type GuestExec = (
  argv: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// A small local copy of the SDK's (non-exported) errno-error helper, so the
// magic-dir provider can raise proper `ENOENT`/`EROFS`/... errors for the
// guest's VFS layer.
function createErrnoError(
  errno: number,
  syscall: string,
  pathArg?: string,
): NodeJS.ErrnoException {
  let code = "EUNKNOWN";
  try {
    code = getSystemErrorName(errno);
  } catch {
    code = `ERRNO_${errno}`;
  }
  const message = pathArg
    ? `${code}: ${syscall} '${pathArg}'`
    : `${code}: ${syscall}`;
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  if (pathArg) error.path = pathArg;
  return error;
}

// Quote a single argument for safe interpolation into a `bash -lc` string.
function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

type ResolvedPath =
  | { kind: "root" }
  | { kind: "host"; host: string }
  | { kind: "owner"; host: string; owner: string }
  | {
      kind: "repo";
      host: string;
      owner: string;
      repo: string;
      relativePath: string;
    };

export interface MagicGitProviderOptions {
  /** Hosts to expose (the `magicDir: true` configured hosts). */
  hosts: string[];
  /**
   * Host path backing GUEST_MAGIC_CLONES: `gh repo clone` (running in the
   * guest) writes into this dir, and the provider serves it read-only.
   */
  cloneRoot: string;
  /** Runs `gh` inside the guest. */
  execInGuest: GuestExec;
}

/**
 * A read-only VFS provider that exposes configured GitHub hosts as a
 * lazily-cloned tree under /git:
 *
 *   /git                                   → the enabled hosts
 *   /git/<host>/<owner>                    → that owner's repos (gh repo list)
 *   /git/<host>/<owner>/<repo>/...         → the cloned repo (read-only)
 *
 * The host level is a namespace (not independently listable — there is no
 * "list all owners" API); the agent addresses an owner by name. Listing an
 * owner and cloning a repo both shell out to `gh` inside the guest, where it
 * is installed and authenticated. Files are served from a host-backed clone
 * dir (GUEST_MAGIC_CLONES) via a RealFSProvider.
 */
export class MagicGitProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly hosts: string[];
  private readonly cloneRoot: string;
  private readonly execInGuest: GuestExec;
  private readonly owners = new Map<string, string[]>();
  private readonly repos = new Map<string, VirtualProvider>();

  constructor(options: MagicGitProviderOptions) {
    super();
    this.hosts = [...options.hosts].sort();
    this.cloneRoot = options.cloneRoot;
    this.execInGuest = options.execInGuest;
  }

  get readonly(): boolean {
    return true;
  }

  get supportsSymlinks(): boolean {
    // Cloned git repos can contain symlinks.
    return true;
  }

  get supportsWatch(): boolean {
    return false;
  }

  // ── Read operations (the guest's FUSE→host RPC invokes the async forms) ──

  async open(entryPath: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
    if (isWriteFlag(flags)) {
      throw createErrnoError(ERRNO.EROFS, "open", entryPath);
    }
    const resolved = this.resolve(entryPath);
    if (resolved.kind !== "repo" || isRepoRoot(resolved)) {
      throw createErrnoError(ERRNO.EISDIR, "open", entryPath);
    }
    const provider = await this.getRepoProvider(resolved);
    return provider.open(resolved.relativePath, flags, mode);
  }

  async stat(entryPath: string, options?: object): Promise<fs.Stats> {
    return this.statImpl(entryPath, options, true);
  }

  async lstat(entryPath: string, options?: object): Promise<fs.Stats> {
    return this.statImpl(entryPath, options, false);
  }

  async readdir(
    entryPath: string,
    options?: object,
  ): Promise<Array<string | fs.Dirent>> {
    const resolved = this.resolve(entryPath);
    const withTypes = withFileTypes(options);
    switch (resolved.kind) {
      case "root":
        return formatVirtualEntries(this.hosts, withTypes);
      case "host":
        this.assertHost(resolved.host);
        // A host is a namespace; owners are addressed by name, not listed.
        return formatVirtualEntries([], withTypes);
      case "owner": {
        this.assertHost(resolved.host);
        const repos = await this.listRepos(resolved.host, resolved.owner);
        return formatVirtualEntries(repos, withTypes);
      }
      case "repo":
        return (await this.getRepoProvider(resolved)).readdir(
          resolved.relativePath,
          options,
        );
    }
  }

  async access(entryPath: string, mode?: number): Promise<void> {
    const resolved = this.resolve(entryPath);
    switch (resolved.kind) {
      case "root":
        return;
      case "host":
        this.assertHost(resolved.host);
        return;
      case "owner":
        this.assertHost(resolved.host);
        await this.listRepos(resolved.host, resolved.owner);
        return;
      case "repo":
        if (isRepoRoot(resolved)) return;
        const provider = await this.getRepoProvider(resolved);
        if (provider.access) await provider.access(resolved.relativePath, mode);
        return;
    }
  }

  async readlink(entryPath: string, options?: object): Promise<string> {
    const resolved = this.resolve(entryPath);
    if (resolved.kind !== "repo" || isRepoRoot(resolved)) {
      throw createErrnoError(ERRNO.EINVAL, "readlink", entryPath);
    }
    const provider = await this.getRepoProvider(resolved);
    if (provider.readlink) {
      return provider.readlink(resolved.relativePath, options);
    }
    throw createErrnoError(ERRNO.EINVAL, "readlink", entryPath);
  }

  async realpath(entryPath: string, options?: object): Promise<string> {
    const resolved = this.resolve(entryPath);
    if (resolved.kind === "repo") {
      if (isRepoRoot(resolved)) return normalizeVfsPath(entryPath);
      const provider = await this.getRepoProvider(resolved);
      if (provider.realpath) {
        return provider.realpath(resolved.relativePath, options);
      }
      return normalizeVfsPath(entryPath);
    }
    return normalizeVfsPath(entryPath);
  }

  // ── Sync stubs ──────────────────────────────────────────────────────────
  // The guest reaches this mount through the FUSE→host RPC, which uses the
  // async methods above. The sync forms are not supported (they would have to
  // perform asynchronous `gh` work), so they fail loudly rather than hang.

  openSync(): VirtualFileHandle {
    throw createErrnoError(ERRNO.ENOSYS, "openSync");
  }
  statSync(): fs.Stats {
    throw createErrnoError(ERRNO.ENOSYS, "statSync");
  }
  lstatSync(): fs.Stats {
    throw createErrnoError(ERRNO.ENOSYS, "lstatSync");
  }
  readdirSync(): Array<string | fs.Dirent> {
    throw createErrnoError(ERRNO.ENOSYS, "readdirSync");
  }
  mkdirSync(): void | string {
    throw createErrnoError(ERRNO.EROFS, "mkdir");
  }
  rmdirSync(): void {
    throw createErrnoError(ERRNO.EROFS, "rmdir");
  }
  unlinkSync(): void {
    throw createErrnoError(ERRNO.EROFS, "unlink");
  }
  renameSync(): void {
    throw createErrnoError(ERRNO.EROFS, "rename");
  }
  // Async write forms: reject with EROFS (read-only mount).
  async mkdir(): Promise<void | string> {
    throw createErrnoError(ERRNO.EROFS, "mkdir");
  }
  async rmdir(): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "rmdir");
  }
  async unlink(): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "unlink");
  }
  async rename(): Promise<void> {
    throw createErrnoError(ERRNO.EROFS, "rename");
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async statImpl(
    entryPath: string,
    options: object | undefined,
    follow: boolean,
  ): Promise<fs.Stats> {
    const resolved = this.resolve(entryPath);
    switch (resolved.kind) {
      case "root":
        return createVirtualDirStats();
      case "host":
        this.assertHost(resolved.host);
        return createVirtualDirStats();
      case "owner":
        this.assertHost(resolved.host);
        // Validate + warm the cache; an unknown owner yields ENOENT.
        await this.listRepos(resolved.host, resolved.owner);
        return createVirtualDirStats();
      case "repo":
        if (isRepoRoot(resolved)) return createVirtualDirStats();
        const provider = await this.getRepoProvider(resolved);
        return follow
          ? provider.stat(resolved.relativePath, options)
          : provider.lstat(resolved.relativePath, options);
    }
  }

  private resolve(entryPath: string): ResolvedPath {
    const normalized = normalizeVfsPath(entryPath);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return { kind: "root" };
    if (parts.length === 1) return { kind: "host", host: parts[0] };
    if (parts.length === 2) {
      return { kind: "owner", host: parts[0], owner: parts[1] };
    }
    const [host, owner, repo, ...rest] = parts;
    const relativePath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
    return { kind: "repo", host, owner, repo, relativePath };
  }

  private assertHost(host: string): void {
    if (!this.hosts.includes(host)) {
      throw createErrnoError(ERRNO.ENOENT, "stat", `/${host}`);
    }
  }

  // List an owner's repo names for a host, cached. Shells out to `gh` in the
  // guest. A non-existent owner (gh failure) raises ENOENT and is not
  // cached, so a transient failure is not pinned as an empty list.
  private async listRepos(host: string, owner: string): Promise<string[]> {
    const key = `${host}/${owner}`;
    const cached = this.owners.get(key);
    if (cached) return cached;

    const out = await this.gh(host, [
      "repo",
      "list",
      owner,
      "--limit",
      "1000",
      "--json",
      "name",
    ]);
    if (out.exitCode !== 0) {
      throw createErrnoError(ERRNO.ENOENT, "readdir", `/${host}/${owner}`);
    }
    let names: string[] = [];
    try {
      const parsed = JSON.parse(out.stdout) as Array<{ name?: unknown }>;
      names = (Array.isArray(parsed) ? parsed : [])
        .map((r) => r?.name)
        .filter((n): n is string => typeof n === "string");
    } catch {
      names = [];
    }
    this.owners.set(key, names);
    return names;
  }

  // Get (and lazily clone) the read-only provider for a repo. The clone is
  // awaited so the caller never serves a partially-populated repo.
  private async getRepoProvider(
    resolved: Extract<ResolvedPath, { kind: "repo" }>,
  ): Promise<VirtualProvider> {
    const key = `${resolved.host}/${resolved.owner}/${resolved.repo}`;
    const cached = this.repos.get(key);
    if (cached) return cached;

    const hostClonePath = path.join(
      this.cloneRoot,
      resolved.host,
      resolved.owner,
      resolved.repo,
    );
    const guestClonePath = `${GUEST_MAGIC_CLONES}/${resolved.host}/${
      resolved.owner
    }/${resolved.repo}`;

    if (!fs.existsSync(hostClonePath)) {
      // Ensure the parent exists (host side) so `gh repo clone` can create the
      // final dir in the guest.
      fs.mkdirSync(path.dirname(hostClonePath), { recursive: true });
      await this.cloneRepo(resolved, hostClonePath, guestClonePath);
    }

    const provider = new ReadonlyProvider(new RealFSProvider(hostClonePath));
    this.repos.set(key, provider);
    return provider;
  }

  private async cloneRepo(
    resolved: Extract<ResolvedPath, { kind: "repo" }>,
    hostClonePath: string,
    guestClonePath: string,
  ): Promise<void> {
    const out = await this.gh(resolved.host, [
      "repo",
      "clone",
      `${resolved.owner}/${resolved.repo}`,
      guestClonePath,
    ]);
    if (out.exitCode !== 0) {
      const detail = [out.stdout.trim(), out.stderr.trim()]
        .filter((d) => d.length > 0)
        .join("\n");
      throw new Error(
        `gondolin: failed to clone ${resolved.host}/${resolved.owner}/${
          resolved.repo
        }:\n${detail || "(no output)"}`,
      );
    }
  }

  private async gh(
    host: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const command = `GH_HOST=${quoteArg(host)} gh ${args.map(quoteArg).join(" ")}`;
    return this.execInGuest(["/bin/bash", "-lc", command]);
  }
}

function isRepoRoot(
  resolved: Extract<ResolvedPath, { kind: "repo" }>,
): boolean {
  return resolved.relativePath === "/";
}

function withFileTypes(options?: object): boolean {
  return Boolean(
    (options as { withFileTypes?: boolean } | undefined)?.withFileTypes,
  );
}

// ─── gh installation & authentication ──────────────────────────────────────

/**
 * Install the `gh` CLI (if not already present) and write a `hosts.yml`
 * authenticating each configured host with its token. Runs inside the guest.
 * A failure here fails the VM launch with the command output surfaced.
 */
export async function setupGithubOrgs(
  vm: VM,
  orgs: ResolvedGitHubOrg[],
): Promise<void> {
  if (orgs.length === 0) return;

  const install = await vm.exec(["/bin/sh", "-lc", GH_INSTALL_SCRIPT]);
  if (install.exitCode !== 0) {
    const detail = [install.stdout.trim(), install.stderr.trim()]
      .filter((d) => d.length > 0)
      .join("\n") || "(no output)";
    throw new Error(
      `gondolin: failed to install the gh CLI in the guest:\n${detail}`,
    );
  }

  const yaml = renderGhHostsYaml(orgs);
  await vm.fs.mkdir("/root/.config/gh", { recursive: true });
  await vm.fs.writeFile("/root/.config/gh/hosts.yml", yaml);
}

// Renders the `gh` hosts file: each host mapped to its https git protocol and
// oauth token. `gh` reads this in headless/container environments (the same
// store `gh auth login --with-token` writes).
export function renderGhHostsYaml(orgs: ResolvedGitHubOrg[]): string {
  return orgs
    .map(
      (org) =>
        `${org.host}:\n` +
        `    git_protocol: https\n` +
        `    oauth_token: ${org.token}`,
    )
    .join("\n") + "\n";
}

// Installs `gh`: prefer the Alpine package; fall back to the official release
// binary (the stock image ships curl, jq and git, and can reach github.com).
const GH_INSTALL_SCRIPT = `
set -e
if command -v gh >/dev/null 2>&1; then exit 0; fi
if apk add --no-cache gh >/dev/null 2>&1; then exit 0; fi
case "$(uname -m)" in
  aarch64) gharch=aarch64 ;;
  x86_64)  gharch=x86_64 ;;
  *) echo "gondolin: unsupported guest arch for gh install: $(uname -m)" >&2; exit 1 ;;
esac
ver="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name)"
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/cli/cli/releases/download/\${ver}/gh_\${ver#v}_linux_\${gharch}.tar.gz" -o "$tmp/gh.tar.gz"
tar -xzf "$tmp/gh.tar.gz" -C "$tmp"
install -m 0755 "$tmp"/gh_*/bin/gh /usr/local/bin/gh
rm -rf "$tmp"
`;

// ─── System prompt ──────────────────────────────────────────────────────────

/**
 * A short, human-readable line describing the configured GitHub hosts, for
 * inclusion in the system prompt. Empty when the feature is not configured.
 * The detailed how-to lives in the `github` skill (loaded on demand).
 */
export function githubPromptLine(orgs: ResolvedGitHubOrg[]): string {
  if (orgs.length === 0) return "";
  const hosts = orgs.map((o) => o.host).join(", ");
  let line = `GitHub: the \`gh\` CLI is installed and authenticated for: ${hosts}.`;
  const magicHosts = orgs.filter((o) => o.magicDir).map((o) => o.host);
  if (magicHosts.length > 0) {
    line +=
      ` Repos are browsable as a read-only magic dir at ${GUEST_MAGIC_DIR} (` +
      `${magicHosts.map((h) => `${GUEST_MAGIC_DIR}/${h}`).join(", ")}).`;
  }
  line += ` See the \`github\` skill for how to use gh and the magic dir.`;
  return line;
}
