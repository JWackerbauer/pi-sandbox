// The fuzzy branch selector for /sandbox-on-branch, shown via
// `ctx.ui.custom` (see sandbox-on-branch.ts). It mirrors pi's built-in
// /model picker (ModelSelectorComponent) structure and behavior:
// border frame, bold title, a live search Input box, a filtered list
// (best fuzzy match preselected, 10 visible lines centered on the
// selection, scroll indicator), and dim key hints with muted labels.
//
// Typing goes to the search input (pi-tui's Input: characters, backspace,
// kill-ring, paste); the list is re-filtered live with pi-tui's fuzzyFilter
// (subsequence match — every typed character must appear in order, with
// consecutive runs, word boundaries after '-', and earlier matches scoring
// best; space/slash-separated tokens must all match). Up/down wrap, enter
// selects, escape cancels.
//
// Only pi-tui is imported (pi-coding-agent's DynamicBorder/keyHint are
// reproduced with pi-tui primitives: the border is a colored rule rendered
// with an explicit color function — the way pi's own DynamicBorder docs
// ask extensions to do it — and the hints use the keybinding manager's
// key display text). This keeps the component loadable by the test runner.

import {
  Container,
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  type Component,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** How many branch lines are visible before the list scrolls (as /model). */
const MAX_VISIBLE = 10;

// The border line, rendered like pi's DynamicBorder: a full-width rule in
// the border color, via an explicit color function.
class BorderLine implements Component {
  constructor(private color: (text: string) => string) {}
  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
  invalidate(): void {}
}

// Format a key id for display, mirroring pi's keybinding hints ("alt" is
// shown as "option" on macOS).
function formatKeyText(keys: string[]): string {
  return keys
    .join("/")
    .split("/")
    .map((k) =>
      k
        .split("+")
        .map((part) => {
          const display =
            process.platform === "darwin" && part.toLowerCase() === "alt"
              ? "option"
              : part;
          return display.charAt(0).toUpperCase() + display.slice(1);
        })
        .join("+"),
    )
    .join("/");
}

/**
 * A branch selector with live fuzzy search, structured like
 * ModelSelectorComponent: border frame, title, search Input, list, key
 * hints. `handleInput` routes navigation/confirm/cancel and passes
 * everything else to the search input; the Focusable setter propagates
 * focus to the input (IME cursor positioning).
 */
export class BranchSelectComponent extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private branches: string[];
  private filtered: string[];
  private selectedIndex = 0;
  private keybindings: KeybindingsManager;
  private theme: Theme;
  private onDone: (branch: string | undefined) => void;
  private closed = false;
  private _focused = false;

  // Focusable: propagate focus to the search input, as ModelSelectorComponent
  // does.
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: {
    title: string;
    branches: string[];
    theme: Theme;
    keybindings: KeybindingsManager;
    onDone: (branch: string | undefined) => void;
  }) {
    super();
    this.branches = options.branches;
    this.filtered = [...options.branches];
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onDone = options.onDone;

    // Key hints: dim key text + muted label, like pi's keyHint/rawKeyHint.
    const hint = (key: Keybinding, label: string): string =>
      this.theme.fg("dim", formatKeyText(this.keybindings.getKeys(key))) +
      this.theme.fg("muted", ` ${label}`);
    const hintText =
      this.theme.fg("dim", "↑↓") +
      this.theme.fg("muted", " navigate") +
      "  " +
      hint("tui.select.confirm", "select") +
      "  " +
      hint("tui.select.cancel", "cancel");

    // Layout: the same structure as the /model picker.
    this.addChild(new BorderLine((t) => this.theme.fg("border", t)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(this.theme.fg("accent", this.theme.bold(options.title)), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      // Enter on the search input selects the current item (as /model does).
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.finish(selected);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new Text(hintText, 1, 0));
    this.addChild(new BorderLine((t) => this.theme.fg("border", t)));
    this.updateList();
  }

  dispose(): void {
    this.closed = true;
  }

  handleInput(keyData: string): void {
    if (this.closed) return;
    // Up arrow - wrap to bottom when at top
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filtered.length - 1
          : this.selectedIndex - 1;
      this.updateList();
    } else if (this.keybindings.matches(keyData, "tui.select.down")) {
      // Down arrow - wrap to top when at bottom
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filtered.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
    } else if (this.keybindings.matches(keyData, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.finish(selected);
    } else if (this.keybindings.matches(keyData, "tui.select.cancel")) {
      // Escape or Ctrl+C
      this.finish(undefined);
    } else {
      // Pass everything else to the search input (typing, backspace,
      // editing) and re-filter live.
      this.searchInput.handleInput(keyData);
      this.filterBranches(this.searchInput.getValue());
    }
  }

  /** Re-filter with the query; best match preselected (as /model does). */
  private filterBranches(query: string): void {
    this.filtered = query
      ? fuzzyFilter(this.branches, query, (b) => b)
      : [...this.branches];
    // With a query the best match is preselected; when cleared, keep the
    // position clamped to the restored list (as /model does).
    this.selectedIndex = query
      ? 0
      : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.updateList();
  }

  /** Render the visible window of the filtered list (as /model does). */
  private updateList(): void {
    this.listContainer.clear();
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
        this.filtered.length - MAX_VISIBLE,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filtered.length);
    for (let i = startIndex; i < endIndex; i++) {
      const branch = this.filtered[i]!;
      const isSelected = i === this.selectedIndex;
      const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const text = isSelected ? this.theme.fg("accent", branch) : branch;
      this.listContainer.addChild(new Text(`${cursor}${text}`, 0, 0));
    }
    if (startIndex > 0 || endIndex < this.filtered.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg(
            "muted",
            `  (${this.selectedIndex + 1}/${this.filtered.length})`,
          ),
          0,
          0,
        ),
      );
    }
    if (this.filtered.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching branches"), 0, 0),
      );
    }
  }

  private finish(branch: string | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.onDone(branch);
  }
}
