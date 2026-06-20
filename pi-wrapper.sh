#!/bin/bash
# pi-wrapper.sh - Auto-resume session by display name
#
# Updates pi, then parses --name/-n from args to find a matching
# session by session_info name. Falls back to -c (most recent) if
# no match is found.

# Keep pi up to date
pi update --self

# Parse --name / -n from args
EXPECTED_NAME=""
for ((i=0; i<$#; i++)); do
    arg="${!i}"
    if [[ "$arg" == "--name" ]] || [[ "$arg" == "-n" ]]; then
        NEXT=$((i+1))
        if [[ $NEXT -lt $# ]]; then
            EXPECTED_NAME="${!NEXT}"
        fi
        break
    fi
done

if [[ -n "$EXPECTED_NAME" ]]; then
    SESSION_DIR="$HOME/.pi/agent/sessions"
    CWD=$(pwd)
    # Convert cwd path to session dir name (replace / with -)
    SESSION_PATH_DIR="${CWD//\//-}"
    SESSION_BASE_DIR="$SESSION_DIR/$SESSION_PATH_DIR"

    if [[ -d "$SESSION_BASE_DIR" ]]; then
        # Search for a session whose session_info name matches
        ESCAPED_NAME=$(printf '%s' "$EXPECTED_NAME" | sed 's/[]\/$*.^[]/\\&/g')
        for session_file in "$SESSION_BASE_DIR"/*.jsonl; do
            [[ -f "$session_file" ]] || continue
            if grep -q "\"type\":\"session_info\".*\"name\":\"$ESCAPED_NAME\"" "$session_file" 2>/dev/null; then
                exec pi --session "$session_file" "$@"
            fi
        done
    fi
fi

# No matching session found — continue most recent
exec pi -c "$@"
