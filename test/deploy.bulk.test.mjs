import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { handleTool } from "../dist/mcp/tools.js";
import { parseRemoteHashOutput, parseGitPorcelainZ, normalizeDeploySelection } from "../dist/mcp/deployMethods.js";

// Temp directories live under os.tmpdir(). On Windows that is inside the
// home directory and allowed by the local path guard's default roots; on
// systems where it is not, allow it explicitly for these tests.
const homeRelative = path.relative(os.homedir(), await fs.realpath(os.tmpdir()));
if (homeRelative.startsWith("..") || path.isAbsolute(homeRelative)) {
  process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = await fs.realpath(os.tmpdir());
}

const sha = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split("/"));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
}

function context(conn, policy = { profile: "power-user" }) {
  return { store: {}, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => policy };
}

function data(response) {
  return response.structuredContent.data;
}

// ---- deploy methods ----

// Fake IBM i holding an IFS tree under remoteRoot; answers find and the
// batched sha256sum command.
function fakeDeployConn(remoteRoot, remoteFiles, options = {}) {
  const calls = { commands: [], puts: [] };
  const conn = {
    currentConnectionName: "DEV",
    remoteFeatures: { find: "/usr/bin/find" },
    getConfig: () => ({ readOnlyMode: Boolean(options.readOnly) }),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async sendCommand({ command }) {
      calls.commands.push(command);
      if (command.includes(" -type f -print")) {
        return { code: 0, stdout: Object.keys(remoteFiles).map(rel => `${remoteRoot}/${rel}`).join("\n"), stderr: "" };
      }
      if (command.includes("sha256sum")) {
        if (options.noHashTool) return { code: 127, stdout: "", stderr: "MCPFORI_NO_SHA256_TOOL" };
        const quoted = [...command.matchAll(/'\.\/((?:[^']|'"'"')*)'/g)].map(match => match[1].replace(/'"'"'/g, "'"));
        const lines = quoted
          .filter(rel => rel in remoteFiles)
          .map(rel => `${sha(remoteFiles[rel])}  ./${rel}`);
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    client: {
      async putFile(local, remote) {
        calls.puts.push({ local, remote });
      }
    },
    content: {}
  };
  return { conn, calls };
}

test("parseRemoteHashOutput reads sha256sum and openssl formats with spaces in names", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const c = "c".repeat(64);
  const map = parseRemoteHashOutput(`${a}  ./dir with space/x.txt\n${b} *./y.txt\nSHA256(./z z.txt)= ${c}\n`);
  assert.equal(map.get("dir with space/x.txt"), a);
  assert.equal(map.get("y.txt"), "b".repeat(64));
  assert.equal(map.get("z z.txt"), c);
});

test("deploy.sync method changed uploads only files whose SHA-256 differs", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, {
    "same.txt": "same",
    "sp ace.txt": "same too",
    "differ.txt": "abcd",
    "dir with space/new.txt": "new"
  });
  const remoteRoot = "/home/dev/app";
  const { conn, calls } = fakeDeployConn(remoteRoot, {
    "same.txt": "same",
    "sp ace.txt": "same too",
    "differ.txt": "wxyz",
    "extra.txt": "remote only"
  });
  const response = await handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: remoteRoot, method: "changed" });
  const result = data(response);
  assert.equal(result.mode.method, "changed");
  assert.deepEqual(result.planned.upload, ["differ.txt", "dir with space/new.txt"]);
  assert.deepEqual(result.applied.uploaded, ["differ.txt", "dir with space/new.txt"]);
  assert.equal(result.summary.unchanged, 2);
  assert.equal(result.summary.uploaded, 2);
  assert.equal(result.comparison.comparedBy, "sha256");
  assert.equal(result.comparison.changed[0].reason, "content_mismatch");
  // One hashing call covered every shared file, with the space-containing name quoted.
  const hashCalls = calls.commands.filter(command => command.includes("sha256sum"));
  assert.equal(hashCalls.length, 1);
  assert.match(hashCalls[0], /'\.\/sp ace\.txt'/);
  assert.match(hashCalls[0], /openssl dgst -sha256 -r/);
  assert.deepEqual(calls.puts.map(put => put.remote), [`${remoteRoot}/differ.txt`, `${remoteRoot}/dir with space/new.txt`]);
  assert.ok(!calls.commands.some(command => command.startsWith("rm ")));
});

