---
name: subagents
description: How to delegate work to background subagents in a gondolin sandbox — spawning, monitoring, aborting, and merging their branches.
---

You can delegate work to subagents with the `spawn_subagent` tool: each runs in its own detached sandbox session on a fresh branch created from your branch, in the background.

- **Spawning** — call `spawn_subagent(prompt)` with a self-contained task description (the subagent does not share your conversation). You can spawn several subagents and let them run in parallel.
- **Results** — when a subagent finishes, its result (summary and commits) is delivered to you proactively as a message on your next turn; you do not have to poll for it.
- **Reviewing & merging** — review the subagent's branch and merge it into your branch with `git merge` if the work is good.
- **Monitoring** — use `subagent_status` to check on running subagents (non-blocking); pass `defer_time` (seconds) to schedule a status check that arrives as a message later without blocking.
- **Stuck or looping** — if a subagent appears stuck or looping, stop it with `subagent_abort` (its commits are kept).
