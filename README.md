# pi-sandbox Extension

## git Worktrees in a Gondolin Sandbox

Run pi's agent tools inside a lightweight [Gondolin](https://github.com/earendil-works/gondolin) VM. Inspired by the the [pi-gondolin example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts) with a twist: The agent workspace is a **git worktree** of the host git repository.

**Core Features:**
- Agents work & commit on a designated branch using their worktree inside the VM.
- The user can review & merge the agents work. 
- Multiple simultaneous agents can work independently.
- Agents can start subagents who in turn have their own worktrees based on the main agents branch.
- pi Sessions & branches are named consistently and automatically.
- Resuming a session brings the VM & Worktree back along with the context.
- Context pollution is kept to a minimum, agents have access to templated skills in VM, used to gather context on demand.

In addition to isolating agents from the host machine, the sandboxed worktrees are a powerful orchestration tool. 

It helps with managing context & sessions and keeps your codebase from becoming overly messy by introducing structure into the review process.

## Getting Started

**Install the requirements for running gondolin**: 

| macOS                    | Linux (Debian/Ubuntu)                         |
| ------------------------ | --------------------------------------------- |
| `brew install qemu node` | `sudo apt install qemu-system-arm nodejs npm` |

**Install the requirements for building custom gondolin images**: 

| macOS                    | Linux (Debian/Ubuntu)                         |
| ------------------------ | --------------------------------------------- |
| `brew install lz4 e2fsprogs` | `sudo apt install lz4 cpio e2fsprogs` |

**Install the pi extension**: 
```
# Clone the extension repository.
git clone https://github.com/JWackerbauer/pi-sandbox && cd pi-sandbox

# Build the base gondolin image
npm run build:basic-image

# Install the pi extension
pi install .
```

You can now transport any pi session into a sandboxed worktree using `/build-in-sandbox <your prompt>`.

You can also start a sandbox session directly from the commandline (useful for integrating into scripts): `pi '/build-in-sandbox <your prompt>'`

## Configuration

The extension can be configured using `gondolin.json`. 

- Global configuration: `~/.pi/agent/gondolin.json`
- Local configuration: `path/to/my/repo/.pi/gondolin.json`

Detailed configuration reference can be found [here](docs/configuration.md).

### Secrets

Gondolin offers functionality for providing your agents with secrets without leaking them to context: [Documentation](https://earendil-works.github.io/gondolin/secrets/)

You can reference host environment variables in `gondolin.json` and add a list of allowed egress hosts: 

```json
{
    "secrets": {
        "GH_TOKEN": {
            "hosts": ["api.github.com"]
        }
    }
}
```

Set `"envFile": true` in `gondolin.json` to have the extension load `.env` from your workspace (never exposed to agent); or you can use [`direnv`](https://direnv.net/).

### `gondolin.json` Examples:

**dotnet**
```json
{
    "secrets": {
        "NUGET_TOKEN": {
            "hosts": ["pkgs.dev.azure.com"]
        }
    },
    "postBuild": {
        "commands": [
            "apk add dotnet10-sdk aspnetcore10-runtime dotnet10-runtime"
        ]
    },
    "postStartup": [
        "dotnet nuget update source releases --username empty --password $NUGET_TOKEN --store-password-in-clear-text"
    ],
    "env": {
        "NUGET_PACKAGES": "/scratch/.nuget/packages"
    }
}
```

**pi extension development:**
```json
{
    "developMode": true,
    "github": [
        {"host": "github.com", "ghCliToken": "GH_TOKEN", "magicDir": true}
    ],
    "coAuthor": true,
    "postBuild": {
        "commands": ["apk add nodejs npm"]
    }
}
```

## Contributing

Dogfooding is encouraged, please use the extension when making contributions, this is the most intuitive way to find issues & make improvements.