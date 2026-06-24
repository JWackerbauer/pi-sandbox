# Pi Sandbox

A minimal Docker sandbox for the [pi](https://github.com/Earendil-Works/pi-coding-agent) coding agent.

> ❗️ **Caution:**
> 
> The sandbox should prevent the agent from breaking out, however the agent can work in the directory you mount. 
> 
> Be smart: 
> - Use git
> - Don't put secrets in mounted directories

## Building

```bash
docker build -t pi-sandbox .
```

## Running

```bash
# Simple usage (uses current directory)
./run-sandbox.sh

# With forwarded ports
./run-sandbox.sh --port 3000:3000,5173:5173

# With a specific directory
./run-sandbox.sh --dir /path/to/project --port 3000:3000

# For help
./run-sandbox.sh --help
```
## Volume Mounts

- The following pi config files from `~/.pi/agent` are mounted for persisting state across sandbox sessions: 
    - `settings.json`
    - `models.json`
    - `trust.json`
    - `auth.json`
    - The `sessions` directory
- `dir` (specified via `--dir` or current working directory) is mounted under `/home/pi/$REL_PATH`. `$REL_PATH` is `dir` relative to the host home directory. This let's pi track sessions accordingly in the host `~/.pi/agent`, so they can be resumed naturally.

## Preinstalled Packages

There are a few preinstalled packages

- Superpowers
- pi-subagents
- rpiv-todo
- rpiv-ask-user-question

If you want to enable these packages in your sandbox, create `.pi/settings.json` in your workspace

```json
{
    "extensions": [
        "/home/pi/.pi/agent/git/github.com/obra/superpowers",
        "/home/pi/.pi/agent/npm/node_modules/pi-subagents",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo",
        "/home/pi/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question"
    ]
}
```

## System prompt

The system prompt is appended, to make pi aware of the fact that it's running in a sandbox.

- It knows about installed commandline utilities
- It knows that it can use homebrew to install additional tools if needed
- It knows the name of the docker container the sandbox is running in, so it can ask the user to run `docker exec` commands from the host.
- It knows which forwarded ports to start servers on.