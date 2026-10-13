# Gondolin Sandbox — pi extension

Runs pi's agent tools inside a lightweight [Gondolin](https://github.com/obra/gondolin) VM
(aarch64 Alpine guest on macOS), while the pi session itself stays on your host. The agent
believes it is working in its own per-branch workspace (e.g. `/my-branch`); only the
shared git repository is persistent, and the agent works on its own work branch that you
review and merge on the host.

## Quick start

One time, build the stock guest image (it is not shipped prebuilt):

```sh
npm run build:basic-image
```

Inside a git repository, start a sandbox build:

```
/build-in-sandbox <what do you want to build?>
```

This:
1. Summarizes your prompt into a kebab-case branch name using the current model.
2. Renames the session to `gondolin: <branch>` (so it's recognizable in `/resume`) and
   persists the branch in the session.
3. Launches the Gondolin VM (which checks out that branch as a git worktree at
   `/<branch>` in the guest) **and starts the first agent turn concurrently** — see
   [Concurrent startup](#concurrent-startup).

You can also just start using tools directly — the VM is started lazily on the first tool
call, using the default branch `gondolin-test`.

From the command line, start a normal interactive session that goes straight into the
sandbox (useful for wrapper scripts):

```sh
pi '/build-in-sandbox <what do you want to build?>'
```

## Day-to-day

- The status bar shows `gondolin: <branch>` while the sandbox runs, plus the number of
  running subagents.
- The agent commits to its own branch (commits carry a `Co-Authored-By: pi-agent`
  trailer, enabled by default — set `"coAuthor": false` in your `gondolin.json`
  to stop adding it). You review and merge on the host: `git log` / `git diff`,
  then `git merge <branch>`.
- Your user `!` bash commands run inside the guest too, so what the agent sees is what
  you see.
- The workspace is ephemeral, but two scratch directories persist across VM restarts:
  `/scratch` (shared by every session of this repo) and `/scratch-local` (private to the
  current branch). Use them for caches and build outputs, not permanent storage.
- Resuming a sandbox session (`/resume`, `pi -c`) relaunches the VM for the same branch,
  so you pick up where you left off. When the session ends, its worktree is removed and
  the VM is closed — the branch, with its commits, is what stays.
- Each pi session runs its own VM, so you can work on several branches in parallel across
  sessions. Launching a different branch *within the same session* replaces that
  session's VM.

## Features & configuration

### Concurrent startup

VM startup is the slow part of `/build-in-sandbox`. The extension therefore starts the
first turn and the VM launch **concurrently** — they have no dependency on one another.
The model can stream its first response while the VM boots; when the turn needs a tool,
the tool call blocks on the in-flight launch (`ensureVm` in `vm.ts`) and the agent loop
continues as soon as the VM is ready. A launch failure is surfaced as a notice even if the
turn never calls a tool.

### Subagents

The agent can delegate work to subagents, each running in its own **detached sandbox
session** (its own VM and work branch, created from the parent's current branch). The
bundled `subagents` skill (see below) teaches the agent how to use the three tools:

- `spawn_subagent(prompt)` — summarize the prompt into a fresh branch name (suffixed
  `-2`, `-3`, … if taken), launch a detached VM for it, and run a background pi agent
  session on the task. Returns as soon as the VM is up, so the parent keeps working and
  can spawn more subagents in parallel.
- `subagent_status([id], defer_time?)` — a **non-blocking** check. For running subagents
  it reports elapsed time, last activity, recent tool calls, and flags ones that appear
  **stuck** or **looping**. Pass `defer_time` (seconds) to schedule the check in the
  background — the status arrives as a message after the delay.
- `subagent_abort(id)` — stop a running subagent (e.g. one flagged as stuck). Its VM and
  worktree are cleaned up, but **its branch and any commits already made are kept** for
  review and merge.

When a subagent finishes, its result (summary and commits) is delivered to the parent
**proactively** as a message that triggers the agent's next turn — the agent does not
have to poll. On parent shutdown, all running subagents are aborted and cleaned up;
their branches outlive their VMs. See
[docs/architecture.md](docs/architecture.md#subagents) for how detached sessions work.

### The bundled `subagents` skill

The package ships `skills/subagents.md`, which pi loads as a `subagents` skill: the
subagent usage guide (spawning, monitoring, aborting, merging) as on-demand skill
content instead of permanent system prompt, so it only costs tokens when the agent
loads it.

### Skills as templates

The package's `skills/` directory holds skill **templates**, not finished skills. At
load time each `.md` file is rendered with a context derived from the effective
config into the repo's `.pi/skills/gondolin` directory, which the extension serves via
`resources_discover`. This keeps environment-specific info (which hosts are
reachable, which secrets are wired in, which features are on) out of the system prompt
and into on-demand skill content instead.

The rendered files live **in the repo**, not in a temp dir, on purpose: pi's skill
loader reads them on the host, while the agent reads them from inside the sandbox —
so the skill paths listed in the prompt are host repo paths that map into the guest
workspace (`.pi/skills/gondolin` in the worktree), where the files are copied at VM
launch. `.pi/` is added to `.git/info/exclude` so the rendered files never show up in
git status.

The available template variables are:

- `{{github_hosts}}` — the union of every `secrets[*].hosts` entry (e.g. `"github.com"`).
- `{{secrets}}` — the names of the configured secrets.
- `{{scratch}}` — boolean; whether the scratch mounts are enabled.
- `{{developMode}}` — boolean; whether the sandbox is in development mode.

Sections (`{{#name}} … {{/name}}` when truthy, `{{^name}} … {{/name}}` when falsy) let a
template show or hide whole blocks based on the config, e.g. the `sandbox` skill lists
reachable hosts only when any are configured.

### The sandbox preamble

Entering the sandbox does **not** modify the system prompt — a modified system prompt
invalidates the inference prefix cache. Instead, the extension sends a **preamble**: a
non-display custom message (invisible in the UI, distinct from your prompt in the
conversation) that is attached ahead of the first sandbox turn's user prompt. It tells
the agent that the parameters of its ongoing session have changed — new working
directory `/<branch>`, branch rules, persistence — and lists the skills to check for
further information. It is rendered from `templates/preamble.md` (same template
tags) with the work branch, the guest workspace, and the list of available skills,
and is sent when `/build-in-sandbox` starts, when a sandbox session is resumed or
reloaded, and when a tool lazily launches the VM.

### Configuration — `gondolin.json`

The extension reads a `gondolin.json` from two places: `~/.pi/agent/gondolin.json`
(global) and `<repo>/.pi/gondolin.json` (project). The project config overrides the
global one — sizing and `secrets`/`env` merge field by field, so a project can override
just `vm.memory` while inheriting `vm.cpus`; `postStartup` and `postBuild` replace the
global value wholesale. Missing or invalid files are treated as empty. All fields are
optional:

```json
{
  "vm": { "memory": "2G", "cpus": 4 },
  "subagent": { "memory": "512M", "cpus": 1 },
  "env": { "NODE_ENV": "development" },
  "secrets": {
    "GH_TOKEN": { "hosts": ["github.com"] }
  },
  "scratch": true,
  "developMode": false,
  "coAuthor": true,
  "postStartup": ["git submodule update --init"],
  "postBuild": {
    "copy": [{ "src": "./tool-config", "dest": "/opt/tool-config" }],
    "commands": ["apk add ripgrep", "npm install -g pnpm"]
  }
}
```

- **`vm` / `subagent` — VM sizing.** `vm` sizes the main session's VM (default `1G` /
  2 CPUs); `subagent` sizes subagent VMs, which run in parallel next to the main VM and
  are smaller by default (`512M` / 1 CPU). Values use the guest runner's native syntax
  (`memory`: qemu syntax like `"512M"`, `"1G"`; `cpus`: integer).
- **`secrets` — shared secrets.** Maps a *name* to a secret config. At VM launch the
  value is taken from the entry's `value` field if present, otherwise from the host
  environment variable named by the key, and wired into the guest through Gondolin's
  secret SDK: the guest only ever sees a placeholder (random, or your `placeholder` if
  set), and requests carrying the secret may only be sent to the listed `hosts`.
  Entries with no value in either source are skipped. Prefer the env var — the config
  file is a less secret place to live. Example: with `GH_TOKEN` set, the guest can
  authenticate to `github.com` without the token ever appearing in the VM.
- **`env` — environment variables.** A map of name → string value, set inside the guest
  VM and visible to every process the agent runs. Merged per key with the global map, so
  a project config can override a single variable while inheriting the rest. These are
  plain values that live in the guest environment unencrypted — don't put secrets here
  (use `secrets` for those); a key that collides with a `secrets` entry keeps the
  secret's placeholder value.
- **`.env` — host environment file.** At startup the extension loads a host
  `<repo>/.env` into the host's `process.env`, so its values are available for secret
  resolution (a `secrets` entry with no `value` field falls back to the env var named by
  the key). Existing environment variables are **not** overridden — the real environment
  always wins over the file. Missing or unreadable files are ignored.
- **`scratch` — scratch mounts.** Two host directories are mounted into every guest so
  files survive VM/session restarts (they live under the host's tempdir, not in the
  VM's ephemeral disk):
  - `/scratch` — per-repo, shared by every sandbox session of that repo.
  - `/scratch-local` — per-repo *and* per-branch, private to the current work branch.

  Set `"scratch": false` to disable both mounts.
- **`developMode` — development feedback.** When `true`, the agent is told the sandbox
  is under development and asked to report any issues it had with the sandbox once it
  is done working. Default `false`.
- **`coAuthor` — pi-agent co-author attribution.** When `true`, commits made inside the
  guest carry a `Co-Authored-By: pi-agent <pi-agent@localhost>` trailer (added by a
  prepare-commit-msg git hook installed at VM launch). Default `true`; set
  `"coAuthor": false` to disable it.
- **`postBuild` — custom image.** Baked into a custom image at startup: the stock
  `image/image.json` config is rebuilt with the section's `commands` run inside the
  rootfs after package installation (optionally after `copy` entries copy host files
  in). Use it to bring in the project's dev dependencies — the rootfs is sized to fit
  what the commands install, so big toolchains don't have to squeeze into the stock
  image at boot. Built assets are cached and reused across launches, and rebuilt only
  when the section (or the stock image config) changes. Build output is rendered as TUI
  notices; a failed build writes the full log to `build.log` in the assets folder. A
  project-level `postBuild` builds into the repo's `.pi/assets` (a `.pi/.gitignore` is
  added, so the image never lands in git history); a global-only `postBuild` builds
  into `~/.pi/agent/assets` and is shared by every repo.
  - **macOS note:** off-Linux, the `postBuild.commands` step runs inside a container
    (the aarch64 rootfs's shell can't be executed natively on macOS), so a running
    **Docker** or **Podman** daemon is required. The extension checks for one up front
    and fails with a clear message if it's missing. The stock image (no `postBuild`)
    always builds natively and needs no container.
- **`postStartup` — post-startup commands.** A list of shell commands run in the agent's
  workspace (`/<branch>`) after the VM has started and the worktree is ready, in list
  order. A non-zero exit fails the launch with the command output surfaced. A single
  command may also be given as a bare string; other shapes are ignored.

For the design details behind all of this — guest setup, tool redirection, VM
lifecycle, sessions, subagent internals — see [docs/architecture.md](docs/architecture.md).

## Notes

- Everything in the guest except the git repository and the scratch mounts (`/scratch`,
  `/scratch-local`) is ephemeral — the agent is told this and must commit its work to
  its branch (subagents too; their branches outlive their VMs).

## See also

- [docs/architecture.md](docs/architecture.md) — how it works: guest setup, tool
  redirection, VM lifecycle, sessions, subagents, images
- [skills/subagents.md](skills/subagents.md) — the bundled subagent usage skill
- [skills/sandbox.md](skills/sandbox.md) — the sandbox skill template (rendered with
  the config at load time)
- [docs/RFC-devcontainer-images-and-makefile.md](docs/RFC-devcontainer-images-and-makefile.md) —
  deferred feature proposals
