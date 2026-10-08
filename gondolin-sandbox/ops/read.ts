import fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { VM } from "@earendil-works/gondolin";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";
import { shQuote, toGuestPath } from "../guest-path";

export function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      return vm.fs.readFile(toGuestPath(localCwd, p));
    },
    access: async (p) => {
      await vm.fs.access(toGuestPath(localCwd, p), { mode: fsConstants.R_OK });
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        // Run through the shell because `file` might live in `/usr/bin` depending on the image
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}
