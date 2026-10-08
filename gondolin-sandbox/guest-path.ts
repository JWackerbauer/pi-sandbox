import path from "node:path";
import { GUEST_WORKSPACE } from "./config";

// POSIX shell quoting: wraps in single quotes and escapes internal quotes.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// pi tools pass absolute local paths; map them into /workspace.
export function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}
