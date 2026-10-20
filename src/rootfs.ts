// Resolves the guest's total root disk size: the base image's virtual size
// plus the configured extra space (config `rootfs.extra`, default 10G).
//
// The SDK's `rootfs.size` VM option is a *total* minimum disk size, so the
// extension computes the total here from the image assets on disk. The SDK
// then grows the per-VM qcow2 overlay (the default `cow` rootfs mode) to
// that size — the base image is never modified — and grows the guest
// filesystem with `resize2fs` after boot, before the VFS is ready (the stock
// image ships `e2fsprogs-extra`).

import { execFileSync } from "node:child_process";
import { loadGuestAssets } from "@earendil-works/gondolin";
import { DEFAULT_ROOTFS_EXTRA, type RootfsConfig } from "./config";

/**
 * Parse a qemu-style disk size (a positive integer with an optional
 * K/M/G/T/P/E suffix, e.g. "10G", or a plain byte count) into bytes.
 * Mirrors the Gondolin SDK's parser, which is not exported.
 */
export function parseDiskSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `invalid disk size: ${String(value)} (expected a positive integer byte count)`,
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a string like "10G")`,
    );
  }
  const match = /^(\d+)\s*([a-zA-Z]*)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer with an optional K/M/G/T/P/E suffix)`,
    );
  }
  const amount = BigInt(match[1]!);
  if (amount <= 0n) {
    throw new Error(
      `invalid disk size: ${JSON.stringify(value)} (expected a positive integer)`,
    );
  }
  let suffix = match[2]!.toLowerCase();
  if (suffix.endsWith("ib")) suffix = suffix.slice(0, -2);
  else if (suffix.endsWith("b")) suffix = suffix.slice(0, -1);
  const exponents: Record<string, number> = {
    "": 0,
    byte: 0,
    bytes: 0,
    k: 1,
    m: 2,
    g: 3,
    t: 4,
    p: 5,
    e: 6,
  };
  const exponent = exponents[suffix];
  if (exponent === undefined) {
    throw new Error(
      `invalid disk size suffix: ${JSON.stringify(match[2]!)} (expected K/M/G/T/P/E)`,
    );
  }
  const bytes = amount * 1024n ** BigInt(exponent);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`disk size is too large: ${JSON.stringify(value)}`);
  }
  return Number(bytes);
}

/**
 * The guest's total root disk size in bytes: the base image's virtual size
 * plus the configured extra space (config `rootfs.extra`, default 10G).
 * `assetsDir` is the resolved image assets dir (see src/image.ts).
 */
export function resolveRootfsSizeBytes(
  assetsDir: string,
  rootfs: RootfsConfig | undefined,
): number {
  const extra = parseDiskSizeToBytes(rootfs?.extra ?? DEFAULT_ROOTFS_EXTRA);
  const assets = loadGuestAssets(assetsDir);
  return baseVirtualSizeBytes(assets.rootfsPath) + extra;
}

/** The virtual size (bytes) of a disk image, via `qemu-img info`. */
export function baseVirtualSizeBytes(rootfsPath: string): number {
  let info: { "virtual-size"?: unknown };
  try {
    const out = execFileSync(
      "qemu-img",
      ["info", "--output", "json", rootfsPath],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    info = JSON.parse(out);
  } catch (err) {
    throw new Error(
      `gondolin: could not read the root image size via qemu-img info ${rootfsPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const size = info["virtual-size"];
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error(
      `gondolin: qemu-img info did not report a valid virtual size for ${rootfsPath}`,
    );
  }
  return size as number;
}
