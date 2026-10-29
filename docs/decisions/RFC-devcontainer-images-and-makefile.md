# RFC: devcontainer-driven Gondolin images & a setup Makefile

- **Status:** Draft — **partially superseded**: the `postBuild` image hook is
  now supported directly as a `postBuild` section in `gondolin.json` (global
  or `<repo>/.pi/gondolin.json`), built into a custom image at startup and
  cached under the repo's `.pi/assets`. The devcontainer-parsing layer in
  Feature A (and the `postCreateCommand` → `postBuild.commands` mapping in
  particular) is no longer needed for the common case; Feature B (Makefile)
  remains open.
- **Author:** (pending)
- **Date:** YYYY-MM-DD (placeholder)

## Summary

Two features were deferred from the current `gondolin-sandbox` work and are
specified here:

- **Feature A** — when a repo contains a `.devcontainer/devcontainer.json`,
  parse it and build a **dedicated Gondolin image** for that repo whose rootfs
  includes the repo's dev dependencies, so the agent's VMs (main session and
  subagents) start with the tools the project needs. The image is cached under
  a per-repo directory and rebuilt only when the devcontainer config changes.
- **Feature B** — a top-level `Makefile` for the `gondolin-sandbox` package that
  checks host dependencies, builds the stock image (via `buildAssets` from
  `image.json`), optionally builds a per-repo devcontainer image, installs the
  extension into pi, and runs typechecks.

Nothing in this RFC changes the guest-internal behavior of the extension; it
only changes **which image** `VM.create` receives and provides a
developer-facing build/install surface.

Grounding: existing files `gondolin-sandbox/config.ts`,
`config-loader.ts`, `vm.ts` (`launchDetachedVm`), `subagents.ts`,
`image.json`, `package.json`; SDK `@earendil-works/gondolin` 0.13.0
(`buildAssets`, `BuildConfig`, `AlpineConfig`, `AssetManifest`,
`computeAssetBuildId`, `verifyAssets`, `detectContainerRuntime`).

---

## Feature A — devcontainer-driven dedicated images

### A.1. Which devcontainer fields to honor

The devcontainer spec (`.devcontainer/devcontainer.json`) is large; we honor
a pragmatic subset. Field-by-field mapping to a Gondolin `BuildConfig`:

| devcontainer field | Gondolin mapping | Status |
| --- | --- | --- |
| `postCreateCommand` | `BuildConfig.postBuild.commands: [cmd]` (string; shell-array form split on `shellSplit` semantics of the SDK) — runs after apk packages are installed, inside the image build | **Recommended, Phase 1** |
| `containerEnv` | `BuildConfig.env` (baked into the image as guest environment) | **Recommended, Phase 1** |
| `image` | `BuildConfig.oci = { image, pullPolicy: "if-not-present" }` — replaces the stock Alpine rootfs with an OCI-derived rootfs | **Opt-in** (requires docker/podman + network), Phase 2 |
| `features` (devcontainer CLI features) | **No generic mapping** to Alpine apk. Require an explicit convention: a `gondolin` key inside `devcontainer.json` listing apk package names, e.g. `{"features": {...}, "gondolin": {"apk": ["ripgrep", "jq"]}}`. Unknown features → warn + skip | **Opt-in convention, Phase 3** |
| `build` (path to `Dockerfile`, `dockerFile`, `context`, `buildArgs`) | Out of scope (no equivalent in `BuildConfig`; `BuildConfig` has no Dockerfile builder — only `oci.image` pull and `postBuild`) | Out of scope |
| `remoteUser` / `remoteWorkspaceFolder` | No effect on the image; the extension already runs as the image's default user and mounts the repo. Ignored | Ignored |
| `ports` (host/guest) | No mapping: Gondolin VMs are detached krun VMs without published ports; the agent reaches the guest via the SDK. Ignored | Ignored |
| `capAdd`, `securityOpt`, `runArgs`, `privileged` | No krun equivalent. Ignored | Ignored |
| `mounts` (devcontainer bind mounts) | Not mappable to `vfs.mounts` at image build time; the extension's own mounts (`.git`, scratch) are what matter. Ignored | Ignored |
| `customizations.vscode.*` | Editor-specific; irrelevant | Ignored |
| `onCreateCommand`, `postStartCommand`, `postAttachCommand` | Session-lifecycle hooks, not image-build steps. `postCreateCommand` is the closest build-time hook and is honored; the others are **ignored with a warning** | Warn + skip |
| `updateContentCommand` | Session-lifecycle; ignored with a warning | Warn + skip |

