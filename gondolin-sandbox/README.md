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

The extension registers two tools that let the agent delegate work to subagents,
each running in its own **detached sandbox session**:

- `spawn_subagent(prompt)` — same interface as `/build-in-sandbox`: the prompt is
  summarized into a fresh branch name (suffixed `-2`, `-3`, … if the name is taken),
  a detached VM is launched for it with the branch created **from the parent's
  current branch**, and a background pi agent session (SDK, in-memory, no
  extensions/skills) works on the prompt with its four tools routed into the new
  guest. The tool returns as soon as the VM is up — the parent keeps working and
  can spawn more subagents in parallel.
- `subagent_results([id])` — returns the results of finished subagents (final
  summary + `git log --oneline start..branch`) and the status of running ones.
  If subagents are still running, it blocks until at least one finishes, so the
  agent can "stop and wait".

**Proactive delivery:** the agent does not have to poll. When a subagent
finishes, the extension injects its result into the parent session as a custom
message (`gondolin.subagent-result`) that triggers the agent's next turn —
queued as a follow-up if the parent is mid-turn, immediate if idle. If the
agent already fetched that result via `subagent_results`, the notice is
suppressed.

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
| `index.ts` | Extension entry point: registers the command, tools, and session hooks |
| `commands/build-in-sandbox.ts` | The `/build-in-sandbox` command |
| `vm.ts` | VM lifecycle: detached VM launch, single-VM sandbox wrapper, worktree removal |
| `subagents.ts` | Detached subagent sessions: spawn, background SDK agent runs, results, shutdown |
| `config.ts` | Guest layout, git identity, limits, session entry type |
| `branch-name.ts` | Prompt → branch name summarizer and sanitizer |
| `guest-path.ts` | Host path → guest path mapping |
| `ops/` | Gondolin-backed implementations of the read/write/edit/bash tool operations |
| `scripts/prepare.sh` | Guest-side git setup, run on VM launch |
| `scripts/prepare-commit-msg` | Git hook adding the pi-agent co-author trailer |
| `image.json` | Gondolin guest image definition |

## Notes

- The sandbox is **per session**: each pi session runs its own extension instance and its
  own VM, so you can work on multiple branches in parallel across sessions. Launching a
  different branch *within the same session* replaces that session's VM. Subagents are the
  same idea *within* one session: each gets its own detached VM and branch, running in the
  background next to the parent's VM.
- Everything in the guest except the git repository is ephemeral — the agent is told this
  and must commit its work to its branch (subagents too; their branches outlive their VMs).
