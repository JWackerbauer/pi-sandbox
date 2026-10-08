import path from "node:path";
import fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { VM, RealFSProvider } from "@earendil-works/gondolin";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";

const GIT_EMAIL = "jan.wackerbauer@gmail.com";
const GIT_NAME = "Jan Wackerbauer";

function shQuote(value: string): string {
  // POSIX shell quoting: wraps in single quotes and escapes internal quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toGuestPath(localCwd: string, localPath: string): string {
  // pi tools pass absolute local paths; map them into /workspace.
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // Convert platform separators to POSIX for the Linux guest
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
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

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    // Use the VM filesystem API rather than a shell round-trip: it streams the
    // content, so there is no argv size limit and no quoting to get wrong.
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      await vm.fs.mkdir(path.posix.dirname(guestPath), { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dir), { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    // The host environment passed by pi is intentionally not forwarded: it
    // usually contains API keys and other credentials.  Configure secrets for
    // the guest with `httpHooks` (see docs/secrets.md) instead.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

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

const workBranchName = "gondolin-test"
const guestGitDir = "/source/.git"

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  
  const localGitDir = `${localCwd}/.git`;

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );
      
      const created = await VM.create({
        sandbox: {
          imagePath: "./gondolin-sandbox/image-assets"
        },
        vfs: {
          mounts: {
            [guestGitDir]: new RealFSProvider(localGitDir),
          },
        },
      });



      const moduleRoot = path.resolve(__dirname);
      await created.fs.writeFile(
        "/prepare.sh",
        fs.readFileSync(path.join(moduleRoot, "scripts", "prepare.sh"))
      );
      const gitHooksDir="/root/.git/hooks";
      await created.fs.mkdir(gitHooksDir, {recursive: true});
      await created.fs.writeFile(
        path.join(gitHooksDir, "prepare-commit-msg"),
        fs.readFileSync(path.join(moduleRoot, "scripts", "prepare-commit-msg"))
      )

      // String form runs in /bin/sh -lc "..."
      const result = await created.exec(`
        export GIT_EMAIL='${GIT_EMAIL}' &&\
        export GIT_NAME='${GIT_NAME}' &&\ 
        export WORK_BRANCH_NAME='${workBranchName}' &&\
        export GUEST_GIT_DIR='${guestGitDir}' &&\
        export GUEST_WORKSPACE='${GUEST_WORKSPACE}' &&\
        export GIT_HOOKS_DIR='${gitHooksDir}' &&\
          chmod +x /prepare.sh && /prepare.sh || mkdir ${GUEST_WORKSPACE}
      `);

      vm = created;
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${workBranchName} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(`
        exitCode: ${result.exitCode}
        stdout: ${result.stdout}
        stderr: ${result.stderr}
        Gondolin VM ready. Branch ${workBranchName} of ${localCwd} created at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();



    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    // Start eagerly so the user sees errors early (missing qemu, etc.)
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // Run user `!` commands inside the VM too
  pi.on("user_bash", (_event, _ctx) => {
    if (!vm) return;
    return { operations: createGondolinBashOps(vm, localCwd) };
  });

  // Replace the CWD line in the system prompt so the model sees /workspace
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE}, git worktree, your branch: ${workBranchName}
You are inside an ephemeral sandbox, you share a git repository with the user. The git repository is the only form of persistence. You must commit your work. You must commit on your branch (${workBranchName}) and your branch only.`,
    );
    return { systemPrompt: modified };
  });
}