**Failure policy:** fields we understand and can map are honored; fields that
have no mapping are **skipped with a warning** (logged once per repo, listing
the skipped fields). We do **not** fail hard on unknown fields — a repo's
devcontainer.json is frequently written for the VS Code devcontainer CLI, and
refusing would make the feature useless. We *do* fail hard (clear error, fall
back to the stock image — see A.6) when a field we *do* claim to honor
(`postCreateCommand`, `containerEnv`) fails to build.

**.devcontainer/Dockerfile:** explicitly out of scope. If a devcontainer.json
uses `build` instead of `image`/`features`, we warn and build the stock
Alpine image plus whatever is mappable from the JSON file.

### A.2. Base image decision

Default: **Gondolin's stock Alpine** — i.e. start from the same `BuildConfig`
as the current `gondolin-sandbox/image.json` (alpine 3.23.0, `linux-virt`,
krunfw v5.2.1, the existing `rootfsPackages` list), then layer on:

1. extra apk packages (Phase 3 convention), and
2. `postBuild.commands` / `env` from the devcontainer.json.

We only switch to an OCI-derived base (`BuildConfig.oci.image`) when the repo
opts in via config (see A.7, `image: "devcontainer"`), because OCI imports
require a container runtime and network on the host.

Resulting `BuildConfig` shape for the common (stock base) case:

```ts
const cfg: BuildConfig = {
  arch: "aarch64",
  distro: "alpine",
  alpine: {
    version: "3.23.0",
    kernelPackage: "linux-virt",
    kernelImage: "vmlinuz-virt",
    rootfsPackages: [
      ...STOCK_ROOTFS_PACKAGES,        // from image.json
      ...devcontainer.apkPackages,     // Phase 3 convention (may be empty)
    ],
    krunfwVersion: "v5.2.1",
  },
  env: devcontainer.containerEnv,      // Phase 1
  postBuild: {
    commands: devcontainer.postCreateCommands, // Phase 1
  },
};
// Phase 2 (opt-in) replaces alpine+rootfs with:
//   oci: { image: devcontainer.image, pullPolicy: "if-not-present" }
```

Note that `BuildConfig` has no "base image" to inherit from — a dedicated
image is a *fresh* build. The stock package list is duplicated into the
dedicated build so the guest keeps `git`, `nodejs`, `uv`, `openssh`, etc.,
which the extension's prepare script and the pi runtime depend on.

### A.3. When to build, cache location, and invalidation

- **Trigger:** a repo gets a dedicated image **only** if
  `.devcontainer/devcontainer.json` exists **and** the repo config (merged
  via `loadGondolinConfig`) enables the feature (`image: "devcontainer"`,
  default **off** — see A.7).
- **Cache location:** a per-repo assets dir under the same host root the
  scratch feature uses, so nothing new is added to the filesystem layout:
  `<tempdir>/gondolin/<repo-key>/image` (repo-key from the existing
  `computeRepoKey(localCwd)` in `config-loader.ts`, matching
  `hostScratchRoot(tempdir, repoKey)`). We deliberately do **not** use
  Gondolin's image store (`setImageRef`/`listImageRefs`) for the cache:
  a plain directory is trivially inspectable, deletable, and shareable with
  `imagePath` directly.
- **Cache key:** a stable hash of the *effective* devcontainer inputs — the
  devcontainer.json contents, the stock base config version (so a new pi/gondolin
  base forces a rebuild), and the `gondolin.apk` package list. The SDK's
  `AssetManifest.buildId` (via `computeAssetBuildId` from asset checksums) is
  *content-derived from the resulting assets*, so it is the authoritative
  "did this exact config produce this dir" check — but our config hash is
  what tells us whether we can *reuse* a dir without rebuilding.
