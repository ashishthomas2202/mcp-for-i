import test from "node:test";
import assert from "node:assert/strict";
import { detectCredentialEnvironment } from "../dist/security/credentialStore.js";

test("credential environment maps Windows PowerShell to Windows Credential Manager", () => {
  const env = { PSModulePath: "C:\\Users\\dev\\Documents\\PowerShell\\Modules" };
  const detected = detectCredentialEnvironment(env, "win32", "10.0.22631");

  assert.equal(detected.label, "Windows");
  assert.equal(detected.terminal, "powershell");
  assert.equal(detected.nativeStore, "Windows Credential Manager");
  assert.equal(detected.isWsl, false);
});

test("credential environment treats Git Bash as Windows runtime storage", () => {
  const env = { SHELL: "C:/Program Files/Git/usr/bin/bash.exe", MSYSTEM: "MINGW64" };
  const detected = detectCredentialEnvironment(env, "win32", "10.0.22631");

  assert.equal(detected.label, "Windows");
  assert.equal(detected.terminal, "git-bash");
  assert.equal(detected.nativeStore, "Windows Credential Manager");
});

test("credential environment maps WSL to Linux Secret Service", () => {
  const env = { WSL_DISTRO_NAME: "Ubuntu", SHELL: "/bin/bash" };
  const detected = detectCredentialEnvironment(env, "linux", "6.6.87.2-microsoft-standard-WSL2");

  assert.equal(detected.label, "Linux (WSL)");
  assert.equal(detected.terminal, "wsl");
  assert.equal(detected.nativeStore, "Linux Secret Service");
  assert.equal(detected.isWsl, true);
});

test("credential environment maps macOS to macOS Keychain", () => {
  const detected = detectCredentialEnvironment({ SHELL: "/bin/zsh" }, "darwin", "23.4.0");

  assert.equal(detected.label, "macOS");
  assert.equal(detected.terminal, "zsh");
  assert.equal(detected.nativeStore, "macOS Keychain");
});

import { setPassword, getPassword, deletePassword, setKeytarModuleForTesting, getCredentialStoreStatus } from "../dist/security/credentialStore.js";

async function withCredentialMode(mode, keytarModule, fn) {
  const previous = process.env.MCP_FOR_I_CREDENTIAL_STORE;
  if (mode === undefined) delete process.env.MCP_FOR_I_CREDENTIAL_STORE;
  else process.env.MCP_FOR_I_CREDENTIAL_STORE = mode;
  setKeytarModuleForTesting(keytarModule);
  try {
    await fn();
  } finally {
    setKeytarModuleForTesting(undefined);
    if (previous === undefined) delete process.env.MCP_FOR_I_CREDENTIAL_STORE;
    else process.env.MCP_FOR_I_CREDENTIAL_STORE = previous;
  }
}

function memoryKeytar() {
  const values = new Map();
  return {
    values,
    async setPassword(_service, account, password) { values.set(account, password); },
    async getPassword(_service, account) { return values.get(account) ?? null; },
    async deletePassword(_service, account) { return values.delete(account); },
    async findCredentials() { return []; }
  };
}

function brokenKeytar() {
  const fail = async () => { throw new Error("secret service is locked"); };
  return { setPassword: fail, getPassword: fail, deletePassword: fail, findCredentials: fail };
}

test("keychain mode refuses to fall back to in-memory storage", async () => {
  const name = `KEYCHAIN_ONLY_${Date.now()}`;
  await withCredentialMode("keychain", null, async () => {
    await assert.rejects(() => setPassword(name, "pw"), err => err.name === "KeychainUnavailableError" && /MCP_FOR_I_CREDENTIAL_STORE=keychain/.test(err.message));
    await assert.rejects(() => getPassword(name), /keychain/);
    const status = await getCredentialStoreStatus();
    assert.equal(status.persistent, false);
    assert.match(status.message, /not usable/);
  });
  await withCredentialMode("keychain", brokenKeytar(), async () => {
    await assert.rejects(() => setPassword(name, "pw"), /secret service is locked/);
    await assert.rejects(() => getPassword(name), /secret service is locked/);
  });
});

test("keychain mode stores passwords persistently when the keychain works", async () => {
  const name = `KEYCHAIN_OK_${Date.now()}`;
  const keytar = memoryKeytar();
  await withCredentialMode("keychain", keytar, async () => {
    assert.deepEqual(await setPassword(name, "pw1"), { persistent: true, store: "keychain" });
    assert.equal(keytar.values.get(name), "pw1");
    assert.equal(await getPassword(name), "pw1");
    await deletePassword(name);
    assert.equal(await getPassword(name), undefined);
  });
});

test("auto mode still falls back to in-memory storage and reports it as not persistent", async () => {
  const name = `AUTO_FALLBACK_${Date.now()}`;
  await withCredentialMode(undefined, null, async () => {
    assert.deepEqual(await setPassword(name, "pw"), { persistent: false, store: "session" });
    assert.equal(await getPassword(name), "pw");
    // keepExistingSessionValue does not overwrite a value already held in memory.
    await setPassword(name, "other", { keepExistingSessionValue: true });
    assert.equal(await getPassword(name), "pw");
    await deletePassword(name);
    assert.equal(await getPassword(name), undefined);
  });
  await withCredentialMode("session", memoryKeytar(), async () => {
    assert.deepEqual(await setPassword(name, "pw"), { persistent: false, store: "session" });
    await deletePassword(name);
  });
});
