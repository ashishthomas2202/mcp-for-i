import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpContext } from "../dist/mcp/context.js";
import { handleTool } from "../dist/mcp/tools.js";

const host = process.env.IBMI_HOST;
const username = process.env.IBMI_USER;
const password = process.env.IBMI_PASSWORD;
const privateKeyPath = process.env.IBMI_PRIVATE_KEY;
const port = process.env.IBMI_PORT ? Number(process.env.IBMI_PORT) : 22;
const connName = process.env.IBMI_CONN_NAME || "itest";
const allowWrite = process.env.IBMI_TEST_ALLOW_WRITE === "1";
const keepArtifacts = process.env.IBMI_TEST_KEEP === "1";
const enableSourceDates = process.env.IBMI_TEST_SOURCE_DATES === "1";
const runDebug = process.env.IBMI_TEST_DEBUG === "1";
const runSetCcsid = process.env.IBMI_TEST_SETCCSID === "1";
const tempLibrary = (process.env.IBMI_TEST_TEMP_LIB || "ILEDITOR").toUpperCase();

const hasConn = Boolean(host && username && (password || privateKeyPath));

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
  const suffix = String(Math.floor(Math.random() * 9000) + 1000); // 4 digits
  return `MCP${suffix}`.toUpperCase(); // 7 chars
}

function makeMemberName(prefix) {
  const suffix = String(Math.floor(Math.random() * 900) + 100); // 3 digits
  return `${prefix}${suffix}`.slice(0, 10).toUpperCase();
}

async function safe(call) {
  try {
    await call();
  } catch {
    // ignore cleanup errors
  }
}