test("deploy.compare method changed reports content differences without uploading", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, { "a.txt": "1234" });
  const { conn, calls } = fakeDeployConn("/r", { "a.txt": "5678" });
  const result = data(await handleTool(context(conn), "ibmi.deploy.compare", { localPath: local, remotePath: "/r", method: "changed" }));
  assert.equal(result.summary.changed, 1);
  assert.equal(result.summary.identical, 0);
  assert.equal(calls.puts.length, 0);
});

test("deploy.sync method changed fails clearly without a remote hash tool", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, { "a.txt": "1" });
  const { conn } = fakeDeployConn("/r", { "a.txt": "1" }, { noHashTool: true });
  await assert.rejects(
    handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: "/r", method: "changed" }),
    /No SHA-256 tool/
  );
});

test("deploy.sync method all keeps the original size-based behavior", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, { "a.txt": "1234", "b.txt": "new" });
  const { conn, calls } = fakeDeployConn("/r", { "a.txt": "5678" });
  const result = data(await handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: "/r" }));
  assert.equal(result.mode.method, "all");
  assert.deepEqual(result.planned.upload, ["b.txt"]);
  // Without a remote stat the size of a.txt is unknown, so it is skipped.
  assert.deepEqual(result.planned.unresolved, ["a.txt"]);
  assert.equal(result.summary.skipped, 1);
  assert.ok(!calls.commands.some(command => command.includes("sha256sum")));
});

test("deploy.sync method selection uploads only listed files and rejects unsafe paths", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, { "a.txt": "1", "sub/b.txt": "2", "c.txt": "3" });
  const { conn, calls } = fakeDeployConn("/r", {});
  const response = await handleTool(context(conn), "ibmi.deploy.sync", {
    localPath: local,
    remotePath: "/r",
    method: "selection",
    files: ["sub\\b.txt", "a.txt", "missing.txt"]
  });
  assert.equal(response.isError, true);
  const result = response.structuredContent.data;
  assert.deepEqual(result.applied.uploaded, ["a.txt", "sub/b.txt"]);
  assert.deepEqual(result.errors.map(error => error.path), ["missing.txt"]);
  assert.equal(calls.puts.length, 2);
  // No remote listing is needed for an explicit selection.
  assert.ok(!calls.commands.some(command => command.includes("-type f")));

  assert.throws(() => normalizeDeploySelection(["../x.txt"]), /must not contain/);
  assert.throws(() => normalizeDeploySelection(["/etc/passwd"]), /relative/);
  assert.throws(() => normalizeDeploySelection([]), /non-empty/);
  await assert.rejects(
    handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: "/r", method: "selection", files: ["a.txt"], deleteExtraRemote: true }),
    /deleteExtraRemote/
  );
  await assert.rejects(handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: "/r", method: "bogus" }), /Invalid method/);
});

test("deploy.sync keeps the write gate for every method", async () => {
  const local = await tempDir("mcp-for-i-deploy-");
  await writeTree(local, { "a.txt": "1" });
  const { conn, calls } = fakeDeployConn("/r", {}, { readOnly: true });
  await assert.rejects(
    handleTool(context(conn), "ibmi.deploy.sync", { localPath: local, remotePath: "/r", method: "selection", files: ["a.txt"] }),
    /read-only/
  );
  assert.equal(calls.puts.length, 0);
});

test("parseGitPorcelainZ handles renames and untracked entries", () => {
  const entries = parseGitPorcelainZ(" M a.txt\0R  new name.txt\0old name.txt\0?? dir/u.txt\0");
  assert.deepEqual(entries, [
    { status: " M", path: "a.txt" },
    { status: "R ", path: "new name.txt" },
    { status: "??", path: "dir/u.txt" }
  ]);
});

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}

