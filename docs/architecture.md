# Architecture — how the gondolin sandbox works

This document explains the internals of the extension: the guest, tool redirection,
VM lifecycle, sessions, subagents, scratch mounts, and custom images. The
[README](../README.md) covers day-to-day usage and configuration; this is where the
design decisions live.

## Overview

Each pi session gets its own extension instance and its own Gondolin VM. The VM is an
aarch64 Alpine guest (krun) on macOS. The host's `.git` directory is the single shared,
persistent artifact: every guest mounts it read/write at `/source/.git` and checks out
its work branch as a git worktree at `/<branch>`. The guest workspace is unique per
branch because the host's `.git` is shared by all sandbox guests and git identifies
worktrees by path — two guests with the same workspace path would clobber each other's
worktrees.

```
pi session (host)
└── extension instance (src/index.ts)
    └── GondolinSandbox (src/vm.ts)
        └── detached VM (Gondolin SDK)
            ├── /source/.git  ← host <repo>/.git (RealFSProvider mount)
            ├── /<branch>     ← worktree for this session's work branch
            ├── /scratch, /scratch-local  ← host tempdir mounts
            └── subagent VMs (one per detached subagent session)
```

## The guest

- `image/image.json` defines the stock Alpine image with git. It is not shipped
  prebuilt; `npm run build:basic-image` builds it into `image/assets` (gitignored).
