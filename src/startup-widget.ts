import {
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Braille spinner frames, animated while the VM starts up (same frames as
// the subagent spinner in index.ts).
const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2866", "\u2827", "\u2807", "\u280f"];

/** Style a line of the startup widget. */
export type StartupLineStyle = (text: string, color: "accent" | "muted") => string;

/**
 * Build the lines of the VM startup widget: an animated spinner with the
 * branch name, plus the latest boot log line (truncated to the widget
 * width). The widget keeps the startup logs out of the transcript, so they
 * never mix with the first turn's output.
 */
export function renderStartupLines(
  width: number,
  frame: number,
  branch: string,
  latestLine: string,
  style: StartupLineStyle,
): string[] {
  const lines = [
    style(
      `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Starting VM ${branch}\u2026`,
      "accent",
    ),
  ];
  const line = latestLine.trim();
  if (line.length > 0) {
    lines.push(style(truncateToWidth(line, width), "muted"));
  }
  return lines;
}

/**
 * Widget shown above the editor (next to the "Working" spinner) while the
 * main VM launches: an animated spinner, the branch name, and the latest
 * boot log line. Replaced with `undefined` once the VM is ready (see
 * index.ts).
 */
export class VmStartupWidget implements Component {
  /** Latest boot log line, set by the index.ts launch callback. */
  latestLine = "";

  private frame = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private branch: string,
  ) {
    this.timer = setInterval(() => {
      this.frame += 1;
      this.tui.requestRender();
    }, 80);
  }

  render(width: number): string[] {
    return renderStartupLines(
      width,
      this.frame,
      this.branch,
      this.latestLine,
      (text, color) => this.theme.fg(color, text),
    );
  }

  invalidate(): void {
    // Stateless apart from the spinner frame; nothing to clear.
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
