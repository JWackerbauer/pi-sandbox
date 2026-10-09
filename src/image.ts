// Resolves the image assets directory for a VM launch: the stock image
// (built from image/image.json via `npm run build:basic-image`), or — when
// the config carries a `postBuild` section — a custom image built from the
// stock config plus that section, cached under the repo's .pi folder (or
// the global agent dir for a global-only postBuild).

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAssets,
  parseBuildConfig,
  verifyAssets,
  type BuildConfig,
  type BuildOptions,
} from "@earendil-works/gondolin";
import type { PostBuildResolution } from "./config-loader";

/** Directory name for image assets (stock and custom). */
const ASSETS_DIR_NAME = "assets";
/** File recording the cache key of a custom image build. */
const POSTBUILD_HASH_FILE = ".gondolin-postbuild";
/** Build log file written into the assets folder when a build fails. */
const BUILD_LOG_FILE = "build.log";

// Path of the stock image assets, relative to this module.
export function stockImageDir(): string {
  return path.join(path.resolve(__dirname), "..", "image", ASSETS_DIR_NAME);
}

// Path of the stock image's build config.
function stockImageConfigPath(): string {
  return path.join(path.resolve(__dirname), "..", "image", "image.json");
}

/**
 * Resolve the image assets directory to launch from. Without a postBuild
 * section this is the stock image dir. With one, a custom image is built
 * (from the stock image.json plus the postBuild section) and cached under
 * the resolved assetDir; a cached build is reused while its cache key
 * matches and its asset manifest verifies.
 */
export async function resolveImageAssets(
  postBuild: PostBuildResolution | null,
  onLog?: (line: string) => void,
): Promise<string> {
  if (!postBuild) return stockImageDir();
  return ensureCustomImageAssets(postBuild, onLog);
}

// In-process build lock: concurrent launches (e.g. a main VM and a subagent
// racing at startup) share one build per assetDir instead of double-building.
const builds = new Map<string, Promise<string>>();

function ensureCustomImageAssets(
  resolution: PostBuildResolution,
  onLog?: (line: string) => void,
): Promise<string> {
  const existing = builds.get(resolution.assetDir);
  if (existing) return existing;
  const promise = doEnsureCustomImageAssets(resolution, onLog).finally(() =>
    builds.delete(resolution.assetDir),
  );
  builds.set(resolution.assetDir, promise);
  return promise;
}

