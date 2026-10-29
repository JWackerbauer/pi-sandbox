# Configuration Reference

```json
{
  "vm": { "memory": "2G", "cpus": 4 },
  "subagent": { "memory": "512M", "cpus": 1 },
  "rootfs": { "extra": "10G" },
  "env": { "NODE_ENV": "development" },
  "secrets": {
    "GH_TOKEN": { "hosts": ["github.com"] }
  },
  "github": [
    { "host": "github.com", "magicDir": true, "ghCliToken": "GH_TOKEN" },
    { "host": "myorg.ghe.com", "ghCliToken": "MYORG_GHE_TOKEN" }
  ],
  "scratch": true,
  "git": { "name": "Jan Wackerbauer", "email": "jan.wackerbauer@gmail.com" },
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
- **`rootfs` — extra root disk space.** The guest's root disk is grown to the image's
  own size plus `rootfs.extra` (a qemu disk size like `"5G"`, `"20G"`, default `"10G"`)
  at every launch, so the agent always gets the configured amount of additional disk
  space — even for a large `postBuild` image. It applies to every VM (main and
  subagent). The root disk is a thin-provisioned qcow2 overlay, so the extra space
  costs nothing on the host until it is actually written. Merged per field.
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
- **`git` — commit identity.** The name/email used for commits made inside the
  guest. Each field is optional: when set it overrides the corresponding value from
  the host's effective git config (the repo's local config, then `~/.gitconfig`);
  when unset the host's value is used, and if the host has no value for a field a
  neutral fallback (`pi-agent` / `pi-agent@localhost`, matching the co-author
  identity) is used. Merged per
  field, so a project config can override just `git.name` while inheriting
  `git.email`. Resolved at every VM launch, so a change to the host git config is
  picked up on the next launch without restarting pi.
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