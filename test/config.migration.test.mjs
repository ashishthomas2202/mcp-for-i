import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../dist/config/store.js";
import { getPassword, deletePassword, setKeytarModuleForTesting } from "../dist/security/credentialStore.js";

function fakeKeytar() {
  const values = new Map();
  return {
    values,
    async setPassword(service, account, password) {
      values.set(`${service}/${account}`, password);
    },
    async getPassword(service, account) {
      return values.get(`${service}/${account}`) ?? null;
    },
    async deletePassword(service, account) {
      return values.delete(`${service}/${account}`);
    },
    async findCredentials() {
      return [];
    }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withLegacyConfig(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-config-"));
  const oldAppData = process.env.APPDATA;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldMode = process.env.MCP_FOR_I_CREDENTIAL_STORE;
  process.env.APPDATA = tempRoot;
  process.env.XDG_CONFIG_HOME = tempRoot;
  const connectionName = `LEGACY_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const plaintextPassword = "PlaintextLegacyPass123!";
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
  try {
    await fn({ connectionName, plaintextPassword, configDir, configPath });
  } finally {
    await deletePassword(connectionName).catch(() => {});
    setKeytarModuleForTesting(undefined);
    restoreEnv("APPDATA", oldAppData);
    restoreEnv("XDG_CONFIG_HOME", oldXdg);
    restoreEnv("MCP_FOR_I_CREDENTIAL_STORE", oldMode);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

test("ConfigStore migrates legacy plaintext passwords into a persistent keychain", async () => {
  await withLegacyConfig(async ({ connectionName, plaintextPassword, configPath }) => {
    const keytar = fakeKeytar();
    setKeytarModuleForTesting(keytar);
    delete process.env.MCP_FOR_I_CREDENTIAL_STORE;

    // Default constructor: resolves the config dir from APPDATA / XDG_CONFIG_HOME.
    const store = new ConfigStore();
    assert.equal(store.getConfigPath(), configPath);
    const loaded = await store.load();

    assert.equal(loaded.connections.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.connections[0], "password"), false);

    const rewritten = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.connections[0], "password"), false);

    assert.equal(keytar.values.get(`mcp-for-i/${connectionName}`), plaintextPassword);
    assert.equal(await getPassword(connectionName), plaintextPassword);
  });
});

test("ConfigStore keeps plaintext passwords when only in-memory storage is available", async () => {
  await withLegacyConfig(async ({ connectionName, plaintextPassword, configDir, configPath }) => {
    setKeytarModuleForTesting(null);
    delete process.env.MCP_FOR_I_CREDENTIAL_STORE;

    const store = new ConfigStore({ configDir });
    await store.load();

    const onDisk = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(onDisk.connections[0].password, plaintextPassword, "plaintext must stay until the keychain has it");
    // Usable in this process, but not exposed through the store API.
    assert.equal(await getPassword(connectionName), plaintextPassword);
    const listed = await store.listConnections();
    assert.equal(Object.prototype.hasOwnProperty.call(listed[0], "password"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(await store.getConnection(connectionName), "password"), false);

    // Unrelated updates keep the plaintext.
    await store.saveProfile(connectionName, { name: "dev", libraryList: ["QGPL"] });
    const afterProfile = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(afterProfile.connections[0].password, plaintextPassword);
    assert.equal(afterProfile.connections[0].profiles[0].name, "dev");

    // Once a keychain is available, the next load moves it and removes the plaintext.
    const keytar = fakeKeytar();
    setKeytarModuleForTesting(keytar);
    await new ConfigStore({ configDir }).load();
    const migrated = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.connections[0], "password"), false);
    assert.equal(keytar.values.get(`mcp-for-i/${connectionName}`), plaintextPassword);
  });
});

test("ConfigStore keeps plaintext passwords when keychain mode cannot reach the keychain", async () => {
  await withLegacyConfig(async ({ plaintextPassword, configDir, configPath }) => {
    setKeytarModuleForTesting(null);
    process.env.MCP_FOR_I_CREDENTIAL_STORE = "keychain";

    const store = new ConfigStore({ configDir });
    await store.load();
    const onDisk = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(onDisk.connections[0].password, plaintextPassword);
  });
});
