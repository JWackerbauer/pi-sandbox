# Gondolin Sandbox — pi extension

Runs pi's agent tools inside a lightweight [Gondolin](https://github.com/obra/gondolin) VM
(aarch64 Alpine guest on macOS), while the pi session itself stays on your host. The agent
believes it is working in `/workspace`; only the shared git repository is persistent, and
the agent works on its own work branch that you review and merge on the host.

## Quick start

Inside a git repository, start a sandbox build:

```
/build-in-sandbox <what do you want to build?>
```

This:
1. Summarizes your prompt into a kebab-case branch name using the current model.
2. Launches the Gondolin VM and checks out that branch as a git worktree at `/workspace` in the guest.
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

- `image.json` defines an Alpine 3.23 aarch64 image (krun firmware 5.2.1) with git,
  node, python, uv, bash, and friends.
- The host's `.git` directory is mounted into the guest at `/source/.git`.
- On launch, the extension writes `scripts/prepare.sh` and a `prepare-commit-msg` git hook
  into the guest, then runs `prepare.sh`, which:
  - configures the guest git identity (`GIT_NAME`/`GIT_EMAIL` from `config.ts`),
  - points `core.hooksPath` at the installed hooks,
  - creates the work branch (if it doesn't exist) as a worktree at `/workspace`.
- The `prepare-commit-msg` hook appends a `Co-Authored-By: pi-agent` trailer to commits.

### Tool redirection

`index.ts` re-registers the four built-in tools (`read`, `write`, `edit`, `bash`) with
wrappers that transparently route their file operations into the guest:

- File paths are mapped from the host cwd into `/workspace` (`guest-path.ts`); paths
  escaping the workspace are rejected.
- `bash` (including user `!` commands) runs as `/bin/bash -lc` **inside the guest**. The
  host environment is deliberately not forwarded — it usually contains API keys. Give the
  guest what it needs via Gondolin's `httpHooks` instead.
- The VM is started lazily: by `/build-in-sandbox` (with the generated branch) or by the
  first tool call that needs it (default branch).

The `before_agent_start` hook rewrites the CWD section of the system prompt so the model
knows it is in `/workspace` on its own branch, that only the git repository is
persistent, and that it must commit to its branch and ask the user to review & merge.

### Sessions

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

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry point: registers the command, tools, and session hooks |
| `commands/build-in-sandbox.ts` | The `/build-in-sandbox` command |
| `vm.ts` | VM lifecycle: launch, replace, close |
| `config.ts` | Guest layout, git identity, limits, session entry type |
| `branch-name.ts` | Prompt → branch name summarizer and sanitizer |
| `guest-path.ts` | Host path → guest path mapping |
| `ops/` | Gondolin-backed implementations of the read/write/edit/bash tool operations |
| `scripts/prepare.sh` | Guest-side git setup, run on VM launch |
| `scripts/prepare-commit-msg` | Git hook adding the pi-agent co-author trailer |
| `image.json` | Gondolin guest image definition |

## Notes

- Launching a VM for a *different* branch replaces any running VM.
- Everything in the guest except the git repository is ephemeral — the agent is told this
  and must commit its work to its branch.
