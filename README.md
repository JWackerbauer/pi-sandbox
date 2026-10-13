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

You can also just start pi normally: in a regular session the tools behave
exactly as stock pi (the sandbox-specific behavior is inert until
`/build-in-sandbox` is run or a sandbox session is resumed). The extension
registers its tools and skills at session start, so the system prompt is
built once and never modified mid-session.

From the command line, start a normal interactive session that goes straight into the
sandbox (useful for wrapper scripts):

```sh
pi '/build-in-sandbox <what do you want to build?>'
```

## Day-to-day

- The status bar shows `gondolin: <branch>` while the sandbox runs, plus the number of
  running subagents.
- The agent commits to its own branch (commits can carry a `Co-Authored-By: pi-agent`
  trailer — opt-in, set `"coAuthor": true` in your `gondolin.json` to add it). You
  review and merge on the host: `git log` / `git diff`, then `git merge <branch>`.
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
the tool call blocks on the in-flight launch (`requireVm` in `vm.ts`) and the agent loop
continues as soon as the VM is ready. A launch failure is surfaced as a notice even if the
turn never calls a tool.

To keep the concurrent startup from feeling jarring, the VM's boot logs are kept out
of the transcript: while the VM launches, a widget above the editor (next to the
"Working" spinner) shows an animated spinner, the branch name, and the latest boot log
line. It is cleared the moment the VM is ready, leaving a single "Gondolin VM ready"
line in the transcript — so the startup logs never mix with the first turn's output.

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
load time each `.md` file is written as a **stub** — its real (static, config-
independent) front matter plus a placeholder body — into a per-process host temp dir,
which the extension serves via `resources_discover`. When the sandbox is entered the
real bodies are rendered in place (same paths) with a context derived from the
effective config. This keeps environment-specific info (which hosts are
reachable, which secrets are wired in, which features are on) out of the system
prompt and into on-demand skill content — and because pi discovers skills only at
session start and re-reads a skill's body from disk on demand, the stub → real-body
swap never touches the system prompt.

The rendered files live **on the host only**, on purpose: pi's skill loader reads
the front matter on the host, and when the agent checks a skill it issues a plain
`read` tool call on the listed path — which the wrapped `read` tool intercepts and
serves from the host. The same interception covers **global skills**
(`~/.pi/agent/skills`, `~/.agents/skills`): they live outside the repo root, so they
would fail the guest's workspace containment check; the agent reads them from the
host instead. **Repo-local skills** (`<repo>/.pi/skills`, `<repo>/.agents/skills`)
need no interception: their host paths map into the guest worktree, which contains
the tracked repo files. The sandbox worktree is never touched by gondolin itself,
so there is no risk of colliding with repo-local files under `.pi/`. Skills are
read-only from the agent's view: writes and edits to the host-served dirs are
rejected by the workspace containment check.

The available template variables are:

- `{{github_hosts}}` — every host the sandbox can reach: the union of the
  `secrets[*].hosts` entries, the `magicDir` hosts, and the `ghCliToken` hosts
  (e.g. `"github.com"`).
- `{{magic_hosts}}` — the hosts with a magic dir enabled.
- `{{gh_cli_hosts}}` — the hosts with the `gh` CLI installed in the guest.
- `{{secrets}}` — the names of the configured secrets.
- `{{scratch}}` — boolean; whether the scratch mounts are enabled.
- `{{developMode}}` — boolean; whether the sandbox is in development mode.

Sections (`{{#name}} … {{/name}}` when truthy, `{{^name}} … {{/name}}` when falsy) let a
template show or hide whole blocks based on the config, e.g. the `sandbox` skill lists
reachable hosts only when any are configured, and the `github` skill shows the magic-dir
and `gh` CLI sections only when each is enabled.

### The bundled `github` skill

The package also ships `skills/github.md`, which pi loads as a `github` skill: how to
use the `/git` magic dir and the `gh` CLI to access the configured GitHub hosts. Only
relevant when the `github` config is present (see below).

### The sandbox preamble

