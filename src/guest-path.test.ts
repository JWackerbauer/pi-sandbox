import { test } from "node:test";
import assert from "node:assert/strict";
import { shQuote, toGuestPath } from "./guest-path";

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

test("the rendered skill paths are rejected by the guest mapping (served from the host)", () => {
  // The skill paths listed in the prompt are host temp-dir paths; the
  // wrapped read tool intercepts them before the guest mapping (see
  // index.ts), and anything that does reach the mapping is rejected.
  const hostSkill = "/tmp/gondolin-sandbox/skills-1234/sandbox.md";
  assert.throws(() => toGuestPath("/host/cwd", hostSkill, WS), /escapes workspace/);
});
