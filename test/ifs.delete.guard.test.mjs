import test from "node:test";
import assert from "node:assert/strict";
import { handleTool } from "../dist/mcp/tools.js";

function context(commands) {
  return {
    activeName: "TEST",
    getPolicy: () => ({ profile: "power-user", requireApprovalFor: [] }),
    getActiveConfig: () => ({}),
    ensureActive: async () => ({
      getConfig: () => ({}),
      sendCommand: async ({ command }) => {
        commands.push(command);
        return { code: 0, stdout: "", stderr: "" };
      }
    })
  };
}

test("ifs.delete refuses user home directories, recursive or not", async () => {
  const commands = [];
  for (const args of [
    { path: "/home/PGMASHISH" },
    { path: "/home/PGMASHISH/", recursive: true, confirmPath: "/home/PGMASHISH" }
  ]) {
    await assert.rejects(handleTool(context(commands), "ibmi.ifs.delete", args), /user home directory/);
  }
  assert.deepEqual(commands, []);
});

test("ifs.delete refuses shallow recursive deletes and unconfirmed ones", async () => {
  const commands = [];
  await assert.rejects(
    handleTool(context(commands), "ibmi.ifs.delete", { path: "/pcr/source", recursive: true, confirmPath: "/pcr/source" }),
    /three levels deep/
  );
  await assert.rejects(
    handleTool(context(commands), "ibmi.ifs.delete", { path: "/home/DEV/work", recursive: true }),
    /confirmPath/
  );
  await assert.rejects(
    handleTool(context(commands), "ibmi.ifs.delete", { path: "/home/DEV/work", recursive: true, confirmPath: "/home/DEV" }),
    /confirmPath/
  );
  assert.deepEqual(commands, []);
});

test("ifs.delete runs a confirmed recursive delete of a deep path", async () => {
  const commands = [];
  await handleTool(context(commands), "ibmi.ifs.delete", { path: "/home/DEV/work", recursive: true, confirmPath: "/home/DEV/work/" });
  assert.deepEqual(commands, ["rm -rf /home/DEV/work"]);
});
