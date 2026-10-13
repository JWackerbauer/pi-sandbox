import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { shQuote, toGuestPath } from "./guest-path";
import { guestSkillsDir, hostSkillsDir } from "./config";

const WS = "/my-branch";

test("shQuote wraps in single quotes and escapes inner quotes", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test("toGuestPath maps relative host paths into the guest workspace", () => {
  assert.equal(toGuestPath("/host/cwd", "/host/cwd/src/index.ts", WS), `${WS}/src/index.ts`);
});

test("toGuestPath maps the cwd itself to the guest workspace", () => {
  assert.equal(toGuestPath("/host/cwd", "/host/cwd", WS), WS);
});

test("toGuestPath passes guest paths through", () => {
  assert.equal(toGuestPath("/host/cwd", `${WS}/a/b.ts`, WS), `${WS}/a/b.ts`);
});

test("toGuestPath rejects paths escaping the workspace", () => {
  assert.throws(() => toGuestPath("/host/cwd", "/elsewhere/file.ts", WS), /escapes workspace/);
  assert.throws(() => toGuestPath("/host/cwd", "/etc/passwd", WS), /escapes workspace/);
  assert.throws(() => toGuestPath("/host/cwd", `${WS}/../other`, WS), /escapes workspace/);
});

test("the rendered skill paths map from the host repo into the guest worktree", () => {
  // The skill paths listed in the prompt are host repo paths; the agent's
  // read tool must map them into the guest workspace, where the files are
  // copied at VM launch (see vm.ts).
  const host = hostSkillsDir("/host/cwd");
  const guest = guestSkillsDir("my-branch");
  assert.equal(host, path.join("/host/cwd", ".pi", "skills", "gondolin"));
  assert.equal(guest, `${WS}/.pi/skills/gondolin`);
  const file = path.join(host, "sandbox.md");
  assert.equal(toGuestPath("/host/cwd", file, WS), `${guest}/sandbox.md`);
});
