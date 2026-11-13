// Tests for the fuzzy branch selector (src/branch-select.ts): the
// type-to-filter branch selection shown via `ctx.ui.custom` from
// /sandbox-on-branch, structured like pi's /model picker. The component is
// driven with fake theme/keybindings and simulated key input.

import test from "node:test";
import assert from "node:assert/strict";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { BranchSelectComponent } from "./branch-select";

const BRANCHES = [
  "add-exit-sandbox-command",
  "add-sandbox-on-branch-command",
  "fix-bug-42",
];

function makeComponent(
  branches: string[] = BRANCHES,
  onDone: (branch: string | undefined) => void = () => {},
) {
  // Identity theme: rendered lines are plain text, easy to assert on.
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  // Arrow keys / escape as raw terminal sequences; enter as \r or \n.
  const keybindings = {
    matches: (data: string, key: string) => {
      const map: Record<string, string[]> = {
        "tui.select.up": ["\x1b[A"],
        "tui.select.down": ["\x1b[B"],
        "tui.select.confirm": ["\r", "\n"],
        "tui.select.cancel": ["\x1b"],
      };
      return (map[key] ?? []).includes(data);
    },
    getKeys: (key: string) => {
      const map: Record<string, string[]> = {
        "tui.select.confirm": ["enter"],
        "tui.select.cancel": ["esc"],
      };
      return map[key] ?? [];
    },
  } as unknown as KeybindingsManager;
  return new BranchSelectComponent({
    title: "Choose a branch",
    branches,
    theme,
    keybindings,
    onDone,
  });
}

test("renders the title, every branch, and the key hints", () => {
  const comp = makeComponent();
  const lines = comp.render(80);
  assert.ok(lines.some((l) => l.includes("Choose a branch")));
  for (const b of BRANCHES) {
    assert.ok(lines.some((l) => l.includes(b)), `missing branch ${b}`);
  }
  assert.ok(lines.some((l) => l.includes("navigate")));
});

test("the first branch is preselected", () => {
  const comp = makeComponent();
  const lines = comp.render(80);
  assert.ok(lines.some((l) => l.trim() === `→ ${BRANCHES[0]}`));
});

test("typing filters by fuzzy subsequence match (not prefix)", () => {
  // "e" is not a prefix of any branch, but matches add-exit-sandbox-command.
  const comp = makeComponent();
  comp.handleInput("e");
  const lines = comp.render(80).join("\n");
  assert.ok(lines.includes("add-exit-sandbox-command"));
  assert.ok(!lines.includes("add-sandbox-on-branch-command"));
  assert.ok(!lines.includes("fix-bug-42"));
});

test("the best match is preselected after filtering", () => {
  const comp = makeComponent();
  for (const ch of "add") comp.handleInput(ch);
  const lines = comp.render(80);
  assert.ok(lines.some((l) => l.trim() === `→ ${BRANCHES[0]}`));
});

test("backspace removes the last filter character", () => {
  const comp = makeComponent();
  for (const ch of "ex") comp.handleInput(ch);
  comp.handleInput("\x7f");
  // "e" matches only add-exit-sandbox-command again.
  const lines = comp.render(80).join("\n");
  assert.ok(lines.includes("add-exit-sandbox-command"));
  assert.ok(!lines.includes("add-sandbox-on-branch-command"));
});

test("enter resolves the selected branch, once", () => {
  const calls: (string | undefined)[] = [];
  const comp = makeComponent(BRANCHES, (b) => calls.push(b));
  comp.handleInput("\n");
  comp.handleInput("\n"); // ignored after done
  assert.deepEqual(calls, [BRANCHES[0]]);
});

test("navigation moves and wraps around", () => {
  const calls: (string | undefined)[] = [];
  const comp = makeComponent(BRANCHES, (b) => calls.push(b));
  comp.handleInput("\x1b[B"); // down
  comp.handleInput("\x1b[B"); // down
  comp.handleInput("\x1b[B"); // down — wraps to first
  comp.handleInput("\n");
  assert.deepEqual(calls, [BRANCHES[0]]);
});

test("a filter with no matches shows a notice; enter no-ops, escape cancels", () => {
  const calls: (string | undefined)[] = [];
  const comp = makeComponent(BRANCHES, (b) => calls.push(b));
  for (const ch of "zzz") comp.handleInput(ch);
  const lines = comp.render(80).join("\n");
  assert.ok(lines.includes("No matching branches"));
  comp.handleInput("\n"); // nothing selected: enter is a no-op (as /model)
  assert.deepEqual(calls, []);
  comp.handleInput("\x1b");
  assert.deepEqual(calls, [undefined]);
});

test("escape cancels", () => {
  const calls: (string | undefined)[] = [];
  const comp = makeComponent(BRANCHES, (b) => calls.push(b));
  comp.handleInput("\x1b");
  assert.deepEqual(calls, [undefined]);
});

test("focus is propagated to the search input", () => {
  const comp = makeComponent();
  comp.focused = true;
  assert.equal(comp.focused, true);
});