- **Valid cache check** (in `launchDetachedVm` / a new `image.ts`):
  1. `manifest.json` exists in the cache dir.
  2. `manifest.config` round-trips: the stored config hash == current config
     hash.
  3. `verifyAssets(cacheDir)` passes (checksums in the manifest match the
     files on disk).
  If all three hold → use the dir as `imagePath`. Otherwise rebuild
  (build to a temp dir, then atomically swap into place — `buildAssets`
  takes `outputDir` and returns `BuildResult { outputDir, manifestPath,
  manifest }`; we `fs.rename` the temp dir over the cache dir on success).
- **Concurrency:** two concurrent `launchDetachedVm` calls for the same repo
  (main + subagent) must not double-build. A lockfile
  (`<tempdir>/gondolin/<repo-key>/image.lock` with PID + `fs.open` `wx`)
  around the build; losers wait and re-check the cache.

### A.4. Wiring into `launchDetachedVm` / `VM.create`

`launchDetachedVm` in `vm.ts` currently hard-codes:

```ts
sandbox: { imagePath: "./gondolin-sandbox/image-assets" }
```

Change: a small helper `resolveImagePath(config, localCwd, repoKey)` decides:

1. feature enabled + valid cached dedicated dir → `imagePath: <cache dir>`
   (case (a) in the SDK: a directory containing `vmlinuz-virt`,
   `initramfs.cpio.lz4`, `rootfs.ext4` — exactly what `buildAssets` produces);
2. feature enabled + no valid cache → build (per A.3) then use the dir;
3. feature disabled, or build failed and fallback is allowed →
   `"./gondolin-sandbox/image-assets"` (stock, current behavior).

`createSandbox` (main session) goes through the same helper. **Subagents:
yes, they share the repo's dedicated image.** `createSubagentManager` in
`subagents.ts` already calls `launchDetachedVm(..., { isSubagent: true })`,
so no changes are needed there — they automatically get the same
`imagePath` decision. All VMs for a repo share one rootfs image (images are
read-only per VM; per-VM state comes from mounts), so sharing is both cheap
and correct.

### A.5. Host requirements & failure modes

Building requires (per the SDK): a container runtime detectable by
`detectContainerRuntime()` (docker **or** podman) for apk/OCI work, and
network access for apk/OCI pulls.