test("deploy.sync method gitChanged uploads staged, unstaged and untracked files under localPath", { skip: !gitAvailable }, async () => {
  const repo = await tempDir("mcp-for-i-git-");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  await writeTree(repo, {
    "app/modified.txt": "v1",
    "app/staged.txt": "v1",
    "app/same.txt": "v1",
    "app/gone.txt": "v1",
    "other/outside.txt": "v1"
  });
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  await writeTree(repo, {
    "app/modified.txt": "v2",
    "app/staged.txt": "v2",
    "app/new dir/untracked.txt": "u",
    "other/outside.txt": "v2"
  });
  git("add", "app/staged.txt");
  await fs.rm(path.join(repo, "app", "gone.txt"));

  const { conn, calls } = fakeDeployConn("/r", {});
  const result = data(await handleTool(context(conn), "ibmi.deploy.sync", {
    localPath: path.join(repo, "app"),
    remotePath: "/r",
    method: "gitChanged"
  }));
  assert.deepEqual(result.planned.upload, ["modified.txt", "new dir/untracked.txt", "staged.txt"]);
  assert.deepEqual(result.planned.gitDeleted, ["gone.txt"]);
  assert.equal(result.summary.skipped, 1);
  assert.deepEqual(calls.puts.map(put => put.remote), ["/r/modified.txt", "/r/new dir/untracked.txt", "/r/staged.txt"]);
});

// ---- bulk member download/upload ----

function fakeMemberConn(initial, options = {}) {
  const remote = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
  let clock = 0;
  const stamp = () => `2026-01-01 00:00:${String(++clock).padStart(2, "0")}.000000`;
  for (const value of remote.values()) value.lastChanged = value.lastChanged || stamp();
  const calls = { snapshots: [], uploads: [], creates: [], invalidated: [], metadata: [], sql: [] };
  const keyOf = (lib, file, mbr) => `${lib}/${file}/${mbr}`.toUpperCase();
  const snapshotOf = (lib, file, mbr) => {
    const entry = remote.get(keyOf(lib, file, mbr));
    if (!entry) throw new Error(`${mbr} in ${lib}/${file} not found`);
    const hash = sha(entry.content);
    return {
      identity: { library: lib, sourceFile: file, member: mbr },
      content: entry.content,
      sha256: hash,
      version: `${entry.lastChanged}:${hash.slice(0, 16)}`,
      metadata: { name: mbr, extension: entry.type, text: entry.text || "", lastChanged: entry.lastChanged }
    };
  };
  const conn = {
    currentConnectionName: "DEV",
    remoteFeatures: {},
    getConfig: () => ({ readOnlyMode: Boolean(options.readOnly) }),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      const files = new Set([...remote.keys()].map(key => key.split("/")[1]));
      return [...files].sort().map(name => ({ SYSTEM_TABLE_NAME: name }));
    },
    async sendCommand() {
      return { code: 0, stdout: "", stderr: "" };
    },
    content: {
      async getMemberListPage({ library, sourceFile, limit, cursor }) {
        const names = [...remote.keys()]
          .filter(key => key.startsWith(`${library}/${sourceFile}/`))
          .map(key => key.split("/")[2])
          .sort()
          .filter(name => !cursor || name > cursor);
        const items = names.slice(0, limit).map(name => {
          const entry = remote.get(keyOf(library, sourceFile, name));
          return { name, extension: entry.type, text: entry.text || "" };
        });
        const hasMore = names.length > limit;
        return { items, returned: items.length, hasMore, ...(hasMore ? { nextCursor: items.at(-1).name } : {}) };
      },
      async getMemberSnapshot(lib, file, mbr, forceFresh) {
        calls.snapshots.push({ key: keyOf(lib, file, mbr), forceFresh });
        return snapshotOf(lib, file, mbr);
      },
      async getMemberMetadata(lib, file, mbr) {
        calls.metadata.push(keyOf(lib, file, mbr));
        const entry = remote.get(keyOf(lib, file, mbr));
        return entry ? { name: mbr, extension: entry.type, text: entry.text || "", lastChanged: entry.lastChanged } : undefined;
      },
      async createMember(lib, file, mbr, srctype) {
        calls.creates.push({ key: keyOf(lib, file, mbr), srctype });
        remote.set(keyOf(lib, file, mbr), { content: "", type: srctype || "", lastChanged: stamp() });
      },
      async uploadMemberContent(lib, file, mbr, content) {
        calls.uploads.push({ key: keyOf(lib, file, mbr), content });
        const entry = remote.get(keyOf(lib, file, mbr));
        entry.content = String(content);
        entry.lastChanged = stamp();
      },
      invalidateMemberSnapshot(lib, file, mbr) {
        calls.invalidated.push(keyOf(lib, file, mbr));
      }
    }
  };
  return { conn, calls, remote, stamp };
}

