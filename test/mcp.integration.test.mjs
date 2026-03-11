import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const host = process.env.IBMI_HOST;
const username = process.env.IBMI_USER;
const privateKeyPath = process.env.IBMI_PRIVATE_KEY;
const port = process.env.IBMI_PORT ? Number(process.env.IBMI_PORT) : 22;
const connName = process.env.IBMI_CONN_NAME || "itest";
const allowWrite = process.env.IBMI_TEST_ALLOW_WRITE === "1";
const preconfiguredConnection = process.env.IBMI_TEST_PRECONFIGURED === "1";
const keepArtifacts = process.env.IBMI_TEST_KEEP === "1";
const enableSourceDates = process.env.IBMI_TEST_SOURCE_DATES === "1";
const runDebug = process.env.IBMI_TEST_DEBUG === "1";
const runSetCcsid = process.env.IBMI_TEST_SETCCSID === "1";
const tempLibrary = (process.env.IBMI_TEST_TEMP_LIB || "ILEDITOR").toUpperCase();
const canProvisionViaTool = Boolean(host && username && privateKeyPath);
const skipAll = !allowWrite || (!preconfiguredConnection && !canProvisionViaTool);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

let client;
let transport;
let testLib;
let testSrcFile;
let memberA;
let memberB;
let remoteBase;
let remoteSrc;
let remoteUpload;
let remoteDeploy;
let localTemp;
let localFile;
let localDownload;
let localDeploy;
let localDeployFile;

function getText(res) {
  return res?.content?.[0]?.text ?? "";
}

function getJson(res) {
  const text = getText(res);
  if (!text) return null;
  return JSON.parse(text);
}

function makeLibName() {
  if (process.env.IBMI_TEST_LIB) return process.env.IBMI_TEST_LIB.toUpperCase();
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `MCP${suffix}`.toUpperCase();
}

function makeMemberName(prefix) {
  const suffix = String(Math.floor(Math.random() * 900) + 100);
  return `${prefix}${suffix}`.slice(0, 10).toUpperCase();
}

async function safe(call) {
  try {
    await call();
  } catch {
    // ignore cleanup errors
  }
}

async function callTool(name, args = {}) {
  if (!client) throw new Error("MCP client not initialized");
  return client.callTool({ name, arguments: args });
}

let chain = Promise.resolve();
function serialTest(name, fn, options = {}) {
  const skip = Boolean(skipAll || options.skip);
  test(name, { skip }, async () => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  });
}

test.before(async () => {
  if (skipAll) return;
  const serverPath = path.join(rootDir, "dist", "index.js");
  const env = {};
  if (process.env.MCP_FOR_I_LOG_ENABLED) env.MCP_FOR_I_LOG_ENABLED = process.env.MCP_FOR_I_LOG_ENABLED;
  if (process.env.MCP_FOR_I_LOG_LEVEL) env.MCP_FOR_I_LOG_LEVEL = process.env.MCP_FOR_I_LOG_LEVEL;
  if (process.env.MCP_FOR_I_LOG) env.MCP_FOR_I_LOG = process.env.MCP_FOR_I_LOG;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env
  });
  client = new Client({ name: "mcp-for-i-test", version: "0.0.0" });
  await client.connect(transport);

  testLib = makeLibName();
  testSrcFile = (process.env.IBMI_TEST_SRC_FILE || "MCPSRC").toUpperCase();
  memberA = makeMemberName("MBR");
  memberB = makeMemberName("MBR");

  remoteBase = process.env.IBMI_TEST_IFS_BASE || `/tmp/mcp-for-i-test-${Date.now()}`;
  remoteSrc = `${remoteBase}/hello.clle`;
  remoteUpload = `${remoteBase}/upload.txt`;
  remoteDeploy = `${remoteBase}/deploy`;

  localTemp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-"));
  localFile = path.join(localTemp, "local.txt");
  localDownload = path.join(localTemp, "download.txt");
  localDeploy = path.join(localTemp, "deploy");
  localDeployFile = path.join(localDeploy, "a.txt");

  await fs.writeFile(localFile, "hello from local", "utf8");
  await fs.mkdir(localDeploy, { recursive: true });
  await fs.writeFile(localDeployFile, "deploy file", "utf8");
});

