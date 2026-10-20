// Tests for src/rootfs.ts: the qemu-style disk size parser and the total
// root disk size resolution (image virtual size + configured extra space).
//
// The `qemu-img` dependency is stood in with a fake executable on PATH (the
// same technique image.test.ts uses for docker/podman), and the image
// assets are a temp dir with the stock asset filenames — loadGuestAssets
// only checks that the files exist.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  baseVirtualSizeBytes,
  parseDiskSizeToBytes,
  resolveRootfsSizeBytes,
} from "./rootfs";

const GiB = 1024 ** 3;

test("parseDiskSizeToBytes accepts integers with optional K/M/G/T/P/E suffix", () => {
  assert.equal(parseDiskSizeToBytes("10G"), 10 * GiB);
  assert.equal(parseDiskSizeToBytes("1g"), GiB);
  assert.equal(parseDiskSizeToBytes("500M"), 500 * 1024 ** 2);
  assert.equal(parseDiskSizeToBytes("2T"), 2 * 1024 ** 4);
  // A bare number (string or number) is a byte count.
  assert.equal(parseDiskSizeToBytes("1048576"), 1048576);
  assert.equal(parseDiskSizeToBytes(1048576), 1048576);
  // Whitespace between number and suffix is tolerated, as is "i"/"b"
  // ("10Gib" is 10 GiB; a bare "b"/"ib" is a byte count, like the SDK).
  assert.equal(parseDiskSizeToBytes("10 G"), 10 * GiB);
  assert.equal(parseDiskSizeToBytes("10Gib"), 10 * GiB);
  assert.equal(parseDiskSizeToBytes("10b"), 10);
});

test("parseDiskSizeToBytes rejects invalid sizes", () => {
  for (const bad of ["0", "0G", "-5", "abc", "10X", "", "1.5G", 0, -1, 1.5, null]) {
    assert.throws(() => parseDiskSizeToBytes(bad as string | number), undefined, String(bad));
  }
  // A safe-integer overflow is rejected.
  assert.throws(() => parseDiskSizeToBytes("999999999999999999999T"));
});

// A temp assets dir with the stock asset filenames (empty files — the SDK
// only checks existence) plus a fake `qemu-img` on PATH reporting a 3 GiB
// virtual size.
function makeAssetsEnv(
  virtualSize: number,
): { assetsDir: string; restorePath: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-rootfs-"));
  const assetsDir = path.join(root, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of ["vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"]) {
    fs.writeFileSync(path.join(assetsDir, name), "");
  }
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const qemuImg = path.join(binDir, "qemu-img");
  fs.writeFileSync(
    qemuImg,
    `#!/bin/sh\necho '{"virtual-size": ${virtualSize}}'\n`,
  );
  fs.chmodSync(qemuImg, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  return {
    assetsDir,
    restorePath: () => {
      process.env.PATH = origPath;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("resolveRootfsSizeBytes is the image size plus the default 10G extra", () => {
  const env = makeAssetsEnv(3 * GiB);
  try {
    assert.equal(resolveRootfsSizeBytes(env.assetsDir, undefined), 13 * GiB);
  } finally {
    env.restorePath();
  }
});

test("resolveRootfsSizeBytes honors the configured extra", () => {
  const env = makeAssetsEnv(3 * GiB);
  try {
    assert.equal(
      resolveRootfsSizeBytes(env.assetsDir, { extra: "1G" }),
      4 * GiB,
    );
    assert.equal(
      resolveRootfsSizeBytes(env.assetsDir, { extra: "512M" }),
      3 * GiB + 512 * 1024 ** 2,
    );
  } finally {
    env.restorePath();
  }
});

test("resolveRootfsSizeBytes rejects an invalid configured extra", () => {
  const env = makeAssetsEnv(3 * GiB);
  try {
    assert.throws(() => resolveRootfsSizeBytes(env.assetsDir, { extra: "nope" }));
  } finally {
    env.restorePath();
  }
});

test("baseVirtualSizeBytes reads the virtual size from qemu-img info", () => {
  const env = makeAssetsEnv(3 * GiB);
  try {
    assert.equal(baseVirtualSizeBytes(path.join(env.assetsDir, "rootfs.ext4")), 3 * GiB);
  } finally {
    env.restorePath();
  }
});

test("baseVirtualSizeBytes fails with a clear error on bad qemu-img output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-rootfs-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const qemuImg = path.join(binDir, "qemu-img");
  // Valid JSON without a virtual-size field.
  fs.writeFileSync(qemuImg, "#!/bin/sh\necho '{}'\n");
  fs.chmodSync(qemuImg, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath}`;
  try {
    assert.throws(
      () => baseVirtualSizeBytes(path.join(root, "rootfs.ext4")),
      /valid virtual size/,
    );
    // A qemu-img that fails outright is wrapped in an actionable error.
    fs.writeFileSync(qemuImg, "#!/bin/sh\nexit 1\n");
    assert.throws(
      () => baseVirtualSizeBytes(path.join(root, "rootfs.ext4")),
      /could not read the root image size/,
    );
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
