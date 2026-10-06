import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpContext } from "../dist/mcp/context.js";

function fakeClient() {
  return {
    disconnected: false,
    async disconnect() { this.disconnected = true; },
    getConfig: () => ({})
  };
}

test("disconnecting the active session leaves no active connection", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-ctx-"));
  const ctx = new McpContext();
  ctx.sessionSnapshotPath = path.join(tempDir, "session-state.json");
  const now = Date.now();
  for (const name of ["PROD", "DEV"]) {
    ctx.sessions.set(name, {
      name,
      client: fakeClient(),
      policy: { profile: "guarded" },
      connection: { name },
      state: "connected",
      lastUsedAt: now,
      lastValidatedAt: now,
      expiresAt: now + 60000
    });
  }
  ctx.activeName = "DEV";

  await ctx.disconnect("DEV");
  assert.equal(ctx.activeName, undefined);
  assert.ok(ctx.sessions.has("PROD"), "other sessions stay open");
  await assert.rejects(ctx.ensureActive(), /No active connection/);

  await ctx.disconnect("PROD");
  await fs.rm(tempDir, { recursive: true, force: true });
});