test("IBM i integration (isolated, one test per tool)", { skip: !hasConn || !allowWrite }, async (t) => {
  const ctx = new McpContext();

  let testLib = makeLibName();
  const testSrcFile = (process.env.IBMI_TEST_SRC_FILE || "MCPSRC").toUpperCase();
  const memberA = makeMemberName("MBR");
  const memberB = makeMemberName("MBR");

  const remoteBase = process.env.IBMI_TEST_IFS_BASE || `/tmp/mcp-for-i-test-${Date.now()}`;
  const remoteSrc = `${remoteBase}/hello.clle`;
  const remoteUpload = `${remoteBase}/upload.txt`;
  const remoteDeploy = `${remoteBase}/deploy`;

  const localTemp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-"));
  const localFile = path.join(localTemp, "local.txt");
  const localDownload = path.join(localTemp, "download.txt");
  const localDeploy = path.join(localTemp, "deploy");
  const localDeployFile = path.join(localDeploy, "a.txt");

  await fs.writeFile(localFile, "hello from local", "utf8");
  await fs.mkdir(localDeploy, { recursive: true });
  await fs.writeFile(localDeployFile, "deploy file", "utf8");

  try {
    await t.test("ibmi.connections.add", async () => {
      await handleTool(ctx, "ibmi.connections.add", {
        name: connName,
        host,
        port,
        username,
        privateKeyPath,
        password,
        storePassword: true,
        settings: { tempLibrary, enableSourceDates }
      });
    });

    await t.test("ibmi.connections.list", async () => {
      const list = getJson(await handleTool(ctx, "ibmi.connections.list", {})) || [];
      assert.ok(Array.isArray(list));
    });

    await t.test("ibmi.connections.update", async () => {
      await handleTool(ctx, "ibmi.connections.update", { name: connName, port });
    });

    await t.test("ibmi.connect", async () => {
      await handleTool(ctx, "ibmi.connect", { name: connName });
    });

    await t.test("ibmi.qsys.libraries.create", async () => {
      for (let i = 0; i < 3; i++) {
        try {
          await handleTool(ctx, "ibmi.qsys.libraries.create", { library: testLib });
          break;
        } catch (err) {
          if (process.env.IBMI_TEST_LIB) throw err;
          if (i === 2) throw err;
          testLib = makeLibName();
        }
      }
    });

    await t.test("ibmi.libl.set", async () => {
      await handleTool(ctx, "ibmi.libl.set", { currentLibrary: testLib, libraryList: [testLib], applyToJob: true });
    });

    await t.test("ibmi.qsys.sourcefiles.create", async () => {
      await handleTool(ctx, "ibmi.qsys.sourcefiles.create", { library: testLib, sourceFile: testSrcFile, rcdlen: 112 });
    });

    await t.test("ibmi.qsys.members.create", async () => {
      await handleTool(ctx, "ibmi.qsys.members.create", { library: testLib, sourceFile: testSrcFile, member: memberA, srctype: "RPGLE" });
    });

    await t.test("ibmi.qsys.members.rename", async () => {
      await handleTool(ctx, "ibmi.qsys.members.rename", { library: testLib, sourceFile: testSrcFile, member: memberA, newMember: memberB });
    });

    await t.test("ibmi.qsys.members.write", async () => {
      await handleTool(ctx, "ibmi.qsys.members.write", {
        library: testLib,
        sourceFile: testSrcFile,
        member: memberB,
        content: "**free\nctl-opt dftactgrp(*no) actgrp(*caller);\ndsply 'HELLO';\n*inlr = *on;\n"
      });
    });

    await t.test("ibmi.qsys.members.read", async () => {
      const memberRead = getText(await handleTool(ctx, "ibmi.qsys.members.read", { library: testLib, sourceFile: testSrcFile, member: memberB }));
      assert.ok(memberRead.includes("HELLO"));
    });

    await t.test("ibmi.search.members", async () => {
      await handleTool(ctx, "ibmi.search.members", { library: testLib, sourceFile: testSrcFile, term: "HELLO", members: memberB });
    });

    await t.test("ibmi.qsys.members.list", async () => {
      await handleTool(ctx, "ibmi.qsys.members.list", { library: testLib, sourceFile: testSrcFile });
    });

    await t.test("ibmi.qsys.sourcefiles.list", async () => {
      await handleTool(ctx, "ibmi.qsys.sourcefiles.list", { library: testLib });
    });

    await t.test("ibmi.qsys.objects.list", async () => {
      await handleTool(ctx, "ibmi.qsys.objects.list", { library: testLib, types: ["*ALL"] });
    });

    await t.test("ibmi.qsys.libraries.list", async () => {
      await handleTool(ctx, "ibmi.qsys.libraries.list", { filter: testLib });
    });

    await t.test("ibmi.resolve.path (member)", async () => {
      await handleTool(ctx, "ibmi.resolve.path", { path: `${testLib}/${testSrcFile}/${memberB}` });
    });

    await t.test("ibmi.ifs.mkdir", async () => {
      await handleTool(ctx, "ibmi.ifs.mkdir", { path: remoteBase });
    });

    await t.test("ibmi.ifs.write", async () => {
      await handleTool(ctx, "ibmi.ifs.write", {
        path: remoteSrc,
        content: "PGM\nSNDPGMMSG MSG('HELLO')\nENDPGM\n"
      });
    });

    await t.test("ibmi.ifs.read", async () => {
      const ifsRead = getText(await handleTool(ctx, "ibmi.ifs.read", { path: remoteSrc }));
      assert.ok(ifsRead.includes("HELLO"));
    });

    await t.test("ibmi.actions.run", async () => {
      const actionResult = getJson(await handleTool(ctx, "ibmi.actions.run", {
        actionName: "Create Bound CL Program",
        targetType: "streamfile",
        targetPath: remoteSrc
      }));
      assert.ok(actionResult && typeof actionResult.code === "number");
    });

    await t.test("ibmi.ifs.upload", async () => {
      await handleTool(ctx, "ibmi.ifs.upload", { localPath: localFile, remotePath: remoteUpload });
    });

    await t.test("ibmi.ifs.download", async () => {
      await handleTool(ctx, "ibmi.ifs.download", { localPath: localDownload, remotePath: remoteUpload });
    });

    await t.test("ibmi.ifs.list", async () => {
      await handleTool(ctx, "ibmi.ifs.list", { path: remoteBase });
    });

    await t.test("ibmi.search.ifs", async () => {
      await handleTool(ctx, "ibmi.search.ifs", { path: remoteBase, term: "HELLO" });
    });

    await t.test("ibmi.find.ifs", async () => {
      await handleTool(ctx, "ibmi.find.ifs", { path: remoteBase, term: "*.txt" });
    });

    await t.test("ibmi.deploy.uploadDirectory", async () => {
      await handleTool(ctx, "ibmi.deploy.uploadDirectory", { localPath: localDeploy, remotePath: remoteDeploy });
    });

    await t.test("ibmi.deploy.uploadFiles", async () => {
      await handleTool(ctx, "ibmi.deploy.uploadFiles", { localFiles: [localFile], remoteDirectory: remoteBase });
    });

    await t.test("ibmi.deploy.compare", async () => {
      await handleTool(ctx, "ibmi.deploy.compare", { localPath: localDeploy, remotePath: remoteDeploy });
    });

    await t.test("ibmi.deploy.sync", async () => {
      await handleTool(ctx, "ibmi.deploy.sync", { localPath: localDeploy, remotePath: remoteDeploy, overwrite: false });
    });

    await t.test("ibmi.filters.save", async () => {
      await handleTool(ctx, "ibmi.filters.save", { filter: { name: "MCPTEST", library: testLib, object: "*", types: ["*ALL"], member: "*" } });
    });

    await t.test("ibmi.filters.list", async () => {
      await handleTool(ctx, "ibmi.filters.list", {});
    });

    await t.test("ibmi.filters.delete", async () => {
      await handleTool(ctx, "ibmi.filters.delete", { name: "MCPTEST" });
    });

    await t.test("ibmi.ifs.shortcuts.add", async () => {
      await handleTool(ctx, "ibmi.ifs.shortcuts.add", { path: remoteBase });
    });

    await t.test("ibmi.ifs.shortcuts.list", async () => {
      await handleTool(ctx, "ibmi.ifs.shortcuts.list", {});
    });

    await t.test("ibmi.ifs.shortcuts.delete", async () => {
      await handleTool(ctx, "ibmi.ifs.shortcuts.delete", { path: remoteBase });
    });

    await t.test("ibmi.profiles.save", async () => {
      await handleTool(ctx, "ibmi.profiles.save", { profile: { name: "mcp-test", currentLibrary: testLib, libraryList: [testLib] } });
    });

    await t.test("ibmi.profiles.list", async () => {
      await handleTool(ctx, "ibmi.profiles.list", {});
    });

    await t.test("ibmi.profiles.activate", async () => {
      await handleTool(ctx, "ibmi.profiles.activate", { name: "mcp-test", applyToJob: true });
    });

    await t.test("ibmi.profiles.delete", async () => {
      await handleTool(ctx, "ibmi.profiles.delete", { name: "mcp-test" });
    });

    await t.test("ibmi.libl.get", async () => {
      await handleTool(ctx, "ibmi.libl.get", {});
    });

    await t.test("ibmi.libl.validate", async () => {
      await handleTool(ctx, "ibmi.libl.validate", { libraryList: [testLib] });
    });

    await t.test("ibmi.libl.add", async () => {
      await handleTool(ctx, "ibmi.libl.add", { library: testLib, applyToJob: true });
    });

    await t.test("ibmi.libl.remove", async () => {
      await handleTool(ctx, "ibmi.libl.remove", { library: testLib, applyToJob: true });
    });

    await t.test("ibmi.libl.setCurrent", async () => {
      await handleTool(ctx, "ibmi.libl.setCurrent", { library: "QGPL", applyToJob: true });
    });

    await t.test("ibmi.actions.list", async () => {
      await handleTool(ctx, "ibmi.actions.list", {});
    });

    await t.test("ibmi.actions.save", async () => {
      await handleTool(ctx, "ibmi.actions.save", { action: { name: "MCPTEST ACTION", command: "DSPLIBL", environment: "ile" } });
    });

    await t.test("ibmi.actions.delete", async () => {
      await handleTool(ctx, "ibmi.actions.delete", { name: "MCPTEST ACTION" });
    });

    await t.test("ibmi.deploy.setCcsid", { skip: !runSetCcsid }, async () => {
      await handleTool(ctx, "ibmi.deploy.setCcsid", { remotePath: remoteBase, ccsid: "1208" });
    });

    await t.test("ibmi.debug.status", async () => {
      await handleTool(ctx, "ibmi.debug.status", {});
    });

    await t.test("ibmi.debug.startService", { skip: !runDebug }, async () => {
      await handleTool(ctx, "ibmi.debug.startService", {});
    });

    await t.test("ibmi.debug.stopService", { skip: !runDebug }, async () => {
      await handleTool(ctx, "ibmi.debug.stopService", {});
    });

    await t.test("ibmi.qsys.members.delete", async () => {
      await handleTool(ctx, "ibmi.qsys.members.delete", { library: testLib, sourceFile: testSrcFile, member: memberB });
    });

    await t.test("ibmi.actions.run (delete source file)", async () => {
      await handleTool(ctx, "ibmi.actions.run", {
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

    await t.test("ibmi.actions.run (delete library)", async () => {
      await handleTool(ctx, "ibmi.actions.run", {
        action: {
          name: "MCP Delete Library",
          command: "DLTLIB LIB(&CURLIB)",
          environment: "ile"
        },
        targetType: "streamfile",
        targetPath: remoteSrc
      });
    });

    await t.test("ibmi.ifs.delete", async () => {
      await handleTool(ctx, "ibmi.ifs.delete", { path: remoteBase, recursive: true });
    });

    await t.test("ibmi.qsys.libraries.list (verify cleanup)", async () => {
      const libs = getJson(await handleTool(ctx, "ibmi.qsys.libraries.list", { filter: testLib })) || [];
      assert.equal(libs.length, 0);
    });

    await t.test("ibmi.resolve.path (verify cleanup)", async () => {
      const resolve = getJson(await handleTool(ctx, "ibmi.resolve.path", { path: remoteBase }));
      assert.ok(resolve && resolve.exists === false);
    });

    await t.test("ibmi.disconnect", async () => {
      await handleTool(ctx, "ibmi.disconnect", {});
    });

    await t.test("ibmi.connections.delete", async () => {
      await handleTool(ctx, "ibmi.connections.delete", { name: connName });
    });
  } finally {
    if (!keepArtifacts) {
      await safe(() => handleTool(ctx, "ibmi.ifs.delete", { path: remoteBase, recursive: true }));
      await safe(() => handleTool(ctx, "ibmi.actions.run", {
        action: { name: "MCP Delete Library", command: "DLTLIB LIB(&CURLIB)", environment: "ile" },
        targetType: "streamfile",
        targetPath: remoteSrc
      }));
    }
    await safe(() => handleTool(ctx, "ibmi.disconnect", {}));
    await safe(() => handleTool(ctx, "ibmi.connections.delete", { name: connName }));
    await safe(() => fs.rm(localTemp, { recursive: true, force: true }));
  }
});
