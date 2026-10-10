// GitHub access for the sandbox, split into two independent features:
//
// 1. Magic dir (host-side): the host's own `gh` (authenticated via
//    `gh auth login`) lists repos and lazily clones them into a host temp
//    dir, which MagicGitProvider serves read-only under /git in the guest.
//    The guest never sees a token. Mirrors the SDK's magic-git example:
//    all `gh` work happens on the host, so no guest RPC is ever awaited
//    while a clone writes through a host-backed mount (that would deadlock).
//
// 2. gh CLI (guest-side): when `ghCliToken` is configured for a host, the
//    `gh` CLI is installed in the guest and authenticated through a
//    Gondolin secret (the guest only ever sees the secret's placeholder;
//    egress is restricted to the host). hosts.yml is generated in the guest
//    from the placeholders — never copied from the host.
//
// See config.ts (GitHubOrgConfig / GhCliHost / ghCliSecretName) and
// config-loader.ts (resolveMagicDirHosts / resolveGhCliHosts) for how the
// configured hosts are resolved.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
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
import { GUEST_MAGIC_DIR } from "./config";

const pExecFile = promisify(execFile);

// The base VirtualProvider value is loaded from the SDK as a constructor
// signature that is not directly extendable; cast it once to keep the
// provider readable (mirrors the SDK's own ReadonlyVirtualProvider).
const VirtualProviderClass = VirtualProviderBase as unknown as {
  new (...args: any[]): any;
};

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
   * Host path where repos are cloned (a host temp dir, NOT mounted into the
   * guest). The provider serves it read-only under /git.
   */
  cloneRoot: string;
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
 * owner and cloning a repo both shell out to `gh` on the host, where it is
 * installed and authenticated via `gh auth login`. Clones are written to a
 * temp dir and renamed into place on success, so an interrupted clone is
 * never served as a complete repo.
 */