| Situation | Behavior |
| --- | --- |
| Feature disabled | No build, stock image, zero requirements |
| Feature enabled, `image: "devcontainer"`, stock base (Phase 1) | Build needs network (apk). No container runtime needed for a plain Alpine `buildAssets`. |
| Container runtime absent when needed (e.g. OCI base) | **Clear, actionable error** naming `detectContainerRuntime()`'s result; do *not* silently switch to stock (see below) |
| Build fails (network, apk 404, `postCreateCommand` non-zero exit) | **Recommended: fail hard with the build log surfaced**, and offer a per-repo override `image: "stock"` to force the stock image. Silently falling back to stock is *possible* (it is today's always-true behavior) but recommended **against** as the default, because a broken devcontainer silently degrades the environment the agent was promised. |
| `postCreateCommand` hangs | SDK-level build timeout if available; else the build is killable via the workdir. Open question Q5. |

### A.6. Security

- `postBuild.commands` (from `postCreateCommand`) execute **at build time, on
  the host, with network access, before the VM sandbox is even started**. A
  repo's devcontainer.json is therefore a *build-time trust boundary*: a
  malicious repo could run arbitrary code on the host during the image build.
- Mitigation: the feature is **opt-in per repo** (config in
  `<repo>/.pi/gondolin.json` — the same file the extension already reads —
  or the global `~/.pi/agent/gondolin.json`). Never auto-enable.
- The dedicated image is then a *baked* asset: once built, the image files
  sit on the host and are loaded into VMs. Treat a dedicated cache dir like
  "this repo was allowed to build software on my machine".
- `containerEnv` values are baked into the image; we never put *host secrets*
  in there. Secret handling stays on the existing Gondolin secret hooks
  (`httpHooks`/`env` in `vm.ts`), which is why devcontainer `containerEnv`
  is safe to bake: it is declarative metadata, not host env.

### A.7. Config surface

Extend `GondolinConfig` in `config.ts` (loaded by `loadGondolinConfig`):

```ts
interface GondolinConfig {
  // ... existing: vm, subagent, secrets, scratch
  /**
   * Which image to run the repo's VMs in.
   *  - "stock" (default): ./gondolin-sandbox/image-assets
   *  - "devcontainer": build/reuse a per-repo image from
   *    .devcontainer/devcontainer.json (requires the file to exist)
   *  - "oci:<image>": opt-in OCI base image (Phase 2)
   */
  image?: "stock" | "devcontainer" | `oci:${string}`;
}
```

### A.8. Phasing (Feature A)

See **Proposed Phases** at the end.

### A.9. Testing & rollout (Feature A)

- **Unit:** parser + `BuildConfig` mapping are pure functions
  (`devcontainer.json` → `BuildConfig` + warnings) — fully unit-testable in
  CI with fixture devcontainer.json files (happy path, unknown fields,
  `build`-only, bad JSON, `postCreateCommand` array vs string).
- **Cache logic:** valid/invalid `manifest.json` checks and the
  atomic-swap are testable with fake asset dirs (no real build).
- **Host smoke test:** a real `buildAssets` needs a container runtime +
  network — not available in constrained CI. Provide
  `make image-devcontainer` (Feature B) as the manual smoke test: build one
  fixture repo's image on a dev laptop, boot a VM against it, verify
  `which ripgrep` / env vars.
- **Rollout:** feature-flagged by the `image` config key (default
  `"stock"`), so rollout is per-repo and gradual.

---

## Feature B — setup Makefile for `gondolin-sandbox`

### B.1. Targets

| Target | Purpose |
| --- | --- |
| `help` (default) | Print usage for all targets. |
| `check` | Verify host deps: node ≥ 22 (`node -p process.versions.node`), the platform's gondolin krun runner is installed (`@earendil-works/gondolin-krun-runner-darwin-arm64` or `...-linux-x64`, resolved from `node_modules`), docker **or** podman present (only needed for builds / OCI bases — warn, not fatal, for `check` when no image target is requested), network reachability (best-effort `node -e` fetch to the apk mirror, warn-only). Exits non-zero with a clear message listing what's missing. |
| `image` | Build the **stock** image: run `scripts/build-image.mjs stock` which calls `buildAssets(JSON.parse(image.json), { outputDir: "./gondolin-sandbox/image-assets" })`. Skips if a valid cache exists (B.4). |
| `image-devcontainer [REPO=...]` | Build/refresh the per-repo dedicated image for a repo (thin wrapper over Feature A's `buildDedicatedImage`; lands **after Feature A Phase 1** — until then it prints "requires Feature A"). |
| `install` | Install the extension into pi: `pi install ./gondolin-sandbox` (the package is already shaped as a pi package: `pi.extensions: ["./index.ts"]`, host packages in `peerDependencies`). |
| `test` | Typecheck: `npx tsc --noEmit -p gondolin-sandbox` (a minimal `tsconfig.json` scoped to the extension; pure CI-safe). |
| `clean` | Remove `gondolin-sandbox/image-assets` and per-repo dedicated cache dirs under `<tempdir>/gondolin/*/image`. |
| `all` | `check` + `image` + `test` + `install`. |

### B.2. How Make invokes the build

A small ESM script `gondolin-sandbox/scripts/build-image.mjs` (not a node
one-liner — the skip/verify logic is too much for `make -C ... node -e`):

```js
// scripts/build-image.mjs <stock|devcontainer> [repoCwd]
import { buildAssets, verifyAssets, loadAssetManifest } from "@earendil-works/gondolin";
// 1. load image.json (stock) or compose BuildConfig (devcontainer, Feature A)
// 2. if outputDir/manifest.json exists, verifyAssets() passes, and the
//    config hash matches → print "up to date" and exit 0
// 3. else buildAssets(cfg, { outputDir: tmpdir, verbose: true })
//    → atomic rename over outputDir
// 4. print BuildResult.manifest.buildId
```

`check` detects the krun runner by attempting
`require.resolve("@earendil-works/gondolin-krun-runner-darwin-arm64")` /
`...linux-x64` (selected by `process.platform`/`process.arch`) from within
`gondolin-sandbox/node_modules`, and by running
`detectContainerRuntime()` for docker/podman.

### B.3. Relationship to Feature A

`image-devcontainer` is a **thin wrapper** over Feature A's build path: the
Makefile never reimplements parsing/caching; it calls the same
`buildDedicatedImage(repoCwd, { outputDir })` that `launchDetachedVm` uses,
so the manual build and the on-invocation build share one code path and one
cache. It therefore lands **after Feature A Phase 1**.

### B.4. Idempotence & caching

- `image` / `image-devcontainer` skip the build when: `manifest.json`
  exists in the output dir, `verifyAssets(outputDir)` passes, and the
  stored config hash equals the current `image.json` / devcontainer config
  hash. This makes repeated `make image` cheap and safe.
- Builds always go to a temp dir first and are atomically renamed into
  place, so an interrupted build never leaves a half-written assets dir
  that a later `verifyAssets` could pass.

### B.5. Draft Makefile (appendix)

See [Appendix: draft `gondolin-sandbox/Makefile`](#appendix-draft-makefile).
It is a **starting draft**, to be refined during implementation — notably the
exact `pi install` invocation and the node-version check syntax should be
verified against the real pi CLI on a dev machine.

---

## Open Questions

Decisions needed from the author; recommended defaults in bold.

1. **Q1 — Fallback on dedicated-build failure:** fail hard (surfacing the
   build log) vs silently fall back to the stock image?
   **Recommendation: fail hard, with a per-repo `image: "stock"` override to
   opt out.** Silent fallback hides a broken environment.
2. **Q2 — Default state of the feature:** opt-in per repo (`image:
   "devcontainer"` in `.pi/gondolin.json`) vs auto-enable when a
   devcontainer.json exists?
   **Recommendation: opt-in.** Build-time execution of repo-supplied
   commands is a trust boundary (A.6); auto-enable would make it one by
   default.
3. **Q3 — `containerEnv` in the stock-base (non-OCI) build:** bake via
   `BuildConfig.env` (Phase 1, recommended) — confirm that guest env
   propagation from `BuildConfig.env` works for the alpine distro, since
   the stock `image.json` today has no `env`.
4. **Q4 — Cache location:** per-repo dir under the scratch root
   (`<tempdir>/gondolin/<repo-key>/image`, recommended) vs Gondolin's image
   store (`setImageRef` + `resolveImageSelector`).
   **Recommendation: plain dir** — inspectable, deletable, and directly
   usable as `imagePath`.
5. **Q5 — Build timeout / `postCreateCommand` hang policy:** does the SDK
   expose a build timeout? If not, do we run `buildAssets` with a
   wall-clock watchdog in the extension? **Recommendation: watchdog (e.g.
   15 min) that kills and reports.**
6. **Q6 — `postCreateCommand` form:** devcontainer allows string **or**
   string-array. Accept both (split arrays to `postBuild.commands`), or
   strings only? **Recommendation: accept both.**
7. **Q7 — `image: "oci:<image>"` syntax** vs a separate `ociImage` field on
   the config. **Recommendation: single `image` field with the `oci:`
   prefix** (one knob for "which image").
8. **Q8 — Makefile `install` target:** `pi install ./gondolin-sandbox` —
   confirm the exact local-install verb/flag for pi (path vs package name).
   **Recommendation: `pi install ./gondolin-sandbox`, verify on a dev
   machine.**
9. **Q9 — `check` strictness:** should `make image` *require* `check` to have
   passed (make dependency) vs `check` being standalone?
   **Recommendation: `image` depends on `check`** (build needs the runner +
   network anyway).
10. **Q10 — Phase 2 OCI bases:** pull-only (`pullPolicy: "if-not-present"`)
    vs also allow `pullPolicy: "always"` for cache-busting?
    **Recommendation: `if-not-present` + config-hash invalidation only.**

## Proposed Phases

- [ ] **Phase 1 (Feature A core, stock base):**
  - [ ] devcontainer.json parser → `BuildConfig` mapping + skip-with-warning
        policy (unit-tested with fixtures)
  - [ ] `buildDedicatedImage(repoCwd, { outputDir })` with config-hash cache,
        `verifyAssets` validation, atomic swap, and build lockfile
  - [ ] `GondolinConfig.image` knob; `resolveImagePath()` in `vm.ts`;
        subagents inherit via `launchDetachedVm`
  - [ ] `GondolinConfig` default `"stock"` (feature off by default)
- [ ] **Phase 1.5 (Feature B):** Makefile (`check` / `image` / `test` /
      `install` / `clean` / `help` / `all`) + `scripts/build-image.mjs`;
      `image-devcontainer` target added once Phase 1 lands
- [ ] **Phase 2 (Feature A OCI base):** `image: "oci:<image>"` via
      `BuildConfig.oci`, container-runtime + network checks in `check`,
      opt-in only
- [ ] **Phase 3 (Feature A `features` convention):** `gondolin.apk` key in
      devcontainer.json → extra `rootfsPackages`; document the convention;
      unknown CLI features continue to warn+skip
- [ ] **Rollout:** host smoke test (build fixture repo's image, boot VM,
      verify deps present); document opt-in in `README.md`

## Appendix: draft Makefile

Copy-pasteable starting draft for `gondolin-sandbox/Makefile` (refine during
implementation; see B.5):

```makefile
# gondolin-sandbox/Makefile — draft (see docs/RFC-devcontainer-images-and-makefile.md)

NODE      ?= node
PI        ?= pi
REPO      ?= .          # repo cwd for image-devcontainer
OUTDIR    := ./image-assets

.DEFAULT_GOAL := help

.PHONY: help check image image-devcontainer install test clean all

help: ## Print this usage
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-22s %s\n", $$1, $$2}'

check: ## Verify host deps (node >= 22, krun runner, container runtime, network)
	@$(NODE) -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj < 22) { console.error("node >= 22 required, got " + process.versions.node); process.exit(1); } console.log("node " + process.versions.node + " ok")'
	@$(NODE) -e 'const {detectContainerRuntime}=require("@earendil-works/gondolin"); const r=detectContainerRuntime(); console.log("container runtime:", r ? r : "(none — needed only for builds/OCI bases)")'
	@$(NODE) -e 'const p=require("os").platform(),a=require("os").arch(); const pkg = p==="darwin"&&a==="arm64" ? "@earendil-works/gondolin-krun-runner-darwin-arm64" : "@earendil-works/gondolin-krun-runner-linux-x64"; try { require.resolve(pkg); console.log("krun runner:", pkg, "ok"); } catch { console.error("missing krun runner: " + pkg); process.exit(1); }'

image: check ## Build the stock image from image.json into $(OUTDIR) (skips if up to date)
	@$(NODE) scripts/build-image.mjs stock

image-devcontainer: check ## Build the per-repo dedicated image for $(REPO) (requires Feature A Phase 1)
	@$(NODE) scripts/build-image.mjs devcontainer $(REPO)

install: ## Install the extension into pi
	@$(PI) install ./gondolin-sandbox

test: ## Typecheck the extension
	@npx tsc --noEmit -p gondolin-sandbox

clean: ## Remove built images and per-repo dedicated caches
	@rm -rf $(OUTDIR) "$$(node -e 'console.log(require("os").tmpdir())')/gondolin/*/image"

all: check image test install
```
