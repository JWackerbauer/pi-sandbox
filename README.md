# Gondolin Sandbox — pi extension

Runs pi's agent tools inside a lightweight [Gondolin](https://github.com/obra/gondolin) VM
(aarch64 Alpine guest on macOS), while the pi session itself stays on your host. The agent
believes it is working in its own per-branch workspace (e.g. `/my-branch`); only the
shared git repository is persistent, and the agent works on its own work branch that you
review and merge on the host.

## Quick start

Inside a git repository, start a sandbox build:

```
/build-in-sandbox <what do you want to build?>
```

This:
1. Summarizes your prompt into a kebab-case branch name using the current model.
2. Launches the Gondolin VM and checks out that branch as a git worktree at `/<branch>` in the guest.
3. Renames the session to `gondolin: <branch>` (so it's recognizable in `/resume`).
4. Persists the branch in the session and starts the first agent turn with your prompt.

You can also just start using tools directly — the VM is started lazily on the first tool
call, using the default branch `gondolin-test`.

From the command line, start a normal interactive session that goes straight into the
sandbox (useful for wrapper scripts):

```sh
pi '/build-in-sandbox <what do you want to build?>'
```

## How it works

### The guest

- `image/image.json` defines a basic Alpine image with git, use `npm run build:basic-image` to build it.
- The host's `.git` directory is mounted into the guest at `/source/.git`.
- On launch, the extension writes `src/scripts/prepare.sh` and a `prepare-commit-msg` git hook
  into the guest, then runs `prepare.sh`, which:
  - configures the guest git identity (`GIT_NAME`/`GIT_EMAIL` from `config.ts`),
  - points `core.hooksPath` at the installed hooks,
  - creates the work branch (if it doesn't exist) as a worktree at `/workspace`.
- The `prepare-commit-msg` hook appends a `Co-Authored-By: pi-agent` trailer to commits.

### Tool redirection

`index.ts` re-registers the four built-in tools (`read`, `write`, `edit`, `bash`) with
wrappers that transparently route their file operations into the guest:

- File paths are mapped from the host cwd into the guest workspace `/<branch>`
  (`guest-path.ts`); paths escaping the workspace are rejected.
- `bash` (including user `!` commands) runs as `/bin/bash -lc` **inside the guest**. The
  host environment is deliberately not forwarded — it usually contains API keys. Give the
  guest what it needs via Gondolin's `httpHooks` instead.
- The VM is started lazily: by `/build-in-sandbox` (with the generated branch) or by the
  first tool call that needs it (default branch).

The `before_agent_start` hook rewrites the CWD section of the system prompt so the model
knows it is in `/workspace` on its own branch, that only the git repository is
persistent, and that it must commit to its branch and ask the user to review & merge.

Subagent management instructions are not in the system prompt; they ship as a skill
(`skills/subagents.md`) that pi loads from this package, so they only cost tokens when
the agent loads the skill.

### Sessions

- The guest workspace is `/<branch>`: the host's `.git` is shared by all sandbox
  guests and git identifies worktrees by path, so the path must be unique per branch
  to avoid clobbering other sessions' worktrees.
- The work branch is stored as a custom session entry (`gondolin.sandbox`) — custom
  entries are not sent to the LLM.
- On `session_start` (resume, reload, fork), the extension reads that entry and relaunches
  the sandbox for the same branch, so `pi -c` / `/resume` continues where you left off.
- On `session_shutdown` the VM is closed.

### Branch naming

`branch-name.ts` asks the current model for a short summary of the build request
(thinking off, 32-token budget) and sanitizes the answer into a valid branch name
(lowercase kebab-case, ≤ 40 chars). If the model returns no usable text, it falls back to a
deterministic name derived from the first words of the prompt.

### Subagents

Subagent VMs use smaller sizing by default (see **Configuration** below).

### Skills

The package bundles `skills/subagents.md`, which pi loads as a `subagents` skill.
It contains the subagent management instructions (previously in the system prompt)
and is available to the agent on demand.

### Configuration

The extension reads a `gondolin.json` config from two places: `~/.pi/agent/gondolin.json` (global) and `<repo>/.pi/gondolin.json` (project, overrides global field by field). Missing or invalid files are treated as empty. All fields are optional.

```json
{
  "vm": { "memory": "2G", "cpus": 4 },
  "subagent": { "memory": "512M", "cpus": 1 },
  "secrets": {
    "GH_TOKEN": { "hosts": ["github.com"] }
  },
  "scratch": true,
  "postBuild": {
    "commands": ["apk add ripgrep", "npm install -g pnpm"]
  },
  "postStartup": ["git submodule update --init"]
}
```

- **VM sizing** — `vm` sizes the main session's VM (default `1G` / 2 CPUs); `subagent` sizes subagent VMs, which run in parallel next to the main VM and are smaller by default (`512M` / 1 CPU). Values use the guest runner's native syntax (`memory`: qemu syntax like `"512M"`, `"1G"`; `cpus`: integer).
- **Shared secrets** — `secrets` maps an *environment variable name* to a secret config. At VM launch the value is read from `process.env[name]` on the host and wired into the guest through Gondolin's secret SDK: the guest only ever sees a placeholder (random, or your `placeholder` if set) and requests carrying the secret may only be sent to the listed `hosts`. Entries whose env var is unset are skipped, so no secret value ever lives in a config file. Example: with `GH_TOKEN` set, the guest can authenticate to `github.com` without the token ever appearing in the VM.
- **Scratch mounts** — two host directories are mounted into every guest so files survive VM/session restarts (they live under the host's tempdir, not in the VM's ephemeral disk):
  - `/scratch` — per-repo, shared by every sandbox session of that repo. Host path: `<tempdir>/gondolin/<repo-key>/scratch`.
  - `/scratch-local` — per-repo *and* per-branch, private to the current work branch. Host path: `<tempdir>/gondolin/<repo-key>/<branch>/scratch`.

  `<repo-key>` is the repo's basename (sanitized to `[a-z0-9-]`) plus the first 8 hex chars of the sha256 of its absolute path, so same-named repos in different locations never collide. Set `"scratch": false` to disable both mounts.
- **Custom image (`postBuild`)** — a `postBuild` section is baked into a custom image at startup: the stock `image/image.json` config is rebuilt with the section's `commands` run inside the rootfs after package installation (optionally after `copy` entries copy host files in). Use it to bring in the project's dev dependencies — the rootfs is sized to fit what the commands install, so big toolchains don't have to squeeze into the stock image at boot. The built assets are cached and reused across launches, and rebuilt only when the section (or the stock image config) changes. Build output is captured line by line and rendered as TUI notices. If a build fails, the full log is written to `build.log` inside the assets folder. A project-level `postBuild` builds into the repo's `.pi/assets` (a `.pi/.gitignore` is added for the folder, so the image never lands in git history); a global-only `postBuild` builds into `~/.pi/agent/assets` and is shared by every repo.
- **Post-startup commands (`postStartup`)** — a list of shell commands run in the agent's workspace (`/<branch>`) after the VM has started up and the worktree is ready, in list order. A non-zero exit fails the launch with the command output surfaced. The project list overrides the global list wholesale.

### Subagents

The extension registers two tools that let the agent delegate work to subagents,
each running in its own **detached sandbox session**. How to use them (spawning,
monitoring, aborting, merging branches) is documented in the bundled
`subagents` skill (see [Skills](#skills)):

- `spawn_subagent(prompt)` — same interface as `/build-in-sandbox`: the prompt is
  summarized into a fresh branch name (suffixed `-2`, `-3`, … if the name is taken),
  a detached VM is launched for it with the branch created **from the parent's
  current branch**, and a background pi agent session (SDK, in-memory, no
  extensions/skills) works on the prompt with its four tools routed into the new
  guest. The tool returns as soon as the VM is up — the parent keeps working and
  can spawn more subagents in parallel.
- `subagent_status([id], defer_time?)` — a **non-blocking** check on spawned
  subagents. Returns each subagent's state; for running ones it includes
  elapsed time, last activity, recent tool calls, and heuristics that flag a
  subagent that appears **stuck** (no recent activity) or **looping**
  (repeating the same action). It does *not* block: finished subagents report
  themselves proactively, so this is for monitoring running ones. Passing
  `defer_time` (seconds) schedules the check in the background — the tool
  returns immediately and the status is delivered to the agent as a message
  after the delay, so it can "dispatch a subagent and check on it in 5
  minutes" without blocking the session.
- `subagent_abort(id)` — stop a running subagent by id (e.g. one that
  `subagent_status` flagged as stuck or looping). The subagent's session is
  aborted and its VM and worktree are cleaned up, but its **branch and any
  commits already made are kept** for the parent to review and merge. The
  subagent is recorded as `aborted` (distinct from `failed`), and the usual
  settlement notice follows once cleanup finishes. If the subagent has already
  settled, this is a no-op.

**Proactive delivery:** the agent does not have to poll. When a subagent
finishes, the extension injects its result into the parent session as a custom
message (`gondolin.subagent-result`) that triggers the agent's next turn —
queued as a follow-up if the parent is mid-turn, immediate if idle. If the
agent already fetched that result via `subagent_status`, the notice is
suppressed.

**Deferred status checks:** `subagent_status` with `defer_time` schedules a
background status check; when the timer fires, the extension injects the freshly
computed status into the parent session as a custom message
(`gondolin.subagent-status`) that triggers the agent's next turn. Pending
delayed checks are cancelled on session shutdown.

When a subagent finishes, its worktree is removed and its VM is closed, but the
**branch stays** in the shared repository — that is the persistent artifact.
The parent agent reviews it (`git log` / `git diff`) and merges it into its own
branch with `git merge <branch>` (both branches' refs live in the same shared
`.git`, and merging a branch checked out in another worktree is fine).

Subagent branches are serialized at spawn time (name allocation + worktree
creation), so concurrent spawns cannot collide. On parent session shutdown all
running subagents are aborted and cleaned up.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entry point: registers the command, tools, and session hooks |
| `src/commands/build-in-sandbox.ts` | The `/build-in-sandbox` command |
| `src/vm.ts` | VM lifecycle: detached VM launch, single-VM sandbox wrapper, worktree removal |
| `src/subagents.ts` | Detached subagent sessions: spawn, background SDK agent runs, activity tracking, non-blocking status, shutdown |
| `src/config.ts` | Guest layout, git identity, limits, session entry type, config contract |
| `src/config-loader.ts` | Loads `gondolin.json` (global + project), repo key, secret resolution |
| `src/branch-name.ts` | Prompt → branch name summarizer and sanitizer |
| `src/guest-path.ts` | Host path → guest path mapping |
| `src/ops/` | Gondolin-backed implementations of the read/write/edit/bash tool operations |
| `src/scripts/prepare.sh` | Guest-side git setup, run on VM launch |
| `src/scripts/prepare-commit-msg` | Git hook adding the pi-agent co-author trailer |
| `image/image.json` | Gondolin guest image definition |

## Notes

- The sandbox is **per session**: each pi session runs its own extension instance and its
  own VM, so you can work on multiple branches in parallel across sessions. Launching a
  different branch *within the same session* replaces that session's VM. Subagents are the
  same idea *within* one session: each gets its own detached VM and branch, running in the
  background next to the parent's VM.
- Everything in the guest except the git repository and the scratch mounts (`/scratch`,
  `/scratch-local`) is ephemeral — the agent is told this and must commit its work to its
  branch (subagents too; their branches outlive their VMs).
