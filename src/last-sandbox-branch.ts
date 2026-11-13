// Session-entry lookup for the sandbox work branch: decides, at session
// start, whether a resumed session brings the sandbox back up.
//
// /sandbox-build persists the work branch as a gondolin.sandbox custom
// entry; /sandbox-exit persists the exit as a gondolin.sandbox-exited entry,
// which suppresses the relaunch — the session resumes on the host. (A
// re-entry via /sandbox-build appends a newer sandbox entry, which
// overrides the exit.)

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  SANDBOX_ENTRY_TYPE,
  SANDBOX_EXITED_TYPE,
  type SandboxEntryData,
} from "./config";

/**
 * The work branch of the most recent /sandbox-build in this session
 * branch, if any. A /sandbox-exit entry newer than the sandbox entry
 * suppresses the relaunch: the session exited the sandbox, so it resumes on
 * the host.
 */
export function lastSandboxBranch(
  entries: SessionEntry[],
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    if (entry.customType === SANDBOX_ENTRY_TYPE) {
      return (entry.data as SandboxEntryData | undefined)?.branch;
    }
    if (entry.customType === SANDBOX_EXITED_TYPE) {
      return undefined;
    }
  }
  return undefined;
}
