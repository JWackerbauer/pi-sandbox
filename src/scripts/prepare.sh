#!/bin/bash

set -e

git config --global user.email "$GIT_EMAIL"
git config --global user.name "$GIT_NAME"
cd "$GUEST_GIT_DIR" || exit
git config --global --add safe.directory "$GUEST_GIT_DIR"
git config --global --add safe.directory "$GUEST_WORKSPACE"
# The magic git dir (when mounted) is served with the host user's uid, so
# git's dubious-ownership check would reject `git clone /git/...` from the
# guest. Entries match exact paths (not prefixes), so trust all repos:
# safe here because every repo in the guest is root-initiated and the
# guest itself is an ephemeral sandbox.
git config --global --add safe.directory '*'
git config --global core.hooksPath "$GIT_HOOKS_DIR"

# A stale worktree registration for this exact path (left by a session that
# did not shut down cleanly, so its shutdown-time worktree removal never ran)
# would make `git worktree add` below fail. Detect it and tell the user how to
# clean it up on the host.
if git worktree list --porcelain | grep -qxF "worktree $GUEST_WORKSPACE"; then
    echo "gondolin: a worktree is already registered at $GUEST_WORKSPACE."
    echo
    echo "This is a leftover from a previous sandbox session that did not shut"
    echo "down cleanly, so it could not remove its own worktree. Prune it on"
    echo "the host, then start this session again:"
    echo
    echo "    git -C <your-repo> worktree prune"
    echo
    echo "or remove just this one:"
    echo
    echo "    git -C <your-repo> worktree remove --force $GUEST_WORKSPACE"
    exit 1
fi

if git show-ref --verify --quiet "refs/heads/$WORK_BRANCH_NAME"; then
    git worktree add "$GUEST_WORKSPACE" "$WORK_BRANCH_NAME"
else
    # Optional start point (WORK_BRANCH_START): creates the branch from the
    # given ref (e.g. the parent agent's work branch) instead of the repo HEAD.
    git worktree add -b "$WORK_BRANCH_NAME" "$GUEST_WORKSPACE" ${WORK_BRANCH_START:-}
fi
chmod +x "$GIT_HOOKS_DIR"/prepare-commit-msg
