---
name: github
description: How to use the gh CLI and the /git magic dir to access the GitHub hosts (github.com and/or GitHub Enterprise) configured for this sandbox.
---

This sandbox has the `gh` CLI installed and authenticated for one or more GitHub hosts (github.com and/or GitHub Enterprise hosts). Which hosts are configured is listed in your system prompt.

## Using `gh` for a specific host

`gh` is configured for multiple hosts, so **always set `GH_HOST` to the host you mean** when running `gh` (this also covers the default host, and is required for GHE hosts):

- List an owner's (user or org) repos: `GH_HOST=<host> gh repo list <owner>`
- Clone a repo into your workspace: `GH_HOST=<host> gh repo clone <owner>/<repo>`
- Call the API: `GH_HOST=<host> gh api /repos/<owner>/<repo>`
- Create a PR / issues: `GH_HOST=<host> gh pr create ...`, `GH_HOST=<host> gh issue create ...`
- Verify auth: `gh auth status`

Clone repos with `gh repo clone` into your workspace (`/<branch>`) when you need to modify them, then commit to your branch as usual.

## The `/git` magic dir

For hosts that have a magic dir enabled, their repos are browsable as a **lazily-cloned, read-only** tree under `/git`, laid out as `/git/<host>/<owner>/<repo>`:

- `ls /git` — list the configured hosts that have a magic dir.
- `ls /git/<host>/<owner>` — list an owner's (user or org) repos.
- `ls /git/<host>/<owner>/<repo>` — the repo's files (cloned on first access).
- `cat /git/<host>/<owner>/<repo>/README.md` — read a file directly.

The magic dir is read-only and shared across sessions, so never write to it. To change a repo, clone it into your workspace with `gh repo clone` and work on that copy.
