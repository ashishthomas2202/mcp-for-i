import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeIfsDeletePath,
  checkClCommand,
  checkIfsPath,
  checkLibrary,
  checkResourcePolicy,
  checkShellCommand,
  checkSqlEmbeddedCl,
  extractEmbeddedCl,
  normalizeClCommandName
} from "../dist/mcp/policy.js";
import { getTools, handleTool } from "../dist/mcp/tools.js";
import { CompileTools, quoteForShell } from "../dist/ibmi/CompileTools.js";

test("CL command names are normalized before matching", () => {
  assert.equal(normalizeClCommandName("  qsys/dltlib lib(x)"), "DLTLIB");
  assert.equal(normalizeClCommandName("*LIBL/DLTLIB LIB(X)"), "DLTLIB");
  assert.equal(normalizeClCommandName("?DLTLIB"), "DLTLIB");
  assert.equal(normalizeClCommandName("DSPLIB(QGPL)"), "DSPLIB");
});

test("denyCommands and allowCommands match qualified and generic names", () => {
  const deny = { profile: "power-user", denyCommands: ["dltlib", "QSYS/CLR*"] };
  assert.match(checkClCommand(deny, "QSYS/DLTLIB LIB(X)"), /denyCommands/);
  assert.match(checkClCommand(deny, "  *LIBL/dltlib X"), /denyCommands/);
  assert.match(checkClCommand(deny, "CLRPFM FILE(A/B)"), /denyCommands/);
  assert.equal(checkClCommand(deny, "DSPLIB QGPL"), undefined);

  const allow = { profile: "power-user", allowCommands: ["DSP*", "WRKACTJOB"] };
  assert.equal(checkClCommand(allow, "QSYS/DSPLIB QGPL"), undefined);
  assert.match(checkClCommand(allow, "DLTLIB X"), /not in allowCommands/);
});

test("shell commands are checked for system invocations", () => {
  const deny = { profile: "power-user", denyCommands: ["DLTLIB"] };
  assert.match(checkShellCommand(deny, 'cd /tmp && system "QSYS/DLTLIB LIB(X)"'), /DLTLIB/);
  assert.match(checkShellCommand(deny, "system -i 'DLTLIB X'"), /DLTLIB/);
  assert.equal(checkShellCommand(deny, "ls -la"), undefined);
  assert.match(checkShellCommand({ profile: "power-user", allowCommands: ["DSPLIB"] }, "ls"), /cannot be verified/);
  assert.equal(checkShellCommand({ profile: "power-user" }, "anything"), undefined);
});

test("CL embedded in SQL is extracted from @ lines and QCMDEXC literals", () => {
  const sql = "@QSYS/DLTLIB LIB(A)\nCALL QSYS2.QCMDEXC('CRTLIB LIB(''B'')');\nCALL QCMDEXC(COMMAND => 'DSPLIB X')";
  const found = extractEmbeddedCl(sql);
  assert.deepEqual(found.commands, ["QSYS/DLTLIB LIB(A)", "CRTLIB LIB('B')", "DSPLIB X"]);
  assert.equal(found.unverifiable, false);
  assert.equal(extractEmbeddedCl("CALL QCMDEXC(:cmd)").unverifiable, true);

  const policy = { profile: "power-user", denyCommands: ["CRTLIB"] };
  assert.match(checkSqlEmbeddedCl(policy, sql), /CRTLIB/);
  assert.match(checkSqlEmbeddedCl(policy, "CALL QCMDEXC('DLT' || 'LIB X')"), /non-literal/);
  assert.equal(checkSqlEmbeddedCl(policy, "select * from qsys2.library_list_info"), undefined);
});

test("library policy handles generics and special values", () => {
  const policy = { profile: "power-user", allowLibraries: ["DEV*", "QGPL"], denyLibraries: ["DEVSECRET"] };
  assert.equal(checkLibrary(policy, "devlib"), undefined);
  assert.equal(checkLibrary(policy, "QGPL"), undefined);
  assert.match(checkLibrary(policy, "DEVSECRET"), /denyLibraries/);
  assert.match(checkLibrary(policy, "PRODLIB"), /not in allowLibraries/);
  assert.match(checkLibrary(policy, "*LIBL"), /cannot be checked/);
  assert.equal(checkLibrary({ profile: "guarded", denyLibraries: ["PROD"] }, "*LIBL"), undefined);
});