async function doEnsureCustomImageAssets(
  resolution: PostBuildResolution,
  onLog?: (line: string) => void,
): Promise<string> {
  const { postBuild, assetDir } = resolution;
  const baseConfigPath = stockImageConfigPath();
  // The cache key covers both the postBuild section and the stock image
  // config, so a change to either invalidates a cached build.
  const key = buildCacheKey(postBuild, baseConfigPath);
  const hashFile = path.join(assetDir, POSTBUILD_HASH_FILE);

  if (
    fs.existsSync(hashFile) &&
    fs.readFileSync(hashFile, "utf8") === key &&
    verifyAssets(assetDir)
  ) {
    return assetDir;
  }

  // (Re)build: clear any stale assets, then build the stock config plus the
  // postBuild section into the cache dir.
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });
  onLog?.(
    `gondolin: building custom image (postBuild) into ${assetDir} — this can take a while`,
  );
  const base = parseBuildConfig(fs.readFileSync(baseConfigPath, "utf8"));
  const config: BuildConfig = { ...base, postBuild };
  const options: BuildOptions = {
    outputDir: assetDir,
    configDir: path.dirname(baseConfigPath),
    verbose: true,
  };

  // Off-Linux, the SDK runs postBuild.commands inside a container (it cannot
  // execute the aarch64 rootfs's shell natively on macOS). Verify a container
  // daemon is actually up first, so a missing/stopped Docker fails with a
  // clear message instead of a cryptic in-container error.
  const needsContainer =
    process.platform !== "linux" && (postBuild.commands?.length ?? 0) > 0;
  if (needsContainer) {
    const runtime = detectContainerRuntime();
    if (!runtime) {
      throw new Error(
        "gondolin: building a custom image (postBuild.commands) on this host " +
          "requires a running Docker or Podman daemon, but none was found. " +
          "Start Docker Desktop (or install/start Podman) and try again.",
      );
    }
    onLog?.(
      `gondolin: running postBuild in a ${runtime} container (required off-Linux)`,
    );
  }

  // On macOS the SDK's container build creates its workdir under os.tmpdir()
  // (/var/folders/...), which Docker Desktop does not share with its VM — so
  // the /work volume mount comes up empty and the build dies with "can't open
  // '/work/build-in-container.sh'". Steer os.tmpdir() (via $TMPDIR) to a
  // home-dir subfolder, which Docker Desktop always shares, for the build.
  const macBuildTmp =
    needsContainer && process.platform === "darwin"
      ? fs.mkdtempSync(path.join(os.homedir(), ".gondolin-build-tmp-"))
      : null;
  const prevTmpdir = process.env.TMPDIR;
  if (macBuildTmp) process.env.TMPDIR = macBuildTmp;
  try {
    await runBuildWithCapturedLogs(config, options, onLog);
  } finally {
    if (macBuildTmp) {
      process.env.TMPDIR = prevTmpdir;
      fs.rmSync(macBuildTmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(hashFile, key);
  // Keep the built assets out of the repo's git history.
  ensureAssetsGitignore(assetDir);
  onLog?.(`gondolin: custom image ready at ${assetDir}`);
  return assetDir;
}

/**
 * Run buildAssets while capturing its console output, line by line, and
 * forwarding each line to onLog (so the caller can render it in the TUI).
 *
 * The SDK has no log callback: buildAssets and the child processes it
 * spawns write straight to process.stderr (verbose mode). We temporarily
 * intercept process.stderr.write, split the output into lines, and swallow
 * the console output. On failure the captured log is written to
 * <outputDir>/build.log and the log path is appended to the error message.
 */
async function runBuildWithCapturedLogs(
  config: BuildConfig,
  options: BuildOptions,
  onLog?: (line: string) => void,
): Promise<void> {
  const originalWrite = process.stderr.write;
  const lines: string[] = [];
  let pending = "";
  process.stderr.write = ((
    chunk: string | Uint8Array,
  ): boolean => {
    pending +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      onLog?.(line);
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    await buildAssets(config, options);
  } catch (err) {
    flushPending();
    const logPath = path.join(options.outputDir, BUILD_LOG_FILE);
    fs.mkdirSync(options.outputDir, { recursive: true });
    fs.writeFileSync(logPath, lines.join("\n"));
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.message += `\ngondolin: build log: ${logPath}`;
    throw failure;
  } finally {
    process.stderr.write = originalWrite;
  }
  flushPending();

  function flushPending(): void {
    if (!pending) return;
    lines.push(pending);
    onLog?.(pending);
    pending = "";
  }
}

/**
 * Find a container runtime whose daemon is actually up (Docker preferred,
 * then Podman). Returns the runtime name, or null if none is usable. Both
 * `docker info` and `podman info` fail when the engine/daemon is not running,
 * so this distinguishes "installed" from "ready".
 */
/**
 * Find a container runtime whose daemon is actually up (Docker preferred,
 * then Podman). Returns the runtime name, or null if none is usable. Both
 * `docker info` and `podman info` fail when the engine/daemon is not running,
 * so this distinguishes "installed" from "ready".
 */
export function detectContainerRuntime(): "docker" | "podman" | null {
  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["info"], { stdio: "ignore", timeout: 15_000 });
      return runtime;
    } catch {
      // not installed, or daemon not up — try the next one
    }
  }
  return null;
}

/** Cache key: sha256 over the postBuild section and the stock image config. */
function buildCacheKey(
  postBuild: PostBuildResolution["postBuild"],
  baseConfigPath: string,
): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(baseConfigPath, "utf8"));
  hash.update(JSON.stringify(postBuild));
  return hash.digest("hex");
}

/**
 * When the assets live in a repo's `.pi` folder, make sure
 * `<repo>/.pi/.gitignore` ignores the assets folder, so the built image
 * never ends up in the repo's git history.
 */
function ensureAssetsGitignore(assetDir: string): void {
  const dotPiDir = path.dirname(assetDir);
  if (path.basename(dotPiDir) !== ".pi") return;
  const gitignorePath = path.join(dotPiDir, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // no .gitignore yet
  }
  const lines = content
    .split("\n")
    .map((line) => line.trim());
  if (lines.includes(`${ASSETS_DIR_NAME}/`)) return;
  fs.writeFileSync(
    gitignorePath,
    (content && !content.endsWith("\n") ? `${content}\n` : content) +
      `${ASSETS_DIR_NAME}/\n`,
  );
}
