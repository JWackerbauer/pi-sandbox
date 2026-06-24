#!/usr/bin/env bash
set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────
PORTS=""
DIR="$PWD"

# ─── Parse arguments ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)   PORTS="$2";  shift 2 ;;
    --dir)    DIR=$(realpath "$2");    shift 2 ;;
    --help)
      echo "Usage: run-sandbox.sh [--port <ports>] [--dir <path>]"
      echo ""
      echo "  --port  Comma-separated port mappings, e.g. 3000:3000,5173:5173"
      echo "  --dir   Directory to mount into the sandbox (default: current dir)"
      exit 0
      ;;
    *) echo "Unknown option: $1";  break;;
  esac
done

# ─── Pre-flight check ──────────────────────────────────────────────────
if ! docker image inspect pi-sandbox >/dev/null 2>&1; then
  echo "Error: pi-sandbox image not found. Build it first:"
  echo "  docker build -t pi-sandbox ."
  exit 1
fi

# ─── Derive container name from directory ──────────────────────────────
# Path relative to $HOME with / → _, prefixed with pi_
if [[ "$DIR" == "$HOME/"* ]]; then
  REL_PATH="${DIR#"$HOME"/}"
else
  echo "Error: directory must be under $HOME (got $DIR)"
  exit 1
fi
BASE_NAME="pi_${REL_PATH//\//_}"

CONTAINER_NAME="$BASE_NAME"

CONTAINER_HOME="/home/pi"

# Ensure pi config directory and files exist for first-run on fresh machines.
# Files must contain valid JSON ("{}") — pi refuses to read empty files.
PI_AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$PI_AGENT_DIR/sessions"
for f in models.json settings.json trust.json auth.json; do
  if [ ! -f "$PI_AGENT_DIR/$f" ]; then
    printf '{}' > "$PI_AGENT_DIR/$f"
  fi
done

# Enforce single sandbox per workspace (docker will fail if already running)
echo "Container name: ${CONTAINER_NAME}"

# ─── Build docker run command ───────────────────────────────────────────
DOCKER_ARGS=(--rm -it --name "$CONTAINER_NAME")

# Security hardening
DOCKER_ARGS+=(--cap-drop ALL)
DOCKER_ARGS+=(--security-opt no-new-privileges)
DOCKER_ARGS+=(--memory 2g)
DOCKER_ARGS+=(--user 1001:1001)
DOCKER_ARGS+=(--pids-limit 200)

WORKDIR="$CONTAINER_HOME/$REL_PATH"

# Volume mounts
DOCKER_ARGS+=(-v "$DIR:$WORKDIR")
DOCKER_ARGS+=(-w "$WORKDIR")
DOCKER_ARGS+=(-v "$HOME/.pi/agent/models.json:/home/pi/.pi/agent/models.json")
DOCKER_ARGS+=(-v "$HOME/.pi/agent/settings.json:/home/pi/.pi/agent/settings.json")
DOCKER_ARGS+=(-v "$HOME/.pi/agent/trust.json:/home/pi/.pi/agent/trust.json")
DOCKER_ARGS+=(-v "$HOME/.pi/agent/auth.json:/home/pi/.pi/agent/auth.json")
DOCKER_ARGS+=(-v "$HOME/.pi/agent/sessions:/home/pi/.pi/agent/sessions")

# Port forwards
if [[ -n "$PORTS" ]]; then
  IFS=',' read -ra PORT_PAIRS <<< "$PORTS"
  for pair in "${PORT_PAIRS[@]}"; do
    DOCKER_ARGS+=(-p "$pair")
  done
fi

# Build the system context for --append-system-prompt
PORT_LIST=""
if [[ -n "$PORTS" ]]; then
  for pair in "${PORT_PAIRS[@]}"; do
    HOST_PORT="${pair%%:*}"
    CONTAINER_PORT="${pair##*:}"
    PORT_LIST="${PORT_LIST}  - ${HOST_PORT} → localhost:${CONTAINER_PORT}\n"
  done
fi

SYSTEM_CONTEXT=$(cat <<EOF
You are running inside a Docker sandbox container named \`${CONTAINER_NAME}\`.

- **User**: The current user is \`pi\` (non-root, uid 1001). Home directory is \`/home/pi\`.
  You do **not** have sudo access.
- **Working directory**: \`~/$REL_PATH\` is bind-mounted from the host.
${PORT_LIST:+- **If you need to start a web server for the user \, use these forwarded ports**:\n${PORT_LIST}}- **Available CLI tools**: \`bash\`, \`git\`, \`node\`, \`npm\`, \`npx\`, \`go\`, \`jq\`, \`yq\`, \`rg\` (ripgrep),
  \`grep\`, \`sed\`, \`awk\`, \`find\`, \`ls\`, \`cat\`, \`curl\`.
- **Package managers**: Homebrew is available at \`/home/linuxbrew/.linuxbrew/bin/brew\`.
  Use it to install most tools you need (e.g. \`brew install yq -q\`).
- If you need a tool that requires root-level installation (apt, system packages),
  ask the user to run \`docker exec -u root ${CONTAINER_NAME} bash -c "apt-get update && apt-get install -y <package>"\`
- **Git identity**: This sandbox uses a sandbox-only git identity (user.name: "pi-sandbox",
  user.email: "pi-sandbox@localhost") to prevent commits under the users real account.
  Do **not** change git user config in the repository you are working on.
EOF
)

# ─── Run the sandbox ────────────────────────────────────────────────────
docker run "${DOCKER_ARGS[@]}" \
  pi-sandbox \
  --append-system-prompt "$SYSTEM_CONTEXT" "$@"