test.after(async () => {
  if (skipAll) return;
  if (!keepArtifacts) {
    await safe(() => callTool("ibmi.ifs.delete", { path: remoteBase, recursive: true }));
    await safe(() => callTool("ibmi.actions.run", {
      action: { name: "MCP Delete Library", command: "DLTLIB LIB(&CURLIB)", environment: "ile" },
      targetType: "streamfile",
      targetPath: remoteSrc
    }));
  }
  await safe(() => callTool("ibmi.disconnect", {}));
  if (!preconfiguredConnection) {
    await safe(() => callTool("ibmi.connections.delete", { name: connName }));
  }
  if (client) {
    await client.close();
  }
  if (localTemp) {
    await safe(() => fs.rm(localTemp, { recursive: true, force: true }));
  }
});

serialTest("ibmi.connections.add", async () => {
  await callTool("ibmi.connections.add", {
    name: connName,
    host,
    port,
    username,
    privateKeyPath,
    settings: { tempLibrary, enableSourceDates },
    policy: { profile: "power-user" }
  });
}, { skip: preconfiguredConnection });

serialTest("ibmi.connections.list", async () => {
  const list = getJson(await callTool("ibmi.connections.list")) || [];
  assert.ok(Array.isArray(list));
});

serialTest("ibmi.connections.update", async () => {
  await callTool("ibmi.connections.update", { name: connName, port });
}, { skip: preconfiguredConnection });

serialTest("ibmi.connect", async () => {
  await callTool("ibmi.connect", { name: connName });
});

serialTest("ibmi.qsys.libraries.create", async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await callTool("ibmi.qsys.libraries.create", { library: testLib });
      break;
    } catch (err) {
      if (process.env.IBMI_TEST_LIB) throw err;
      if (i === 2) throw err;
      testLib = makeLibName();
    }
  }
});

serialTest("ibmi.libl.set", async () => {
  await callTool("ibmi.libl.set", { currentLibrary: testLib, libraryList: [testLib], applyToJob: true });
});

serialTest("ibmi.qsys.sourcefiles.create", async () => {
  await callTool("ibmi.qsys.sourcefiles.create", { library: testLib, sourceFile: testSrcFile, rcdlen: 112 });
});

serialTest("ibmi.qsys.members.create", async () => {
  await callTool("ibmi.qsys.members.create", { library: testLib, sourceFile: testSrcFile, member: memberA, srctype: "RPGLE" });
});

serialTest("ibmi.qsys.members.rename", async () => {
  await callTool("ibmi.qsys.members.rename", { library: testLib, sourceFile: testSrcFile, member: memberA, newMember: memberB });
});

serialTest("ibmi.qsys.members.write", async () => {
  await callTool("ibmi.qsys.members.write", {
    library: testLib,
    sourceFile: testSrcFile,
    member: memberB,
    content: "**free\nctl-opt dftactgrp(*no) actgrp(*caller);\ndsply 'HELLO';\n*inlr = *on;\n"
  });
});

serialTest("ibmi.qsys.members.read", async () => {
  const memberRead = getText(await callTool("ibmi.qsys.members.read", { library: testLib, sourceFile: testSrcFile, member: memberB }));
  assert.ok(memberRead.includes("HELLO"));
});

serialTest("ibmi.search.members", async () => {
  await callTool("ibmi.search.members", { library: testLib, sourceFile: testSrcFile, term: "HELLO", members: memberB });
});

serialTest("ibmi.qsys.members.list", async () => {
  await callTool("ibmi.qsys.members.list", { library: testLib, sourceFile: testSrcFile });
});

serialTest("ibmi.qsys.sourcefiles.list", async () => {
  await callTool("ibmi.qsys.sourcefiles.list", { library: testLib });
});

serialTest("ibmi.qsys.objects.list", async () => {
  await callTool("ibmi.qsys.objects.list", { library: testLib, types: ["*ALL"] });
});

