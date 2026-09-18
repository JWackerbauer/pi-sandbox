# Pi Sandbox

A minimal Docker sandbox for the [pi](https://github.com/Earendil-Works/pi-coding-agent) coding agent.

> [!CAUTION]
> ## Sandbox Security
>
>
> The sandbox runs as a **non-root** user with dropped capabilities and a `no-new-privileges` flag, but it is **not** a hardened container. Please keep the following in mind:
>
>
>
> - **The agent has full read/write access** to the mounted working directory — it can create, modify, and delete any files there. Always use git so you can roll back.
>
> - **Do not place secrets** (API keys, credentials, tokens) in the mounted directory. The agent can read them.
>
> - **Pi config files are mounted read-write** (`settings.json`, `models.json`, `trust.json`, `auth.json`, `sessions/`). The agent can modify these, which may affect your host-side pi configuration.
>
> - **Network access is unrestricted.** The agent can make outbound HTTP requests, install npm packages, and run `brew install`. Treat it as if it has full internet access.
>
> - **Resource limits:** 2 GB memory, 200 PIDs. Long-running or resource-intensive tasks may be killed.

## Building

```bash
docker build -t pi-sandbox .
```

## Running

```bash
# Simple usage (uses current directory)
./run-sandbox.sh

# With forwarded ports
./run-sandbox.sh --port 3000:3000,5173:5173

# With a specific directory
./run-sandbox.sh --dir /path/to/project --port 3000:3000

# Clean sandbox: no host directory mounted, agent works in /workspace
./run-sandbox.sh --nomount
./run-sandbox.sh -n

# With credentials for the GitHub / Azure DevOps CLIs
./run-sandbox.sh --env GH_TOKEN=<token> --env AZURE_DEVOPS_PAT=<pat> --env AZURE_DEVOPS_ORG_URL=<org-url>

# For help
./run-sandbox.sh --help
```

`--nomount` (or `-n`) skips the host directory mount and gives the agent a clean `/workspace` directory inside the container. Useful for throwaway experiments, cloning fresh copies of repos, or any task where the host workspace shouldn't be exposed. Note the pi config files (settings, sessions, etc.) are still mounted in this mode, and only one `--nomount` sandbox can run at a time (container name `pi_nomount`).
## Volume Mounts

- The following pi config files from `~/.pi/agent` are mounted for persisting state across sandbox sessions: 
    - `settings.json`
    - `models.json`
    - `trust.json`
    - `auth.json`
    - The `sessions` directory
- `dir` (specified via `--dir` or current working directory) is mounted under `/home/pi/$REL_PATH`. `$REL_PATH` is `dir` relative to the host home directory. This lets pi track sessions accordingly in the host `~/.pi/agent`, so they can be resumed naturally.

## Preinstalled Packages

There are a few preinstalled packages

- [Superpowers](https://github.com/obra/superpowers)
- [pi-subagents](https://github.com/nicobailon/pi-subagents)
- [rpiv-todo](https://github.com/juicesharp/rpiv-mono)
- [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono)

If you want to enable these packages in your sandbox, have the agent do it — run the `enable-sandbox-extensions` skill (`/skill:enable-sandbox-extensions`). It writes `.pi/settings.json` in your workspace and asks you to run `/reload`.

Or do it manually: create `.pi/settings.json` in your workspace

```json
{
    "extensions": [
        "/home/pi/.pi/agent/git/github.com/obra/superpowers",
        "/home/pi/.pi/agent/npm/node_modules/pi-subagents",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question"
    ]
}
```

## System prompt

The system prompt is appended, to make pi aware of the fact that it's running in a sandbox.

- It knows about installed commandline utilities
- It knows that it can use homebrew to install additional tools if needed
- It knows the name of the docker container the sandbox is running in, so it can ask the user to run `docker exec` commands from the host.
- It knows which forwarded ports to start servers on.

## GitHub CLI (`gh`)

`gh` is preinstalled in the sandbox. The agent can use it for:

- Opening PRs (from the current branch/worktree)
- Reviewing PRs (reading diffs, leaving review comments)
- Cloning private repos
- Triggering CI/CD pipelines (`gh workflow run`) and checking Actions status
- Managing issues and comments

### Providing a token securely

Tokens are passed as environment variables at run time via `--env` — they exist only in the container's environment and are never written to the mounted directory or persisted:

```bash
# Avoid leaving the token in shell history by reading it from a prompt or file:
read -rs GH_TOKEN; echo
./run-sandbox.sh --env "GH_TOKEN=$GH_TOKEN"
```

The sandbox's system prompt tells the agent that the token is in `GH_TOKEN` and that it must never write the token to a file or commit it. `gh` picks up `GH_TOKEN` automatically; no `gh auth login` needed.

### Minimizing token scope

Use a **fine-grained personal access token** scoped to the specific repo(s) the agent needs, and grant only the permissions required:

| Agent use case | Fine-grained permission |
|---|---|
| Clone private repo (read-only) | `Contents: Read` |
| Open / push PRs | `Contents: Read + Write`, `Pull requests: Read + Write` |
| Review PRs (comments only) | `Pull requests: Read + Write` |
| Check CI / Actions status | `Actions: Read` |
| Trigger CI / workflows | `Actions: Read + Write` |
| Manage issues | `Issues: Read + Write` |

Guidelines:

- **Public repos only?** A coarser classic token with `public_repo` (+ `workflow` to trigger Actions) is enough — no `repo` scope needed.
- **Review-only sessions:** grant just `Pull requests: Read + Write`, so the agent cannot push.
- **Rotate or revoke** the token after the session; fine-grained tokens also support short expiry (e.g. 1 hour).
- **Never mount a file containing the token** — the mounted directory is fully readable by the agent.

## Azure DevOps (`az`)

The Azure CLI (`az`) is preinstalled in the sandbox. The agent can use it for Azure DevOps via the `az devops`, `az repos`, `az pipelines`, and `az boards` command groups:

- Cloning private repos (`git clone https://<PAT>@dev.azure.com/<org>/<team>/<repo>`, or `az repos`)
- Opening PRs (`az repos pr create`)
- Reviewing PRs (`az repos pr list` / `show` / `comment` / `merge`)
- Triggering CI/CD pipelines (`az pipelines run`) and checking build status (`az pipelines show` / `list`)
- Managing work items (`az boards work-item list` / `create` / `update`)
- Downloading build artifacts (`az pipelines artifact download`)

It is also the full Azure CLI, so infrastructure tasks (storage, VMs, etc.) work too — but scope the PAT accordingly.

### Providing a PAT securely

As with `GH_TOKEN`, credentials are passed as environment variables at run time — they exist only in the container's environment and are never persisted:

```bash
# Avoid leaving the PAT in shell history:
read -rs AZURE_DEVOPS_PAT; echo
./run-sandbox.sh \
  --env "AZURE_DEVOPS_PAT=$AZURE_DEVOPS_PAT" \
  --env "AZURE_DEVOPS_ORG_URL=https://dev.azure.com/<your-org>"
```

The Azure CLI reads `AZURE_DEVOPS_PAT` and `AZURE_DEVOPS_ORG_URL` directly, so no interactive `az devops login` (browser flow) is needed. The system prompt tells the agent the PAT is in `AZURE_DEVOPS_PAT` and that it must never write it to a file or commit it. Be extra careful with `git clone` URLs containing the PAT — they can leak into `.git/config` and shell history; prefer deleting/rewriting the remote URL after cloning.

### Minimizing PAT scope

Create the PAT in **User Profile → Personal access tokens** and grant only the areas needed:

| Agent use case | PAT area + access level |
|---|---|
| Clone private repo (read-only) | **Code: Read** |
| Open / push PRs | **Code: Read & write** |
| Review PRs (comments only) | **Code: Read & write** (or **Read** if only reading) |
| Merge PRs (may be gated by repo policy) | **Code: Read & write** (some repos require **Full control** to merge) |
| Check build / pipeline status | **Pipelines: Read** |
| Trigger CI / pipelines | **Pipelines: Read & execute** (or **Read & write** to edit definitions) |
| Manage work items | **Work items: Read** or **Read & write** |
| Download artifacts | **Build: Read** |

Guidelines:

- **Read-only review sessions:** grant only the `Read` level for Code/Pipelines — the agent cannot push or trigger anything.
- **Leave everything else at `None`** — General, Security, Project, Environments, etc. don't need access.
- **Set an expiry** on the PAT and revoke it after the session.
- **Never mount a file containing the PAT** — the mounted directory is fully readable by the agent.