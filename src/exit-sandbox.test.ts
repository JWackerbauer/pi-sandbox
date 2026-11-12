// Tests for lastSandboxBranch (src/last-sandbox-branch.ts): the
// session-start lookup that decides whether a resumed session brings the
// sandbox back up. A gondolin.sandbox entry relaunches the sandbox for its
// branch; a newer gondolin.sandbox-exited entry (from /exit-sandbox)
// suppresses it, so the session resumes on the host.

import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { lastSandboxBranch } from "./last-sandbox-branch";
import { SANDBOX_ENTRY_TYPE, SANDBOX_EXITED_TYPE } from "./config";

function sandboxEntry(branch: string): SessionEntry {
  return {
    type: "custom",
    customType: SANDBOX_ENTRY_TYPE,
    data: { branch },
    id: "id",
    parentId: null,
    timestamp: new Date().toISOString(),
  } as SessionEntry;
}

function exitedEntry(branch: string): SessionEntry {
  return {
    type: "custom",
    customType: SANDBOX_EXITED_TYPE,
    data: { branch },
    id: "id",
    parentId: null,
    timestamp: new Date().toISOString(),
  } as SessionEntry;
}

function otherEntry(): SessionEntry {
  return {
    type: "message",
    message: null,
    id: "id",
    parentId: null,
    timestamp: new Date().toISOString(),
  } as unknown as SessionEntry;
}

test("no sandbox entries: no branch", () => {
  assert.equal(lastSandboxBranch([otherEntry()]), undefined);
  assert.equal(lastSandboxBranch([]), undefined);
});

test("a sandbox entry yields its branch", () => {
  assert.equal(
    lastSandboxBranch([otherEntry(), sandboxEntry("my-branch")]),
    "my-branch",
  );
});

test("the most recent sandbox entry wins", () => {
  assert.equal(
    lastSandboxBranch([
      sandboxEntry("first"),
      otherEntry(),
      sandboxEntry("second"),
    ]),
    "second",
  );
});

test("an exit entry after the sandbox entry suppresses the relaunch", () => {
  assert.equal(
    lastSandboxBranch([
      sandboxEntry("my-branch"),
      otherEntry(),
      exitedEntry("my-branch"),
    ]),
    undefined,
  );
});

test("a re-entry (sandbox entry after the exit entry) relaunches", () => {
  assert.equal(
    lastSandboxBranch([
      sandboxEntry("first"),
      exitedEntry("first"),
      sandboxEntry("second"),
    ]),
    "second",
  );
});

test("an exit entry without a sandbox entry yields no branch", () => {
  assert.equal(lastSandboxBranch([exitedEntry("my-branch")]), undefined);
});
