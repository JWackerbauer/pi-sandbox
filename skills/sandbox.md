---
name: sandbox
description: The gondolin sandbox environment — which github hosts are reachable, which secrets are wired in, and which features (scratch mounts, development mode) are enabled.
---

This gondolin sandbox provides the following:

{{#github_hosts}}
**Reachable hosts** — requests carrying a secret may be sent to: {{github_hosts}}.
{{/github_hosts}}
{{^github_hosts}}
No authenticated hosts are configured for this sandbox.
{{/github_hosts}}

{{#secrets}}
**Wired-in secrets** — these secrets are available to the guest (only placeholders are ever visible, never the values): {{secrets}}.
{{/secrets}}

{{#scratch}}
**Scratch mounts** — two directories persist across VM restarts (host tempdir, not git):
- `/scratch` — shared by every sandbox session of this repo.
- `/scratch-local` — private to the current work branch.

Use them only to persist files across VM restarts — they are a persistence mechanism, not additional workspace disk space.
{{/scratch}}
{{^scratch}}
No scratch mounts are enabled for this sandbox.
{{/scratch}}

{{#developMode}}
**Development mode** — this sandbox is under development. When you are done working, report any issues you encountered with the sandbox itself (broken tools, missing packages, unexpected behavior) so they can be fixed.
{{/developMode}}
