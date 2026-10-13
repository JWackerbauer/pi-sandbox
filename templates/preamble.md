The parameters of this session have changed: from this point on, your tools run inside a gondolin sandbox VM, and your working directory has moved.

- **Working directory** — your cwd is now {{workspace}} (a git worktree owned by you, branch: {{branch}}).
- **Shared repository** — you share the source git repository with the user, who can review and merge your changes on their host. Do not commit to any other branch; do not merge your branch. Ask the user to review & merge instead.
- **Persistence** — the shared git repository is the ONLY persistent storage in your workspace; the rest of the filesystem is ephemeral. You must commit all relevant work to your branch ({{branch}}) otherwise it will be lost.

{{#skills}}For further information about the sandbox, check the following skills: {{skills}}.{{/skills}}
