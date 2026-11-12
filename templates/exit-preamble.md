The parameters of this session have changed: the user has exited the gondolin sandbox, and from this point on your tools run directly on the host.

- **Working directory** — your cwd is back at the host repository root {{cwd}}.
- **Your work** — If you committed it to your branch {{branch}}; your work is still there. The host is not checked out on that branch; if you need to continue with it or review it, ask the user if you can check it out. (`git checkout {{branch}}`).
- **Sandbox** — the sandbox VM has been torn down and its worktree removed, so the sandbox is no longer active in this session. 
