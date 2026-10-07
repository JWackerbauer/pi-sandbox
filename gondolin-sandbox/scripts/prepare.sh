#!/bin/bash

set -e

git config --global user.email "$GIT_EMAIL"
git config --global user.name "$GIT_NAME"
cd "$GUEST_GIT_DIR" || exit
git config --global --add safe.directory "$GUEST_GIT_DIR"
git config --global --add safe.directory "$GUEST_WORKSPACE"
git config --global core.hooksPath "$GIT_HOOKS_DIR"
git worktree prune
git worktree add "$GUEST_WORKSPACE" "$WORK_BRANCH_NAME"
chmod +x "$GIT_HOOKS_DIR"/prepare-commit-msg