const MEMBERS = {
  "DEVLIB/QRPGLESRC/ORDERS": { content: "**free\ndcl-s x int(10);\n", type: "RPGLE", text: "Orders" },
  "DEVLIB/QRPGLESRC/$UTIL": { content: "**free\n", type: "SQLRPGLE" },
  "DEVLIB/QCLSRC/START": { content: "PGM\nENDPGM\n", type: "CLLE" },
  "DEVLIB/QTXTSRC/NOTES": { content: "plain", type: "" }
};

test("members.downloadAll writes a LIB/FILE/MEMBER.ext tree and a manifest", async () => {
  const root = await tempDir("mcp-for-i-members-");
  const { conn, calls } = fakeMemberConn(MEMBERS);
  const result = data(await handleTool(context(conn), "ibmi.members.downloadAll", { localPath: root, library: "devlib" }));
  assert.equal(result.summary.downloaded, 4);
  assert.deepEqual(result.sourceFiles, ["QCLSRC", "QRPGLESRC", "QTXTSRC"]);
  assert.match(calls.sql[0], /FILE_TYPE='S'/);
  assert.equal(await fs.readFile(path.join(root, "DEVLIB", "QRPGLESRC", "ORDERS.rpgle"), "utf8"), MEMBERS["DEVLIB/QRPGLESRC/ORDERS"].content);
  assert.ok(await fs.stat(path.join(root, "DEVLIB", "QRPGLESRC", "$UTIL.sqlrpgle")));
  assert.ok(await fs.stat(path.join(root, "DEVLIB", "QCLSRC", "START.clle")));
  assert.ok(await fs.stat(path.join(root, "DEVLIB", "QTXTSRC", "NOTES.mbr")));
  assert.ok(calls.snapshots.every(call => call.forceFresh === true));

  const manifest = JSON.parse(await fs.readFile(path.join(root, ".mcp-for-i-members.json"), "utf8"));
  const entry = manifest.members["DEVLIB/QRPGLESRC/ORDERS"];
  assert.equal(entry.sha256, sha(MEMBERS["DEVLIB/QRPGLESRC/ORDERS"].content));
  assert.equal(entry.sourceType, "RPGLE");
  assert.equal(entry.path, "DEVLIB/QRPGLESRC/ORDERS.rpgle");
  assert.match(entry.version, /:/);
});

test("members.downloadAll caps the member count and keeps local edits", async () => {
  const root = await tempDir("mcp-for-i-members-");
  const { conn } = fakeMemberConn(MEMBERS);
  const ctx = context(conn);
  const capped = data(await handleTool(ctx, "ibmi.members.downloadAll", { localPath: root, library: "DEVLIB", sourceFile: "QRPGLESRC", maxMembers: 1 }));
  assert.equal(capped.truncated, true);
  assert.equal(capped.summary.downloaded, 1);

  await handleTool(ctx, "ibmi.members.downloadAll", { localPath: root, library: "DEVLIB", sourceFile: "QRPGLESRC" });
  const file = path.join(root, "DEVLIB", "QRPGLESRC", "ORDERS.rpgle");
  await fs.writeFile(file, "local edit\n", "utf8");
  const again = data(await handleTool(ctx, "ibmi.members.downloadAll", { localPath: root, library: "DEVLIB", sourceFile: "QRPGLESRC" }));
  assert.deepEqual(again.skipped.map(item => item.path), ["DEVLIB/QRPGLESRC/ORDERS.rpgle"]);
  assert.equal(again.summary.unchanged, 1);
  assert.equal(await fs.readFile(file, "utf8"), "local edit\n");

  const forced = data(await handleTool(ctx, "ibmi.members.downloadAll", { localPath: root, library: "DEVLIB", sourceFile: "QRPGLESRC", overwrite: true }));
  assert.equal(forced.summary.downloaded, 1);
  assert.equal(await fs.readFile(file, "utf8"), MEMBERS["DEVLIB/QRPGLESRC/ORDERS"].content);
});

