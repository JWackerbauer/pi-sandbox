import type { VM } from "@earendil-works/gondolin";
import type { EditOperations } from "@earendil-works/pi-coding-agent";
import { createGondolinReadOps } from "./read";
import { createGondolinWriteOps } from "./write";

export function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}
