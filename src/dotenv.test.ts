// Tests for loadDotEnv (host `.env` loading before secret resolution).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv, maybeLoadDotEnv } from "./dotenv";

// Write `content` into a fresh `.env` file under a throwaway dir and return
// the file path (plus the dir, so a test can clean it up).
function makeEnvFile(content: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dtenv-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, content);
  return { file, dir };
}

// Names chosen to be unique so they are almost certainly unset in the host
// environment; each test cleans them up so they never leak between tests.
function withCleanedVar(name: string, fn: () => void): void {
  const prev = process.env[name];
  delete process.env[name];
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("missing file returns 0 and sets nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dtenv-"));
  const missing = path.join(dir, "does-not-exist.env");
  withCleanedVar("GONDOLIN_DTE_MISSING", () => {
    assert.equal(loadDotEnv(missing), 0);
    assert.equal(process.env.GONDOLIN_DTE_MISSING, undefined);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parses basic KEY=VALUE lines and returns the count", () => {
  const { file, dir } = makeEnvFile("GONDOLIN_DTE_A=one\nGONDOLIN_DTE_B=two\n");
  withCleanedVar("GONDOLIN_DTE_A", () => {
    withCleanedVar("GONDOLIN_DTE_B", () => {
      assert.equal(loadDotEnv(file), 2);
      assert.equal(process.env.GONDOLIN_DTE_A, "one");
      assert.equal(process.env.GONDOLIN_DTE_B, "two");
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("does not override existing env vars", () => {
  const { file, dir } = makeEnvFile("GONDOLIN_DTE_C=from-file\n");
  const prev = process.env.GONDOLIN_DTE_C;
  process.env.GONDOLIN_DTE_C = "from-env";
  try {
    // Already set in the environment → the file value is ignored and 0 set.
    assert.equal(loadDotEnv(file), 0);
    assert.equal(process.env.GONDOLIN_DTE_C, "from-env");
  } finally {
    if (prev === undefined) delete process.env.GONDOLIN_DTE_C;
    else process.env.GONDOLIN_DTE_C = prev;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("skips blank lines and comments", () => {
  const { file, dir } = makeEnvFile(
    [
      "# a comment",
      "",
      "   ",
      "  # indented comment",
      "GONDOLIN_DTE_D=kept",
      "",
      "# trailing comment",
    ].join("\n"),
  );
  withCleanedVar("GONDOLIN_DTE_D", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_D, "kept");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supports an optional leading export prefix", () => {
  const { file, dir } = makeEnvFile("export GONDOLIN_DTE_E=hello\n");
  withCleanedVar("GONDOLIN_DTE_E", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_E, "hello");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("trims keys and values", () => {
  const { file, dir } = makeEnvFile("  GONDOLIN_DTE_F   =   padded value  \n");
  withCleanedVar("GONDOLIN_DTE_F", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_F, "padded value");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("strips matching double quotes from a value", () => {
  const { file, dir } = makeEnvFile('GONDOLIN_DTE_G="quoted value"\n');
  withCleanedVar("GONDOLIN_DTE_G", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_G, "quoted value");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("strips matching single quotes from a value", () => {
  const { file, dir } = makeEnvFile("GONDOLIN_DTE_H='single quoted'\n");
  withCleanedVar("GONDOLIN_DTE_H", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_H, "single quoted");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("does not strip mismatched quotes and leaves single chars intact", () => {
  const { file, dir } = makeEnvFile(
    ['GONDOLIN_DTE_I="unbalanced\nGONDOLIN_DTE_J="unbalanced\'\nGONDOLIN_DTE_K=x\n'].join(
      "\n",
    ),
  );
  withCleanedVar("GONDOLIN_DTE_I", () => {
    withCleanedVar("GONDOLIN_DTE_J", () => {
      withCleanedVar("GONDOLIN_DTE_K", () => {
        assert.equal(loadDotEnv(file), 3);
        // Mismatched quotes are left as-is.
        assert.equal(process.env.GONDOLIN_DTE_I, '"unbalanced');
        assert.equal(process.env.GONDOLIN_DTE_J, '"unbalanced\'');
        // A single character is too short to be a quoted value.
        assert.equal(process.env.GONDOLIN_DTE_K, "x");
      });
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ignores lines without an equals sign", () => {
  const { file, dir } = makeEnvFile("JUSTAKEY\nGONDOLIN_DTE_L=real\n");
  withCleanedVar("GONDOLIN_DTE_L", () => {
    assert.equal(loadDotEnv(file), 1);
    assert.equal(process.env.GONDOLIN_DTE_L, "real");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("maybeLoadDotEnv is a no-op unless the config opts in", () => {
  const { file: _file, dir } = makeEnvFile("GONDOLIN_DTE_M=yes\n");
  withCleanedVar("GONDOLIN_DTE_M", () => {
    // Absent envFile (default) → the file is not read.
    maybeLoadDotEnv(dir, {});
    assert.equal(process.env.GONDOLIN_DTE_M, undefined);
    // envFile: false → still not read.
    maybeLoadDotEnv(dir, { envFile: false });
    assert.equal(process.env.GONDOLIN_DTE_M, undefined);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("maybeLoadDotEnv loads <localCwd>/.env when opted in", () => {
  const { dir } = makeEnvFile("GONDOLIN_DTE_N=from-file\n");
  withCleanedVar("GONDOLIN_DTE_N", () => {
    maybeLoadDotEnv(dir, { envFile: true });
    assert.equal(process.env.GONDOLIN_DTE_N, "from-file");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("maybeLoadDotEnv keeps existing env vars winning over the file", () => {
  const { dir } = makeEnvFile("GONDOLIN_DTE_O=from-file\n");
  process.env.GONDOLIN_DTE_O = "from-env";
  try {
    maybeLoadDotEnv(dir, { envFile: true });
    assert.equal(process.env.GONDOLIN_DTE_O, "from-env");
  } finally {
    delete process.env.GONDOLIN_DTE_O;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("maybeLoadDotEnv ignores a missing file when opted in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dtenv-"));
  withCleanedVar("GONDOLIN_DTE_P", () => {
    maybeLoadDotEnv(dir, { envFile: true });
    assert.equal(process.env.GONDOLIN_DTE_P, undefined);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