Entering the sandbox does **not** modify the system prompt — a modified system prompt
invalidates the inference prefix cache. Instead, the extension sends a **preamble**: a
non-display custom message (invisible in the UI, distinct from your prompt in the
conversation) that is attached ahead of the first sandbox turn's user prompt. It tells
the agent that the parameters of its ongoing session have changed — new working
directory `/<branch>`, branch rules, persistence — and lists the skills to check for
further information. It is rendered from `templates/preamble.md` (same template
tags) with the work branch, the guest workspace, and the list of available skills,
and is sent when `/build-in-sandbox` starts, and on `session_start` when a
sandbox session is resumed, reloaded, or forked.

### Configuration — `gondolin.json`

The extension reads a `gondolin.json` from two places: `~/.pi/agent/gondolin.json`
(global) and `<repo>/.pi/gondolin.json` (project). The project config overrides the
global one — sizing, `secrets`/`env` (per key) and `github` (by host) merge field by
field, so a project can override just `vm.memory` while inheriting `vm.cpus`, or add a
host; `postStartup` and `postBuild` replace the global value wholesale. Missing or
invalid files are treated as empty. All fields are optional. A JSON Schema for the
file is provided in [`gondolin.schema.json`](gondolin.schema.json) — reference it via
`"$schema": "https://raw.githubusercontent.com/JWackerbauer/pi-sandbox/main/gondolin.schema.json"`
for editor autocompletion and validation.

```json
{
  "vm": { "memory": "2G", "cpus": 4 },
  "subagent": { "memory": "512M", "cpus": 1 },
  "env": { "NODE_ENV": "development" },
  "secrets": {
    "GH_TOKEN": { "hosts": ["github.com"] }
  },
  "github": [
    { "host": "github.com", "magicDir": true, "ghCliToken": "GH_TOKEN" },
    { "host": "myorg.ghe.com", "ghCliToken": "MYORG_GHE_TOKEN" }
  ],
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
- **`env` — environment variables.** A map of name → string value, set inside the guest
  VM and visible to every process the agent runs. Merged per key with the global map, so
  a project config can override a single variable while inheriting the rest. These are
  plain values that live in the guest environment unencrypted — don't put secrets here
  (use `secrets` for those); a key that collides with a `secrets` entry keeps the
  secret's placeholder value.
- **`secrets` — shared secrets.** Maps a *name* to a secret config. At VM launch the
  value is taken from the entry's `value` field if present, otherwise from the host
  environment variable named by the key, and wired into the guest through Gondolin's
  secret SDK: the guest only ever sees a placeholder (random, or your `placeholder` if
  set), and requests carrying the secret may only be sent to the listed `hosts`.
  Entries with no value in either source are skipped. Prefer the env var — the config
  file is a less secret place to live. Example: with `GH_TOKEN` set, the guest can
  authenticate to `github.com` without the token ever appearing in the VM.
- **`github` — GitHub hosts.** An opt-in list of GitHub hosts (`github.com` and/or
  GitHub Enterprise hosts like `myorg.ghe.com`), merged by host across global and
  project. Each entry enables one or both of two independent features:
  - **`"magicDir": true`** — exposes the host's repos as a read-only, lazily-cloned
    tree under `/git/<host>/<owner>/<repo>` (clones are cached on the host and reused
    across restarts). This is **host-side**: it uses the host machine's own `gh`
    authentication, so all you need is `gh auth login` on the host (with `GH_HOST=<host>`
    for GHE) — no token in the config, and the agent never sees one. Launch fails with
    an actionable message if the host's `gh` is missing or unauthenticated for that
    host.
  - **`ghCliToken`** — installs the `gh` CLI for the host inside the guest. The token
    is either a literal token value or the name of a host environment variable that
    holds it (a set env var takes precedence; an entry whose name looks like an env
    var that is *not* set is skipped, so a non-exported shell variable fails at the
    config level instead of as a 401 deep in the guest). The token is passed to the
    guest as a Gondolin secret with egress restricted to that host and `api.<host>`
    (the GitHub API hostname): the guest only ever sees the secret's placeholder (in
    the generated `~/.config/gh/hosts.yml` and an env var), and the http hooks
    substitute the real token at egress. How the agent uses `gh` and the magic dir is
    documented in the bundled `github` skill (see [above](#the-bundled-github-skill)).
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
  prepare-commit-msg git hook installed at VM launch). Default `false`; set
  `"coAuthor": true` to enable it.
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
lifecycle, sessions, subagent internals, GitHub access — see
[docs/architecture.md](docs/architecture.md).

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
