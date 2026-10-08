import type { VM } from "@earendil-works/gondolin";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { toGuestPath } from "../guest-path";

export function createGondolinBashOps(vm: VM, localCwd: string, guestWs: string): BashOperations {
  // The host environment passed by pi is intentionally not forwarded: it
  // usually contains API keys and other credentials.  Configure secrets for
  // the guest with `httpHooks` (see docs/secrets.md) instead.
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const guestCwd = toGuestPath(localCwd, cwd, guestWs);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        // `/bin/bash -lc` for a familiar environment (pipelines, expansions, etc.)
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
