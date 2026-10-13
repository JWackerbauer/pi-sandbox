// Tests for the VM startup widget rendering (src/startup-widget.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderStartupLines } from "./startup-widget";

// A fake style function that tags lines with their color.
function fakeStyle(text: string, color: "accent" | "muted"): string {
  return `[${color}]${text}`;
}

test("first line carries the spinner frame, heading, and branch", () => {
  const lines = renderStartupLines(40, 0, "my-branch", "", fakeStyle);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("[accent]"));
  assert.ok(lines[0]!.includes("Starting VM my-branch\u2026"));
});

test("no log line is rendered until the first one arrives", () => {
  const lines = renderStartupLines(40, 1, "b", "", fakeStyle);
  assert.equal(lines.length, 1);
  // Whitespace-only lines are treated as absent.
  assert.equal(renderStartupLines(40, 1, "b", "   \n  ", fakeStyle).length, 1);
});

test("the latest log line is rendered muted on the second line", () => {
  const lines = renderStartupLines(60, 2, "b", "booting qemu", fakeStyle);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "[muted]booting qemu");
});

test("the log line is trimmed", () => {
  const lines = renderStartupLines(60, 0, "b", "  booting qemu  ", fakeStyle);
  assert.equal(lines[1], "[muted]booting qemu");
});

test("long log lines are truncated to the widget width", () => {
  const long = "x".repeat(80);
  const lines = renderStartupLines(20, 0, "b", long, fakeStyle);
  const text = lines[1]!.replace("[muted]", "");
  assert.ok(visibleWidth(text) <= 20);
  // truncateToWidth appends an ellipsis (followed by an ANSI reset).
  assert.ok(text.includes("..."));
});

test("frames cycle modulo the frame count", () => {
  const a = renderStartupLines(40, 0, "b", "", fakeStyle)[0]!;
  const b = renderStartupLines(40, 1, "b", "", fakeStyle)[0]!;
  const c = renderStartupLines(40, 10, "b", "", fakeStyle)[0]!;
  assert.notEqual(a, b);
  assert.equal(a, c);
});