serialTest("ibmi.qsys.libraries.list", async () => {
  await callTool("ibmi.qsys.libraries.list", { filter: testLib });
});

serialTest("ibmi.resolve.path (member)", async () => {
  await callTool("ibmi.resolve.path", { path: `${testLib}/${testSrcFile}/${memberB}` });
});

serialTest("ibmi.ifs.mkdir", async () => {
  await callTool("ibmi.ifs.mkdir", { path: remoteBase });
});

serialTest("ibmi.ifs.write", async () => {
  await callTool("ibmi.ifs.write", {
    path: remoteSrc,
    content: "PGM\nSNDPGMMSG MSG('HELLO')\nENDPGM\n"
  });
});

serialTest("ibmi.ifs.read", async () => {
  const ifsRead = getText(await callTool("ibmi.ifs.read", { path: remoteSrc }));
  assert.ok(ifsRead.includes("HELLO"));
});

serialTest("ibmi.actions.run (compile CL)", async () => {
  const result = getJson(await callTool("ibmi.actions.run", {
    actionName: "Create Bound CL Program",
    targetType: "streamfile",
    targetPath: remoteSrc
  }));
  assert.ok(result && typeof result.code === "number");
});

serialTest("ibmi.actions.run (simple command)", async () => {
  const result = getJson(await callTool("ibmi.actions.run", {
    action: { name: "MCP DSPLIBL", command: "DSPLIBL", environment: "ile" },
    targetType: "streamfile",
    targetPath: remoteSrc
  }));
  assert.ok(result && typeof result.code === "number");
});

serialTest("ibmi.ifs.upload", async () => {
  await callTool("ibmi.ifs.upload", { localPath: localFile, remotePath: remoteUpload });
});

serialTest("ibmi.ifs.download", async () => {
  await callTool("ibmi.ifs.download", { localPath: localDownload, remotePath: remoteUpload });
});

serialTest("ibmi.ifs.list", async () => {
  await callTool("ibmi.ifs.list", { path: remoteBase });
});

serialTest("ibmi.search.ifs", async () => {
  await callTool("ibmi.search.ifs", { path: remoteBase, term: "HELLO" });
});

serialTest("ibmi.find.ifs (no matches)", async () => {
  const res = getJson(await callTool("ibmi.find.ifs", { path: remoteBase, term: "no_such_file_12345" }));
  assert.ok(res && Array.isArray(res.hits));
  assert.equal(res.hits.length, 0);
});

serialTest("ibmi.deploy.uploadDirectory", async () => {
  await callTool("ibmi.deploy.uploadDirectory", { localPath: localDeploy, remotePath: remoteDeploy });
});

serialTest("ibmi.deploy.uploadFiles", async () => {
  await callTool("ibmi.deploy.uploadFiles", { localFiles: [localFile], remoteDirectory: remoteBase });
});

serialTest("ibmi.deploy.compare", async () => {
  await callTool("ibmi.deploy.compare", { localPath: localDeploy, remotePath: remoteDeploy });
});

serialTest("ibmi.deploy.sync", async () => {
  await callTool("ibmi.deploy.sync", { localPath: localDeploy, remotePath: remoteDeploy, overwrite: false });
});

serialTest("ibmi.filters.save", async () => {
  await callTool("ibmi.filters.save", { filter: { name: "MCPTEST", library: testLib, object: "*", types: ["*ALL"], member: "*" } });
});

serialTest("ibmi.filters.list", async () => {
  await callTool("ibmi.filters.list");
});

serialTest("ibmi.filters.delete", async () => {
  await callTool("ibmi.filters.delete", { name: "MCPTEST" });
});

serialTest("ibmi.ifs.shortcuts.add", async () => {
  await callTool("ibmi.ifs.shortcuts.add", { path: remoteBase });
});

serialTest("ibmi.ifs.shortcuts.list", async () => {
  await callTool("ibmi.ifs.shortcuts.list");
});

serialTest("ibmi.ifs.shortcuts.delete", async () => {
  await callTool("ibmi.ifs.shortcuts.delete", { path: remoteBase });
});

