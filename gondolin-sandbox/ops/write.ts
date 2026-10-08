import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { WriteOperations } from "@earendil-works/pi-coding-agent";
import { toGuestPath } from "../guest-path";

export function createGondolinWriteOps(vm: VM, localCwd: string, guestWs: string): WriteOperations {
  // Use the VM filesystem API rather than a shell round-trip: it streams the
  // content, so there is no argv size limit and no quoting to get wrong.
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p, guestWs);
      await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dir, guestWs), { recursive: true });
    },
  };
}