test("path policy matches directories and their children only", () => {
  const policy = { profile: "power-user", allowPaths: ["/home/dev"], denyPaths: ["/home/dev/secret"] };
  assert.equal(checkIfsPath(policy, "/home/dev"), undefined);
  assert.equal(checkIfsPath(policy, "/HOME/DEV/src/a.rpgle"), undefined);
  assert.match(checkIfsPath(policy, "/home/devil/x"), /not in allowPaths/);
  assert.match(checkIfsPath(policy, "/home/dev/../other"), /not in allowPaths/);
  assert.match(checkIfsPath(policy, "/home/dev/secret/key"), /denyPaths/);
  assert.match(checkIfsPath(policy, "relative/path"), /relative path/);
});

test("resource policy collects libraries from args and QSYS.LIB paths", () => {
  const policy = { profile: "power-user", denyLibraries: ["PROD"] };
  assert.match(checkResourcePolicy(policy, "ibmi.qsys.objects.list", { library: "prod" }), /PROD/);
  assert.match(checkResourcePolicy(policy, "ibmi.ifs.read", { path: "/QSYS.LIB/PROD.LIB/QRPGLESRC.FILE/A.MBR" }), /PROD/);
  assert.match(checkResourcePolicy(policy, "ibmi.libl.set", { libraryList: ["QGPL", "PROD"] }), /PROD/);
  assert.match(checkResourcePolicy(policy, "ibmi.resolve.path", { path: "PROD/QRPGLESRC/A.RPGLE" }), /PROD/);
  assert.equal(checkResourcePolicy(policy, "ibmi.qsys.objects.list", { library: "DEV" }), undefined);
  assert.equal(checkResourcePolicy(policy, "ibmi.connections.add", { library: "PROD" }), undefined);
});

test("ifs.delete path guard refuses roots and system directories", () => {
  for (const bad of ["", "/", "relative", "/home", "/QSYS.LIB", "/qsys.lib/mylib.lib", "/QOpenSys", "/QOpenSys/usr",
    "/QIBM/ProdData/x", "/home/dev/../..", "/home/dev/*", "//", "/tmp/"]) {
    assert.throws(() => assertSafeIfsDeletePath(bad), /ifs.delete refused/, bad);
  }
  assert.equal(assertSafeIfsDeletePath("/home/dev/build/"), "/home/dev/build");
  assert.equal(assertSafeIfsDeletePath("/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE"), "/QSYS.LIB/MYLIB.LIB/QRPGLESRC.FILE");
});

function fakeContext({ readOnlyMode = false, policy = { profile: "power-user" } } = {}) {
  const calls = [];
  const conn = {
    getConfig: () => ({ readOnlyMode, currentLibrary: "QGPL", libraryList: [] }),
    async runSQL(sql) { calls.push(["sql", sql]); return []; },
    async sendCommand(options) { calls.push(["cmd", options.command]); return { code: 0, stdout: "", stderr: "" }; },
    async sendQsh(options) { calls.push(["qsh", options.command]); return { code: 0, stdout: "", stderr: "" }; },
    content: { async getObjectList() { return []; } },
    validQsysName: () => true,
    defaultUserLibraries: [],
    currentUser: "DEV",
    currentHost: "dev"
  };
  const ctx = {
    store: {},
    activeName: "DEV",
    ensureActive: async () => conn,
    getPolicy: () => policy,
    resolvePolicy: async () => policy
  };
  return { ctx, calls };
}

test("read-only mode blocks sql.execute, cl.run and tn5250.sendKeys", async () => {
  const { ctx, calls } = fakeContext({ readOnlyMode: true });
  await assert.rejects(handleTool(ctx, "ibmi.sql.execute", { sql: "delete from a.b" }), /read-only mode/);
  await assert.rejects(handleTool(ctx, "ibmi.cl.run", { command: "DSPLIB QGPL" }), /read-only mode/);

  await handleTool(ctx, "ibmi.tn5250.connect", { connectionName: "DEV" });
  await handleTool(ctx, "ibmi.tn5250.setField", { connectionName: "DEV", fieldId: "command", value: "DLTLIB X" });
  await assert.rejects(handleTool(ctx, "ibmi.tn5250.sendKeys", { connectionName: "DEV", keys: "ENTER" }), /read-only mode/);
  await handleTool(ctx, "ibmi.tn5250.disconnect", { connectionName: "DEV" });
  assert.equal(calls.length, 0);
});

