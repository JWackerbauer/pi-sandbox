// Resolves the image assets directory for a VM launch: the stock image
// (built from image/image.json via `npm run build:basic-image`), or — when
// the config carries a `postBuild` section — a custom image built from the
// stock config plus that section, cached under the repo's .pi folder (or
// the global agent dir for a global-only postBuild).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildAssets,
  parseBuildConfig,
  verifyAssets,
  type BuildConfig,
} from "@earendil-works/gondolin";
import type { PostBuildResolution } from "./config-loader";

/** Directory name for image assets (stock and custom). */
const ASSETS_DIR_NAME = "assets";
/** File recording the cache key of a custom image build. */
const POSTBUILD_HASH_FILE = ".gondolin-postbuild";

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
  onNotice?: (message: string) => void,
): Promise<string> {
  if (!postBuild) return stockImageDir();
  return ensureCustomImageAssets(postBuild, onNotice);
}

// In-process build lock: concurrent launches (e.g. a main VM and a subagent
// racing at startup) share one build per assetDir instead of double-building.
const builds = new Map<string, Promise<string>>();

function ensureCustomImageAssets(
  resolution: PostBuildResolution,
  onNotice?: (message: string) => void,
): Promise<string> {
  const existing = builds.get(resolution.assetDir);
  if (existing) return existing;
  const promise = doEnsureCustomImageAssets(resolution, onNotice).finally(() =>
    builds.delete(resolution.assetDir),
  );
  builds.set(resolution.assetDir, promise);
  return promise;
}

async function doEnsureCustomImageAssets(
  resolution: PostBuildResolution,
  onNotice?: (message: string) => void,
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
  onNotice?.(
    `gondolin: building custom image (postBuild) into ${assetDir} — this can take a while`,
  );
  const base = parseBuildConfig(fs.readFileSync(baseConfigPath, "utf8"));
  const config: BuildConfig = { ...base, postBuild };
  await buildAssets(config, {
    outputDir: assetDir,
    configDir: path.dirname(baseConfigPath),
    verbose: false,
  });
  fs.writeFileSync(hashFile, key);
  // Keep the built assets out of the repo's git history.
  ensureAssetsGitignore(assetDir);
  onNotice?.(`gondolin: custom image ready at ${assetDir}`);
  return assetDir;
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