- The host's `.git` directory is mounted into the guest at `/source/.git`.
- On launch (`launchDetachedVm` in `src/vm.ts`), the extension writes
  `src/scripts/prepare.sh` and a `prepare-commit-msg` git hook into the guest, then
  runs `prepare.sh`, which:
  - configures the guest git identity (`GIT_NAME`/`GIT_EMAIL` from `src/config.ts`),
  - marks `.git` and the workspace as safe directories,
  - points `core.hooksPath` at the installed hooks,
  - creates the work branch (if it doesn't exist) as a worktree at `/workspace`
    (the per-branch guest path `/<branch>`), optionally from a start ref
    (`WORK_BRANCH_START`, used by subagents to branch off the parent's branch).
- The `prepare-commit-msg` hook appends a `Co-Authored-By: pi-agent` trailer to
  commits, so agent commits are attributable.
- If a stale worktree registration for the exact workspace path exists (left by a
  session that crashed before its shutdown cleanup ran), `prepare.sh` detects it and
  tells the user to `git worktree prune` (or remove just that worktree) on the host.

## Tool redirection

`src/index.ts` re-registers the four built-in tools (`read`, `write`, `edit`, `bash`)
with wrappers that route their file operations into the guest (implementations in
`src/ops/`):

- **Path mapping** — `src/guest-path.ts` maps host-local paths (relative, or absolute
  under the host repo root) into the guest workspace `/<branch>`. Absolute guest paths
  are normalized and containment-rechecked. Paths escaping the workspace are rejected.
- **Bash** — `bash` (including user `!` commands, via the `user_bash` hook) runs as
  `/bin/bash -lc` **inside the guest**. The host environment is deliberately not
  forwarded — it usually contains API keys. Give the guest what it needs via Gondolin's
  `httpHooks` instead (see [Configuration](../README.md#configuration--gondolinjson)):
  `createHttpHooks` wires the configured `secrets` in, and `env` entries are merged
  under the secret placeholders so a plain env value can never shadow a secret's
  guest-visible placeholder.
- **Lazy start** — each wrapped tool calls `sandbox.ensureVm()` first. If the VM is
  already up it is returned; if a launch is in flight (e.g. started by
  `/build-in-sandbox` in parallel with the first turn) `ensureVm()` awaits that
  in-flight launch; only if nothing is running does it launch the default branch
  `gondolin-test`. This is what lets the first turn stream its response while the VM
  boots — a tool call blocks on the VM exactly as long as necessary.

The `before_agent_start` hook rewrites the CWD section of the system prompt so the
model knows it is in `/<branch>` on its own branch, that only the git repository is
persistent, that it must commit its work to its branch and ask the user to review &
merge — and, when enabled, that the sandbox is in development mode (`developMode`) and
that the scratch mounts exist and what they are for (the prompt only advertises the
scratch mounts when they are actually mounted, i.e. `scratch` is not `false`). It does
**not** await the VM: the branch is known as soon as the launch starts, so the first
model call can begin while the VM is still booting.

Subagent management instructions are not in the system prompt; they ship as a skill
(`skills/subagents.md`) that pi loads from this package, so they only cost tokens when
the agent loads the skill.

## VM lifecycle

- `createSandbox` (`src/vm.ts`) is a single-VM wrapper: `launch(branch)` returns the
  running VM if it is already for that branch, otherwise closes any other VM and
  launches a fresh one; concurrent launches of the same branch share one in-flight
  promise. The branch is recorded as soon as a launch starts (so the CWD section and
  other readers see it while the VM boots). `ensureVm()` returns the running VM if any,
  otherwise awaits an in-flight launch, and only launches the default branch if nothing
  is running.
- `launchDetachedVm` is independent of the wrapper, so several VMs can run at the same
  time (one per branch/worktree) — this is what subagents use.
- On a failed launch the half-configured VM is closed so a retry starts clean.
- On `session_shutdown` the extension (1) aborts all running subagents first (each
  cleans up its own worktree and VM while the guests are still up), (2) removes this
  session's worktree **in the guest** (`git worktree remove --force` against the exact
  path, so other sessions' worktrees are untouched; `--force` is fine because the
  branch's commits already live in the shared `.git`), and (3) closes the VM. A crash
  before this runs leaves a stale registration, which `prepare.sh` detects on the next
  start (see [The guest](#the-guest)).
- The status bar shows `gondolin: <state>` / `gondolin: <branch>` plus the number of
  running subagents, refreshed on launch, shutdown, and subagent state changes.

## Sessions

- The guest workspace is `/<branch>` (see [Overview](#overview) for why it must be
  unique per branch).
- The work branch is stored as a custom session entry (`gondolin.sandbox`) — custom
  entries are not sent to the LLM.
- On `session_start` (resume, reload, fork), the extension finds the most recent
  sandbox entry in the session branch and relaunches the VM for the same branch, so
  `pi -c` / `/resume` continues where you left off. The session is renamed
  `gondolin: <branch>` so it is recognizable in `/resume` (the name is cosmetic; the
  branch is what is persisted).
- On `session_shutdown` the VM is closed (see [VM lifecycle](#vm-lifecycle)).

## Branch naming

`src/branch-name.ts` asks the current model for a short summary of the build request
(thinking off — no `reasoning` option, so the whole 32-token budget is available for
the answer) and sanitizes the result into a valid branch name (lowercase kebab-case,
≤ 40 chars). If the model returns no usable text, it falls back to a deterministic
name derived from the first words of the prompt. Taken names are suffixed `-2`, `-3`,
… (trimming the stem to stay within the length limit).

## Subagents

Each subagent is a **detached sandbox session**: a new branch (created from the
parent's current branch at spawn time), its own detached VM, and a background pi agent
session running in the SDK:

- The subagent session is **in-memory** (no session file) and created with
  `noExtensions` / `noSkills` / `noPromptTemplates` / `noThemes` / `noContextFiles` —
  so the parent's gondolin extension is not loaded twice — and the four built-in
  tools are re-created with operations routed into the subagent's guest.
- **Sizing:** subagent VMs use the `subagent` config sizing (default `512M` / 1 CPU)
  because they run in parallel next to the main VM.
- **Spawn serialization:** name allocation + worktree creation are serialized at spawn
  time, so concurrent spawns cannot collide.
- **Activity tracking:** the manager subscribes to the subagent session's event
  stream (push, no polling) to record recent tool calls. `subagent_status` uses this
  to flag a running subagent that appears **stuck** (no activity for ~2 min) or
  **looping** (repeating the same tool call — a window of 3 identical recent calls
  against 5 retained fingerprints, see `SUBAGENT_*` in `src/config.ts`).
- **Proactive delivery:** when a subagent settles (finished, failed, aborted), the
  extension injects its result into the parent session as a custom message
  (`gondolin.subagent-result`) that triggers the agent's next turn — queued as a
  follow-up if the parent is mid-turn, immediate if idle. If the agent already fetched
  that result via `subagent_status`, the notice is suppressed.
- **Deferred status checks:** `subagent_status` with `defer_time` schedules a
  background check; when it fires, the freshly computed status is injected as a
  custom message (`gondolin.subagent-status`) that triggers the agent's next turn.
  Pending delayed checks are cancelled on session shutdown.
- **Aborting:** `subagent_abort(id)` is synchronous in that it settles the record;
  the actual stop (aborting the in-flight run) plus cleanup (VM + worktree) happens in
  the background, confirmed by the settlement notice. The branch and any commits
  already made are kept for the parent to review and merge. Aborting an already-settled
  subagent is a no-op that reports its final state.
- **Settlement:** when a subagent finishes, its worktree is removed and its VM closed,
  but the **branch stays** in the shared repository — that is the persistent artifact.
  The parent reviews it (`git log` / `git diff`) and merges it into its own branch
  with `git merge <branch>` (both branches' refs live in the same shared `.git`, and
  merging a branch checked out in another worktree is fine).
- **Parent shutdown:** on `session_shutdown` all running subagents are aborted and
  cleaned up before the parent's own worktree removal and VM close.

## Scratch mounts

Two host directories are mounted into every guest so files survive VM/session
restarts (they live under the host's tempdir, not in the VM's ephemeral disk):

- `/scratch` — per-repo, shared by every sandbox session of that repo.
  Host: `<tempdir>/gondolin/<repo-key>/scratch`.
- `/scratch-local` — per-repo and per-branch, private to the current work branch.
  Host: `<tempdir>/gondolin/<repo-key>/<branch>/scratch`.

`<repo-key>` is the repo's basename (sanitized to `[a-z0-9-]`) plus the first 8 hex
chars of the sha256 of its resolved absolute path, so same-named repos in different
locations never collide. The host directories are created (`mkdir -p`) before the VM
starts, since `RealFSProvider` mounts a real host path that must exist. Both mounts
can be disabled with `"scratch": false`.

## Custom images (`postBuild`)

When the config carries a `postBuild` section, `src/image.ts` builds a custom image
from the stock `image/image.json` config plus that section, instead of using the
stock image:

- **Cache:** the build is keyed by a sha256 over the `postBuild` section and the stock
  image config, recorded in `.gondolin-postbuild` in the assets dir. A cached build is
  reused while the key matches and the asset manifest verifies; otherwise the assets
  are cleared and rebuilt.
- **Location:** a project-level `postBuild` builds into `<repo>/.pi/assets` (with a
  `.pi/.gitignore` adding `assets/`, so the image never lands in git history); a
  global-only `postBuild` builds into `~/.pi/agent/assets` and is shared by every
  repo.
- **Concurrency:** an in-process build lock means racing launches (e.g. a main VM and
  a subagent starting at the same time) share one build per assets dir.
- **Logs:** the SDK writes straight to `process.stderr` in verbose mode; the build
  intercepts `stderr.write`, splits it into lines, and forwards each to the TUI as a
  notice. On failure the captured log is written to `build.log` in the assets folder
  and the path is appended to the error message.
- **Containers:** off-Linux the `postBuild.commands` step must run inside a container
  (the aarch64 rootfs's shell can't be executed natively on macOS). A running
  Docker or Podman daemon is detected up front (`docker info` / `podman info`
  distinguish installed from ready) and a clear error is raised if none is found. On
  macOS the build's tmpdir is steered under the home directory so Docker Desktop
  shares it (the default tmpdir lives in `/var/folders/…`, which it does not). The
  stock image (no `postBuild`) always builds natively and needs no container.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entry point: registers the command, tools, and session hooks |
| `src/commands/build-in-sandbox.ts` | The `/build-in-sandbox` command |
| `src/vm.ts` | VM lifecycle: detached VM launch, single-VM sandbox wrapper, worktree removal, post-startup commands |
| `src/subagents.ts` | Detached subagent sessions: spawn, background SDK agent runs, activity tracking, non-blocking status, shutdown |
| `src/config.ts` | Guest layout, git identity, limits, session entry type, config contract |
| `src/config-loader.ts` | Loads `gondolin.json` (global + project), repo key, secret resolution, postBuild resolution |
| `src/image.ts` | Stock vs. custom image assets: build, cache, log capture, container detection |
| `src/branch-name.ts` | Prompt → branch name summarizer and sanitizer |
| `src/guest-path.ts` | Host path → guest path mapping |
| `src/ops/` | Gondolin-backed implementations of the read/write/edit/bash tool operations |
| `src/scripts/prepare.sh` | Guest-side git setup, run on VM launch |
| `src/scripts/prepare-commit-msg` | Git hook adding the pi-agent co-author trailer |
| `skills/subagents.md` | Bundled subagent usage skill |
| `image/image.json` | Gondolin guest image definition (stock image) |
