import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configuredLocalRoots, defaultLocalRoots, resolveAllowedLocalPath } from "../dist/security/localPaths.js";

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-local-")));
}

test("paths inside an allowed root resolve, including files not created yet", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, "a.txt"), "x");
  assert.equal(await resolveAllowedLocalPath(path.join(root, "a.txt"), "read", [root]), path.join(root, "a.txt"));
  assert.equal(
    await resolveAllowedLocalPath(path.join(root, "out", "new.json"), "write", [root]),
    path.join(root, "out", "new.json")
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("paths outside the allowed roots and '..' escapes are refused", async () => {
  const root = await tempRoot();
  const allowed = path.join(root, "allowed");
  await fs.mkdir(allowed);
  await assert.rejects(resolveAllowedLocalPath(path.join(root, "other.txt"), "read", [allowed]), /outside the allowed local roots/);
  await assert.rejects(resolveAllowedLocalPath(path.join(allowed, "..", "other.txt"), "write", [allowed]), /outside/);
  await assert.rejects(resolveAllowedLocalPath("", "read", [allowed]), /required/);
  await fs.rm(root, { recursive: true, force: true });
});

test("symlinks that leave an allowed root are refused", async () => {
  const root = await tempRoot();
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "x");
  try {
    await fs.symlink(outside, path.join(allowed, "link"), "junction");
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    return; // symlinks not permitted on this machine
  }
  await assert.rejects(resolveAllowedLocalPath(path.join(allowed, "link", "secret.txt"), "read", [allowed]), /outside/);
  await fs.rm(root, { recursive: true, force: true });
});

test("sensitive locations are refused even inside an allowed root", async () => {
  const home = os.homedir();
  await assert.rejects(resolveAllowedLocalPath(path.join(home, ".ssh", "id_rsa"), "read", [home]), /protected location/);
  await assert.rejects(resolveAllowedLocalPath("~/.aws/credentials", "read", [home]), /protected location/);
  await assert.rejects(resolveAllowedLocalPath(path.join(home, ".config", "tool", "credentials"), "read", [home]), /credentials|protected/);
});

test("allowed roots come from the environment, then settings, then defaults", () => {
  const previous = process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
  try {
    delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    assert.deepEqual(configuredLocalRoots(["/a"]), ["/a"]);
    assert.deepEqual(configuredLocalRoots(undefined), defaultLocalRoots());
    process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = ["/x", "/y"].join(path.delimiter);
    assert.deepEqual(configuredLocalRoots(["/a"]), ["/x", "/y"]);
  } finally {
    if (previous === undefined) delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    else process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = previous;
  }
});