serialTest("ibmi.profiles.save", async () => {
  await callTool("ibmi.profiles.save", { profile: { name: "mcp-test", currentLibrary: testLib, libraryList: [testLib] } });
});

serialTest("ibmi.profiles.list", async () => {
  await callTool("ibmi.profiles.list");
});

serialTest("ibmi.profiles.activate", async () => {
  await callTool("ibmi.profiles.activate", { name: "mcp-test", applyToJob: true });
});

serialTest("ibmi.profiles.delete", async () => {
  await callTool("ibmi.profiles.delete", { name: "mcp-test" });
});

serialTest("ibmi.libl.get", async () => {
  await callTool("ibmi.libl.get");
});

serialTest("ibmi.libl.validate", async () => {
  await callTool("ibmi.libl.validate", { libraryList: [testLib] });
});

serialTest("ibmi.libl.add", async () => {
  await callTool("ibmi.libl.add", { library: testLib, applyToJob: true });
});

serialTest("ibmi.libl.remove", async () => {
  await callTool("ibmi.libl.remove", { library: testLib, applyToJob: true });
});

serialTest("ibmi.libl.setCurrent", async () => {
  await callTool("ibmi.libl.setCurrent", { library: "QGPL", applyToJob: true });
});

serialTest("ibmi.actions.list", async () => {
  await callTool("ibmi.actions.list");
});

serialTest("ibmi.actions.save", async () => {
  await callTool("ibmi.actions.save", { action: { name: "MCPTEST ACTION", command: "DSPLIBL", environment: "ile" } });
});

serialTest("ibmi.actions.delete", async () => {
  await callTool("ibmi.actions.delete", { name: "MCPTEST ACTION" });
});

serialTest("ibmi.deploy.setCcsid", async () => {
  await callTool("ibmi.deploy.setCcsid", { remotePath: remoteBase, ccsid: "1208" });
}, { skip: !runSetCcsid });

serialTest("ibmi.debug.status", async () => {
  await callTool("ibmi.debug.status");
});

serialTest("ibmi.debug.startService", async () => {
  await callTool("ibmi.debug.startService");
}, { skip: !runDebug });

serialTest("ibmi.debug.stopService", async () => {
  await callTool("ibmi.debug.stopService");
}, { skip: !runDebug });

serialTest("ibmi.qsys.members.delete", async () => {
  await callTool("ibmi.qsys.members.delete", { library: testLib, sourceFile: testSrcFile, member: memberB });
});

serialTest("ibmi.actions.run (delete source file)", async () => {
  await callTool("ibmi.actions.run", {
    action: {
      name: "MCP Delete Source File",
      command: "DLTF FILE(&LIBRARY/&SRCFILE)",
      environment: "ile"
    },
    targetType: "member",
    library: testLib,
    sourceFile: testSrcFile,
    member: memberB
  });
});

serialTest("ibmi.actions.run (delete library)", async () => {
  await callTool("ibmi.actions.run", {
    action: {
      name: "MCP Delete Library",
      command: "DLTLIB LIB(&CURLIB)",
      environment: "ile"
    },
    targetType: "streamfile",
    targetPath: remoteSrc
  });
});

serialTest("ibmi.ifs.delete", async () => {
  await callTool("ibmi.ifs.delete", { path: remoteBase, recursive: true });
});

serialTest("ibmi.qsys.libraries.list (verify cleanup)", async () => {
  const libs = getJson(await callTool("ibmi.qsys.libraries.list", { filter: testLib })) || [];
  assert.equal(libs.length, 0);
});

serialTest("ibmi.resolve.path (verify cleanup)", async () => {
  const resolve = getJson(await callTool("ibmi.resolve.path", { path: remoteBase }));
  assert.ok(resolve && resolve.exists === false);
});

serialTest("ibmi.disconnect", async () => {
  await callTool("ibmi.disconnect");
});

serialTest("ibmi.connections.delete", async () => {
  await callTool("ibmi.connections.delete", { name: connName });
}, { skip: preconfiguredConnection });
