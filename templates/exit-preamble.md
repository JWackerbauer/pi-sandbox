The parameters of this session have changed: the user has exited the gondolin sandbox, and from this point on your tools run directly on the host.

- **Working directory** — your cwd is back at the host repository root {{cwd}}.
- **Your work** — your work from the sandbox is committed to your branch {{branch}}. The host is not checked out on that branch; if you need to continue with it or review it, check it out first (`git checkout {{branch}}`).
- **Sandbox** — the sandbox VM has been torn down and its worktree removed, so the sandbox is no longer active in this session. Do not run tools inside the sandbox; if the user wants to sandbox again, they can run /build-in-sandbox.
