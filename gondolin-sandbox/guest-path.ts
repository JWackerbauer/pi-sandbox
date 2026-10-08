import path from "node:path";

// POSIX shell quoting: wraps in single quotes and escapes internal quotes.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// pi tools pass paths that may be host-local (relative, or absolute under the
// host repo root) or guest paths (absolute under the guest workspace, which
// the system prompt advertises as the cwd). Map either into the guest
// workspace.
export function toGuestPath(
  localCwd: string,
  localPath: string,
  guestWs: string,
): string {
  // Absolute guest paths: normalize and re-check containment, then pass through.
  if (localPath === guestWs || localPath.startsWith(guestWs + path.posix.sep)) {
    const guestPath = path.posix.normalize(localPath);
    if (guestPath === guestWs || guestPath.startsWith(guestWs + path.posix.sep)) {
      return guestPath;
    }
    throw new Error(`path escapes workspace: ${localPath}`);
  }

  const rel = path.relative(localCwd, localPath);
  if (rel === "") return guestWs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(guestWs, posixRel);
}
