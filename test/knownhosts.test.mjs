import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkHostKey,
  hostKeyFingerprint,
  hostKeyType,
  knownHostId,
  isNewHostKeyAccepted,
  HostKeyMismatchError
} from "../dist/ibmi/knownHosts.js";

function keyBlob(type, body) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, Buffer.from(body)]);
}

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfori-kh-"));
  return path.join(dir, "known_hosts.json");
}

test("fingerprint uses OpenSSH SHA256 format and key type is read", () => {
  const key = keyBlob("ssh-ed25519", "abc");
  assert.match(hostKeyFingerprint(key), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(hostKeyType(key), "ssh-ed25519");
  assert.equal(knownHostId("MyHost.Example", 22), "myhost.example:22");
  assert.equal(knownHostId("::1", 2222), "[::1]:2222");
});

test("first use records the key, same key is trusted", async () => {
  const filePath = await tempFile();
  const key = keyBlob("ssh-ed25519", "one");
  const first = await checkHostKey({ host: "ibmi", port: 22, key, filePath, acceptNew: "" });
  assert.equal(first.status, "added");
  const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(stored.hosts["ibmi:22"].fingerprint, hostKeyFingerprint(key));
  assert.equal(stored.hosts["ibmi:22"].keyType, "ssh-ed25519");
  const second = await checkHostKey({ host: "IBMI", port: 22, key, filePath, acceptNew: "" });
  assert.equal(second.status, "trusted");
  // A different port is a different entry.
  const other = await checkHostKey({ host: "ibmi", port: 2222, key: keyBlob("ssh-rsa", "x"), filePath, acceptNew: "" });
  assert.equal(other.status, "added");
});

test("changed key is refused unless explicitly accepted", async () => {
  const filePath = await tempFile();
  await checkHostKey({ host: "ibmi", port: 22, key: keyBlob("ssh-ed25519", "old"), filePath, acceptNew: "" });
  const newKey = keyBlob("ssh-ed25519", "new");
  await assert.rejects(
    checkHostKey({ host: "ibmi", port: 22, key: newKey, filePath, acceptNew: "" }),
    err => err instanceof HostKeyMismatchError && /has changed/.test(err.message) && err.message.includes("MCP_FOR_I_ACCEPT_NEW_HOSTKEY")
  );
  await assert.rejects(checkHostKey({ host: "ibmi", port: 22, key: newKey, filePath, acceptNew: "otherhost:22" }), HostKeyMismatchError);
  const accepted = await checkHostKey({ host: "ibmi", port: 22, key: newKey, filePath, acceptNew: "ibmi:22" });
  assert.equal(accepted.status, "replaced");
  const after = await checkHostKey({ host: "ibmi", port: 22, key: newKey, filePath, acceptNew: "" });
  assert.equal(after.status, "trusted");
});

test("accept setting forms", () => {
  const fp = "SHA256:abc";
  assert.equal(isNewHostKeyAccepted("1", "h", 22, fp), true);
  assert.equal(isNewHostKeyAccepted("h", "H", 22, fp), true);
  assert.equal(isNewHostKeyAccepted("x, h:22", "h", 22, fp), true);
  assert.equal(isNewHostKeyAccepted("h:2222", "h", 22, fp), false);
  assert.equal(isNewHostKeyAccepted("SHA256:abc", "h", 22, fp), true);
  assert.equal(isNewHostKeyAccepted("SHA256:zzz", "h", 22, fp), false);
  assert.equal(isNewHostKeyAccepted(undefined, "h", 22, fp), false);
});

test("a corrupt known hosts file refuses instead of forgetting keys", async () => {
  const filePath = await tempFile();
  await fs.writeFile(filePath, "{not json");
  await assert.rejects(checkHostKey({ host: "h", port: 22, key: keyBlob("ssh-rsa", "k"), filePath, acceptNew: "" }), /not valid JSON/);
});
