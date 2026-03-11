import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../dist/config/store.js";
import { getPassword, deletePassword } from "../dist/security/credentialStore.js";

test("ConfigStore migrates legacy plaintext connection passwords", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-config-"));
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = tempRoot;

  const connectionName = `LEGACY_${Date.now()}`;
  const plaintextPassword = "PlaintextLegacyPass123!";

  try {
    const configDir = path.join(tempRoot, "mcp-for-i");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          connections: [
            {
              name: connectionName,
              host: "legacy.example.com",
              port: 22,
              username: "LEGACYUSR",
              password: plaintextPassword,
              policy: { profile: "guarded" }
            }
          ],
          settings: {},
          actions: []
        },
        null,
        2
      ),
      "utf8"
    );

    const store = new ConfigStore();
    const loaded = await store.load();

    assert.equal(loaded.connections.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.connections[0], "password"), false);

    const rewritten = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.connections[0], "password"), false);

    const migratedPassword = await getPassword(connectionName);
    assert.equal(migratedPassword, plaintextPassword);
  } finally {
    await deletePassword(connectionName).catch(() => {});
    if (oldAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = oldAppData;
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});
