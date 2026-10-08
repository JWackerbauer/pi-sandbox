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
