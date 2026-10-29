# ADR: Serve skill files to the agent from the host, not the guest

- **Status:** Accepted
- **Date:** 2026
- **Related:** `docs/architecture.md` (skills), `src/skills.ts`, `src/index.ts`

## Context

The agent loads skills by issuing a plain `read` tool call on the skill's
**host file path**, which pi's system prompt advertises
(`<location>${skill.filePath}</location>`). Inside the sandbox, the wrapped
`read` tool maps host repo paths into the guest workspace
(`toGuestPath`) and rejects everything else (`path escapes workspace`).

Three skill locations are in play:

- **Gondolin skills** — rendered templates (per-process host temp dir).
- **Repo-local skills** — `<repo>/.pi/skills`, `<repo>/.agents/skills`.
- **Global skills** — `~/.pi/agent/skills`, `~/.agents/skills`.

Only repo-local paths map into the worktree; the other two live outside the
repo root and fail the guest's containment check. Two candidate designs were
considered for making them readable.

## Options

### A. Copy/mount into the guest worktree (rejected earlier)

Render into `<repo>/.pi/skills/gondolin` and copy into each worktree at VM
launch, with `.pi/` added to `.git/info/exclude`.

Rejected: files in the agent's worktree risk colliding with legitimate agent
work under `.pi/` (the agent may well create and commit repo-local skills
there), and the `.git` exclude hack is fragile.

### B. Guest read-only mount (rejected)

Mount the host skill dirs into the guest (e.g. `/skills-global`) via the
Gondolin SDK's `ReadonlyProvider` over `RealFSProvider`, which enforces
read-only at the VFS layer.

Rejected, for two reasons:

1. **The read-tool interception is needed anyway.** Pi advertises skills by
   their *host* paths. The agent calls `read` on the host path, so the
   wrapper must intercept host skill paths in every design — with a mount it
   would only *translate* the path to the mount point instead of serving
   directly. The mount removes no wrapper code; it adds guest-side plumbing
   (mount setup in `launchDetachedVm`, a passthrough root in
   `toGuestPath`).
2. **Escape detection must be special-cased in the guest.** A mount point
   outside the workspace `/<branch>` is rejected by `toGuestPath`; we would
   need a second "allowed root" concept in the path mapping. Mounting *inside*
   the workspace to dodge this shadows the worktree's own files at that path
   — the same collision problem as option A.

The only benefit of a mount is that guest-side tools other than `read`
(`bash cat`, `grep`, `ls`) see the files. That benefit is marginal: the
preamble and skill text tell the agent to use `read`.

### C. Host-serve via the wrapped `read` tool (chosen)

The rendered gondolin skills stay in a per-process host temp dir; the global
skill roots are added to the same list. The wrapped `read` tool serves any
path inside these **host-served roots** with the plain host `read` tool
(`isHostServedPath` in `src/skills.ts`); everything else routes to the guest.

## Decision

Adopt **C**. Properties:

- All three skill locations are readable in the sandbox.
- Zero guest footprint: no worktree files, no `.git` exclude, no VFS mounts.
- Skills are **read-only from the agent's view**: `write`/`edit` on
  host-served paths still fail the containment check.
- Repo-local skills need no interception: their host paths map into the
  worktree, and agent-created skill files in the guest are read back from
  the guest (legitimate `.pi/` work is unaffected).

## Known limitations (deliberate)

- Guest-side tools other than `read` (`bash cat`, `grep`) cannot see
  host-served skill files. Acceptable while skills are read via `read`.
- **Untracked** repo-local skill files are invisible in the guest (the
  worktree only contains tracked files). If this bites, the natural
  extension is to host-serve the repo's own skill roots too — but that would
  shadow guest-side writes to those paths, so only do it if skills should be
  uniformly read-only.

## Revisit if

- A skill instructs the agent to `bash` its bundled scripts (then mount via
  `ReadonlyProvider`, which the SDK already supports cleanly).
- Untracked repo-local skills become a real problem (then host-serve the
  repo's skill roots, accepting read-only semantics for them).