test("members.uploadChanged uploads edited members, creates new ones and refuses conflicts", async () => {
  const root = await tempDir("mcp-for-i-members-");
  const { conn, calls, remote, stamp } = fakeMemberConn(MEMBERS);
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.members.downloadAll", { localPath: root, library: "DEVLIB" });
  calls.metadata.length = 0;

  // Edited locally (CRLF line endings are normalized before hashing/upload).
  await fs.writeFile(path.join(root, "DEVLIB", "QRPGLESRC", "ORDERS.rpgle"), "**free\r\ndcl-s y int(10);\r\n", "utf8");
  // Edited locally and changed on the IBM i since download: a conflict.
  await fs.writeFile(path.join(root, "DEVLIB", "QCLSRC", "START.clle"), "PGM\n/* local */\nENDPGM\n", "utf8");
  const start = remote.get("DEVLIB/QCLSRC/START");
  start.content = "PGM\n/* remote */\nENDPGM\n";
  start.lastChanged = stamp();
  // New member that does not exist remotely yet.
  await fs.writeFile(path.join(root, "DEVLIB", "QRPGLESRC", "NEWPGM.sqlrpgle"), "**free\n", "utf8");

  const dry = await handleTool(ctx, "ibmi.members.uploadChanged", { localPath: root, dryRun: true });
  assert.equal(calls.uploads.length, 0);
  assert.deepEqual(dry.structuredContent.data.planned.map(item => item.path).sort(), [
    "DEVLIB/QRPGLESRC/NEWPGM.sqlrpgle",
    "DEVLIB/QRPGLESRC/ORDERS.rpgle"
  ]);

  const response = await handleTool(ctx, "ibmi.members.uploadChanged", { localPath: root });
  assert.equal(response.isError, true);
  const result = response.structuredContent.data;
  assert.equal(result.summary.uploaded, 2);
  assert.equal(result.summary.unchanged, 2);
  assert.deepEqual(result.conflicts.map(item => item.path), ["DEVLIB/QCLSRC/START.clle"]);
  assert.equal(remote.get("DEVLIB/QCLSRC/START").content, "PGM\n/* remote */\nENDPGM\n");
  assert.equal(remote.get("DEVLIB/QRPGLESRC/ORDERS").content, "**free\ndcl-s y int(10);\n");
  assert.deepEqual(calls.creates, [{ key: "DEVLIB/QRPGLESRC/NEWPGM", srctype: "SQLRPGLE" }]);
  assert.ok(calls.invalidated.includes("DEVLIB/QRPGLESRC/ORDERS"));
  assert.ok(calls.invalidated.includes("DEVLIB/QRPGLESRC/NEWPGM"));
  // Unchanged files never reached the IBM i.
  assert.ok(!calls.metadata.includes("DEVLIB/QTXTSRC/NOTES"));

  // The manifest now matches, so a second run uploads nothing.
  const second = await handleTool(ctx, "ibmi.members.uploadChanged", { localPath: root, sourceFile: "QRPGLESRC" });
  assert.equal(second.structuredContent.data.summary.uploaded, 0);
  assert.equal(second.structuredContent.data.summary.unchanged, 3);

  const forced = data(await handleTool(ctx, "ibmi.members.uploadChanged", { localPath: root, force: true }));
  assert.deepEqual(forced.uploaded.map(item => item.path), ["DEVLIB/QCLSRC/START.clle"]);
  assert.equal(remote.get("DEVLIB/QCLSRC/START").content, "PGM\n/* local */\nENDPGM\n");
});

test("members.uploadChanged enforces the write gate and library policy", async () => {
  const root = await tempDir("mcp-for-i-members-");
  await writeTree(root, { "DEVLIB/QRPGLESRC/ORDERS.rpgle": "x", "PRODLIB/QRPGLESRC/ORDERS.rpgle": "y" });
  const readOnly = fakeMemberConn({}, { readOnly: true });
  await assert.rejects(handleTool(context(readOnly.conn), "ibmi.members.uploadChanged", { localPath: root }), /read-only/);
  await assert.rejects(
    handleTool(context(readOnly.conn, { profile: "read-only" }), "ibmi.members.uploadChanged", { localPath: root }),
    /read-only/
  );

  const { conn, calls } = fakeMemberConn({});
  const response = await handleTool(context(conn, { profile: "power-user", denyLibraries: ["PRODLIB"] }), "ibmi.members.uploadChanged", { localPath: root });
  const result = response.structuredContent.data;
  assert.deepEqual(result.uploaded.map(item => item.path), ["DEVLIB/QRPGLESRC/ORDERS.rpgle"]);
  assert.match(result.skipped.find(item => item.path.startsWith("PRODLIB")).reason, /denyLibraries/);
  assert.deepEqual(calls.creates.map(item => item.key), ["DEVLIB/QRPGLESRC/ORDERS"]);
});
