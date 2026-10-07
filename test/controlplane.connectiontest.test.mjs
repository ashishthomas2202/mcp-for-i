import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Point every config path at a throwaway directory before loading modules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-for-i-conntest-"));
process.env.APPDATA = tempRoot;
process.env.XDG_CONFIG_HOME = tempRoot;
process.env.MCP_FOR_I_CREDENTIAL_STORE = "session";

const { testConnection, clearRejectedPasswords } = await import("../dist/controlplane/connectionTest.js");
const { ConnectionService } = await import("../dist/controlplane/connectionService.js");
const { ConfigStore } = await import("../dist/config/store.js");

const target = { host: "ibmi.example.com", port: 22, username: "dev", password: "secret" };

/** Fake network where every step succeeds unless overridden. */
function deps(overrides = {}) {
  const calls = { ssh: 0 };
  const d = {
    lookup: async () => "10.0.0.5",
    probePort: async () => "SSH-2.0-OpenSSH_9.4",
    readKey: async () => "KEY",
    checkHostKey: async () => ({ status: "trusted", fingerprint: "SHA256:abc" }),
    ssh: async options => {
      calls.ssh++;
      await options.checkHostKey(Buffer.from("key"));
      return { kind: "ready", profile: { daysUntilPasswordExpires: 60 } };
    },
    ...overrides
  };
  return { d, calls };
}

test.beforeEach(() => clearRejectedPasswords());

test("a working connection reports ok with each step", async () => {
  const { d } = deps();
  const result = await testConnection(target, d);
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.equal(result.message, "Connected to ibmi.example.com as DEV.");
  assert.deepEqual(result.profile, { daysUntilPasswordExpires: 60 });
  assert.deepEqual(result.steps.map(s => s.name), ["Host lookup", "SSH port", "Host key", "Sign-on"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.hostKey.status, "trusted");
});

test("warns when the password expires soon", async () => {
  const { d } = deps({ ssh: async () => ({ kind: "ready", profile: { daysUntilPasswordExpires: 3 } }) });
  const result = await testConnection(target, d);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ["The password expires in 3 days."]);
});

test("host not found stops before the port", async () => {
  let probed = false;
  const { d } = deps({
    lookup: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
    probePort: async () => { probed = true; return ""; }
  });
  const result = await testConnection(target, d);
  assert.equal(result.code, "host-not-found");
  assert.equal(probed, false);
});

test("closed, silent and non-SSH ports get their own reasons", async () => {
  for (const [code, expected] of [["ECONNREFUSED", "port-closed"], ["ETIMEDOUT", "port-timeout"], ["EHOSTUNREACH", "host-unreachable"]]) {
    const { d, calls } = deps({ probePort: async () => { throw Object.assign(new Error(code), { code }); } });
    const result = await testConnection(target, d);
    assert.equal(result.code, expected);
    assert.equal(calls.ssh, 0);
  }
  const { d } = deps({ probePort: async () => "HTTP/1.1 400 Bad Request" });
  assert.equal((await testConnection(target, d)).code, "not-ssh");
});

test("no password or key checks the port only", async () => {
  const { d, calls } = deps();
  const result = await testConnection({ ...target, password: undefined }, d);
  assert.equal(result.code, "no-credentials");
  assert.equal(result.ok, false);
  assert.equal(calls.ssh, 0);
});

test("a changed host key is reported and the sign-on is not attempted", async () => {
  const changed = { status: "changed", fingerprint: "SHA256:new", stored: "SHA256:old" };
  const { d } = deps({
    ssh: async options => {
      const check = await options.checkHostKey(Buffer.from("key"));
      assert.equal(check.status, "changed");
      return { kind: "host-key-changed", hostKey: check };
    },
    checkHostKey: async () => changed
  });
  const result = await testConnection(target, d);
  assert.equal(result.code, "host-key-changed");
  assert.match(result.message, /password was not sent/);
  assert.equal(result.hostKey.stored, "SHA256:old");
});

test("an expired password is named", async () => {
  const { d } = deps({ ssh: async () => ({ kind: "password-expired", prompt: "Password expired" }) });
  const result = await testConnection(target, d);
  assert.equal(result.code, "password-expired");
  assert.match(result.message, /expired/);
});

test("a rejected password is not sent again", async () => {
  const authError = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
  const calls = { ssh: 0 };
  const { d } = deps({ ssh: async () => { calls.ssh++; return { kind: "error", error: authError }; } });
  const first = await testConnection(target, d);
  assert.equal(first.code, "auth-failed");
  assert.match(first.message, /disabled profile or an expired password/);

  const second = await testConnection(target, d);
  assert.equal(second.code, "password-already-rejected");
  assert.equal(calls.ssh, 1);

  // A different password, or a different user, is tried.
  await testConnection({ ...target, password: "other" }, d);
  await testConnection({ ...target, username: "dev2" }, d);
  assert.equal(calls.ssh, 3);
});

test("a key that is not accepted gets a key-specific reason", async () => {
  const authError = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
  const { d } = deps({ ssh: async () => ({ kind: "error", error: authError }) });
  const result = await testConnection({ ...target, password: undefined, privateKeyPath: "/k" }, d);
  assert.equal(result.code, "auth-failed");
  assert.match(result.message, /authorized_keys/);
});

test("an unreadable key file is reported before connecting", async () => {
  const { d, calls } = deps({ readKey: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
  const result = await testConnection({ ...target, privateKeyPath: "/missing" }, d);
  assert.equal(result.code, "key-unreadable");
  assert.equal(calls.ssh, 0);
});

test("the real port probe tells a closed port from an SSH banner", async () => {
  const server = net.createServer(socket => socket.end("SSH-2.0-Test\r\n"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await testConnection({ host: "127.0.0.1", port, username: "dev" });
    assert.equal(result.code, "no-credentials");
    assert.equal(result.steps[1].detail, "SSH-2.0-Test");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const closed = await testConnection({ host: "127.0.0.1", port, username: "dev" });
  assert.equal(closed.code, "port-closed");
});

test("the service keeps the last result and never sends a saved password to new details", async () => {
  const seen = [];
  const store = new ConfigStore();
  const service = new ConnectionService(store, async t => {
    seen.push(t);
    return { ok: true, code: "ok", message: "ok", steps: [], warnings: [], testedAt: new Date().toISOString(), durationMs: 1 };
  });
  await service.add({ name: "DEV", host: "dev.example.com", username: "ME", password: "pw", storePassword: true });

  await service.testSaved("DEV");
  assert.equal(seen[0].password, "pw");
  assert.equal((await service.list()).find(c => c.name === "DEV").lastTest.code, "ok");

  await service.testDetails({ name: "DEV", host: "dev.example.com", username: "me" });
  assert.equal(seen[1].password, "pw");
  await service.testDetails({ name: "DEV", host: "other.example.com", username: "ME" });
  assert.equal(seen[2].password, undefined);

  await service.update("DEV", { host: "dev2.example.com", password: "pw2" });
  assert.equal((await service.list()).find(c => c.name === "DEV").lastTest, undefined);
  await service.delete("DEV");
});

test("a second test of the same endpoint while one runs is refused", async () => {
  let release;
  const service = new ConnectionService(new ConfigStore(), () => new Promise(resolve => { release = resolve; }));
  const first = service.testDetails({ host: "h", username: "u", password: "p" });
  await assert.rejects(service.testDetails({ host: "H", username: "U", password: "p" }), err => err.status === 409);
  release({ ok: true });
  await first;
});