test("command policy blocks qualified commands in cl.run and SQL", async () => {
  const { ctx, calls } = fakeContext({ policy: { profile: "power-user", denyCommands: ["DLTLIB"] } });
  await assert.rejects(handleTool(ctx, "ibmi.cl.run", { command: " QSYS/DLTLIB LIB(X)" }), /Blocked by policy/);
  await assert.rejects(handleTool(ctx, "ibmi.sql.execute", { sql: "CALL QSYS2.QCMDEXC('*LIBL/DLTLIB X')" }), /Blocked by policy/);
  await assert.rejects(handleTool(ctx, "ibmi.sql.query", { sql: "@DLTLIB X" }), /Blocked by policy/);
  assert.equal(calls.filter(([, text]) => /DLTLIB/.test(text)).length, 0);

  const allowed = await handleTool(ctx, "ibmi.cl.run", { command: "DSPLIB QGPL" });
  assert.equal(allowed.isError, undefined);
});

test("library policy blocks tools that take a library", async () => {
  const { ctx } = fakeContext({ policy: { profile: "power-user", allowLibraries: ["DEV"] } });
  await assert.rejects(handleTool(ctx, "ibmi.qsys.objects.list", { library: "PROD" }), /not in allowLibraries/);
  await handleTool(ctx, "ibmi.qsys.objects.list", { library: "DEV" });
});

test("ifs.delete refuses system roots before running rm", async () => {
  const { ctx, calls } = fakeContext();
  await assert.rejects(handleTool(ctx, "ibmi.ifs.delete", { path: "/", recursive: true }), /refused/);
  await assert.rejects(handleTool(ctx, "ibmi.ifs.delete", { path: "/QSYS.LIB/QGPL.LIB" }), /refused/);
  assert.equal(calls.length, 0);
});

test("actions.run validates streamfile paths and checks the expanded command", async () => {
  const { ctx, calls } = fakeContext({ policy: { profile: "power-user", denyCommands: ["DLTF"] } });
  const action = { name: "x", command: "CRTBNDRPG SRCSTMF('&FULLPATH')", environment: "ile" };
  await assert.rejects(
    handleTool(ctx, "ibmi.actions.run", { action, targetType: "streamfile", targetPath: '/home/a"; rm -rf /; ".rpgle' }),
    /targetPath must not contain/
  );
  await assert.rejects(
    handleTool(ctx, "ibmi.actions.run", { action: { ...action, command: "QSYS/DLTF FILE(&NAME)" }, targetType: "streamfile", targetPath: "/home/a.rpgle" }),
    /Blocked by policy/
  );
  await handleTool(ctx, "ibmi.actions.run", { action, targetType: "streamfile", targetPath: "/home/dev/a.rpgle" });
  const qsh = calls.find(([kind]) => kind === "qsh");
  assert.ok(qsh, "expected the action to run through qsh");
  assert.ok(qsh[1].includes(`system 'CRTBNDRPG SRCSTMF('\\''/home/dev/a.rpgle'\\'')'`), qsh[1]);
});

test("shell quoting keeps quotes, backticks and $ inside one word", () => {
  assert.equal(quoteForShell(`a"b\`c$d'e`), `'a"b\`c$d'\\''e'`);
  assert.throws(() => CompileTools.validateStreamfilePath("/a/`id`.rpgle"), /must not contain/);
  assert.throws(() => CompileTools.validateStreamfilePath("relative.rpgle"), /absolute/);
  assert.equal(CompileTools.validateStreamfilePath("/home/dev/my file.rpgle"), "/home/dev/my file.rpgle");
});

test("tools that read connectionName declare it in their schema", () => {
  const byName = new Map(getTools().map(tool => [tool.name, tool]));
  for (const name of [
    "ibmi.ifs.list", "ibmi.ifs.read", "ibmi.ifs.write", "ibmi.ifs.mkdir", "ibmi.ifs.delete", "ibmi.ifs.upload",
    "ibmi.ifs.download", "ibmi.find.ifs", "ibmi.resolve.path", "ibmi.deploy.uploadDirectory", "ibmi.deploy.uploadFiles",
    "ibmi.deploy.setCcsid", "ibmi.deploy.compare", "ibmi.deploy.sync", "ibmi.actions.run", "ibmi.debug.status",
    "ibmi.libl.validate", "ibmi.journal.objects.list"
  ]) {
    assert.ok(byName.get(name)?.inputSchema?.properties?.connectionName, `${name} should declare connectionName`);
  }
});

test("tn5250 descriptions say it is a CL console, not 5250 emulation", () => {
  const tool = getTools().find(t => t.name === "ibmi.tn5250.sendKeys");
  assert.match(tool.description, /not real 5250 emulation/);
});