export class MagicGitProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly hosts: string[];
  private readonly cloneRoot: string;
  private readonly owners = new Map<string, string[]>();
  private readonly repos = new Map<string, VirtualProvider>();

  constructor(options: MagicGitProviderOptions) {
    super();
    this.hosts = [...options.hosts].sort();
    this.cloneRoot = options.cloneRoot;
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
  // async methods above. The sync forms are not supported (they would have
  // to perform asynchronous `gh` work), so they fail loudly rather than hang.

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

  // List an owner's repo names for a host, cached. Shells out to `gh` on the
  // host. A non-existent owner (gh failure) raises ENOENT and is not
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
  // awaited so the caller never serves a partially-populated repo: it is
  // written to a temp dir and renamed into place only on success, so a
  // failed/interrupted clone leaves no dir behind to be served as complete.
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

    if (!fs.existsSync(hostClonePath)) {
      // Ensure the parent exists (host side) so `gh repo clone` can create
      // the final dir.
      fs.mkdirSync(path.dirname(hostClonePath), { recursive: true });
      const tmpClonePath = `${hostClonePath}.cloning-${
        crypto.randomBytes(6).toString("hex")
      }`;
      try {
        await this.cloneRepo(resolved, tmpClonePath);
        fs.renameSync(tmpClonePath, hostClonePath);
      } catch (err) {
        fs.rmSync(tmpClonePath, { recursive: true, force: true });
        throw err;
      }
    }

    const provider = new ReadonlyProvider(new RealFSProvider(hostClonePath));
    this.repos.set(key, provider);
    return provider;
  }

  private async cloneRepo(
    resolved: Extract<ResolvedPath, { kind: "repo" }>,
    clonePath: string,
  ): Promise<void> {
    const out = await this.gh(resolved.host, [
      "repo",
      "clone",
      `${resolved.owner}/${resolved.repo}`,
      clonePath,
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

  // Run `gh` on the host for a specific host. The host's `gh` is
  // authenticated by the user (`gh auth login`); GH_HOST selects the
  // configured host (required for GHE hosts, harmless for github.com).
  private async gh(
    host: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await pExecFile("gh", args, {
        env: { ...process.env, GH_HOST: host },
        encoding: "utf8",
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.code ?? 1,
      };
    }
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

// ─── Magic dir host-side prerequisites ────────────────────────────────────

/**
 * Verify the host machine can serve the magic dir for the given hosts: the
 * `gh` CLI is installed and authenticated (via `gh auth login`) for each.
 * A failure fails the VM launch with an actionable message — the magic dir
 * is host-side by design, so the fix is on the host, not in the guest.
 */
export async function checkHostGhAuth(hosts: string[]): Promise<void> {
  for (const host of hosts) {
    let stderr = "";
    let exitCode = 0;
    try {
      await pExecFile("gh", ["auth", "status"], {
        env: { ...process.env, GH_HOST: host },
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { stderr?: string; code?: number };
      stderr = e.stderr ?? String(err);
      exitCode = e.code ?? 1;
    }
    if (exitCode !== 0) {
      throw new Error(
        `gondolin: the magic dir for ${host} needs the host's \`gh\` CLI ` +
          `installed and authenticated for that host.\n` +
          `Run on the host:\n    GH_HOST=${host} gh auth login\n` +
          `${stderr.trim()}`,
      );
    }
  }
}

// ─── gh CLI in the guest ──────────────────────────────────────────────────

/**
 * Install the `gh` CLI (if not already present) and write a `hosts.yml`
 * authenticating each host with the *placeholder* of its Gondolin secret.
 * The placeholder is what the guest ever sees; the http hooks substitute the
 * real token at egress, restricted to the host. The hosts file is generated
 * here from the config — it is never copied from the host — so the guest
 * config is ephemeral and never exposes the real token.
 * A failure here fails the VM launch with the command output surfaced.
 */
export async function setupGhCli(
  vm: VM,
  hosts: Array<{ host: string; placeholder: string }>,
): Promise<void> {
  if (hosts.length === 0) return;

  const install = await vm.exec(["/bin/sh", "-lc", GH_INSTALL_SCRIPT]);
  if (install.exitCode !== 0) {
    const detail = [install.stdout.trim(), install.stderr.trim()]
      .filter((d) => d.length > 0)
      .join("\n") || "(no output)";
    throw new Error(
      `gondolin: failed to install the gh CLI in the guest:\n${detail}`,
    );
  }

  const yaml = renderGhHostsYaml(
    hosts.map((h) => ({ host: h.host, token: h.placeholder })),
  );
  await vm.fs.mkdir("/root/.config/gh", { recursive: true });
  await vm.fs.writeFile("/root/.config/gh/hosts.yml", yaml);
}

// Renders the `gh` hosts file: each host mapped to its https git protocol
// and oauth token (in practice the secret's placeholder). `gh` reads this in
// headless/container environments (the same store `gh auth login
// --with-token` writes).
export function renderGhHostsYaml(
  hosts: Array<{ host: string; token: string }>,
): string {
  return (
    hosts
      .map(
        (h) =>
          `${h.host}:\n` +
          `    git_protocol: https\n` +
          `    oauth_token: ${h.token}`,
      )
      .join("\n") + "\n"
  );
}

// Installs `gh` from the Alpine package (the stock image's repository has
// `github-cli`).
const GH_INSTALL_SCRIPT = `set -e
command -v gh >/dev/null 2>&1 || apk add --no-cache github-cli
`;

// ─── System prompt ─────────────────────────────────────────────────────────

/**
 * A short, human-readable line describing the enabled GitHub features, for
 * inclusion in the system prompt. Empty when neither feature is configured.
 * The gh CLI instructions are included inline (per the feature design); the
 * detailed how-to lives in the `github` skill (loaded on demand).
 */
export function githubPromptLine(
  magicHosts: string[],
  ghCliHosts: string[],
): string {
  const parts: string[] = [];
  if (magicHosts.length > 0) {
    parts.push(
      `Repos are browsable as a read-only magic dir at ${GUEST_MAGIC_DIR} ` +
        `(${magicHosts.map((h) => `${GUEST_MAGIC_DIR}/${h}`).join(", ")}).`,
    );
  }
  if (ghCliHosts.length > 0) {
    parts.push(
      `The \`gh\` CLI is installed and authenticated for: ${
        ghCliHosts.join(", ")
      }. Always set \`GH_HOST=<host>\` when running gh (required for GHE ` +
        `hosts), e.g. \`GH_HOST=github.com gh repo list <owner>\`, ` +
        `\`GH_HOST=github.com gh repo clone <owner>/<repo> <dir>\`, ` +
        `\`GH_HOST=github.com gh pr create ...\`.`,
    );
  }
  if (parts.length === 0) return "";
  return parts.join(" ") + ` See the \`github\` skill for details.`;
}
