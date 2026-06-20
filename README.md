# Pi Sandbox

A minimal Docker sandbox for the [pi](https://github.com/Earendil-Works/pi-coding-agent) coding agent.

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

The script mounts the project directory into `/workspace` and the local `~/.pi/agent` into the container's user home, preserving session history across runs.
