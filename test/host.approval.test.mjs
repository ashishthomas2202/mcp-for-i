import test from "node:test";
import assert from "node:assert/strict";
import { handleTool, handleToolCall } from "../dist/mcp/tools.js";
import {
  classifyHostOperation,
  classifyClText,
  classifySql,
  DEFAULT_ALWAYS_CONFIRM,
  DEFAULT_CONFIRM_CL_COMMANDS,
  DEFAULT_CONFIRM_SQL_VERBS
} from "../dist/mcp/hostApproval.js";
import { validatePolicy } from "../dist/config/store.js";
import { ConfigStore } from "../dist/config/store.js";
import { createElicitationConfirm } from "../dist/mcp/confirm.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A fake connection: records SQL (CL runs as QCMDEXC through SQL), shell commands and member deletes. */
function fakeConn(config = {}) {
  const calls = { sql: [], commands: [], qsh: [], deleted: [] };
  const conn = {
    currentConnectionName: "DEV",
    getConfig() {
      return { readOnlyMode: false, currentLibrary: "DEVLIB", ...config };
    },
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      return [];
    },
    async sendCommand(options) {
      calls.commands.push(options.command);
      return { code: 0, stdout: "", stderr: "" };
    },
    async sendQsh(options) {
      calls.qsh.push(options.command);
      return { code: 0, stdout: "", stderr: "" };
    },
    content: {
      invalidateMemberSnapshot() {},
      async deleteMember(library, file, member) {
        calls.deleted.push(`${library}/${file}(${member})`);
      }
    }
  };
  return { conn, calls };
}

/** A context whose confirm handler answers from a list and records every prompt. */
function context(conn, policy, answers = []) {
  const prompts = [];
  const ctx = {
    store: {},
    activeName: "DEV",
    sessionApprovals: new Set(),
    ensureActive: async () => conn,
    getPolicy: () => policy,
    confirm: async request => {
      prompts.push(request);
      return answers.length > 0 ? answers.shift() : { allowed: false };
    }
  };
  return { ctx, prompts };
}

const REQUIRE = ["sql.write", "cl.run", "deploy.sync", "ifs.delete", "qsys.write"];
const HOST = { profile: "guarded", approvalMode: "host", requireApprovalFor: REQUIRE, trustedLibraries: ["DEVLIB", "QTEMP"] };
const HOST_NO_TRUST = { profile: "guarded", approvalMode: "host", requireApprovalFor: REQUIRE };

/** Run a tool in host mode; returns the prompts it showed and whether it ran. */
async function runHost(tool, args, policy = HOST, answers = []) {
  const { conn, calls } = fakeConn();
  const { ctx, prompts } = context(conn, policy, answers);
  const state = { toolName: tool };
  let error;
  try {
    await handleToolCall(ctx, tool, args, state);
  } catch (err) {
    error = err;
  }
  return { prompts, calls, error, state };
}

// ---- the decision table, through the real tools ----

const ROUTINE = [
  ["qsys.write in a trusted library", "ibmi.objects.changeDescription", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", text: "x" }],
  ["cl.run CRTBNDRPG into a trusted library", "ibmi.cl.run", { command: "CRTBNDRPG PGM(DEVLIB/PCRBCRPT) SRCFILE(DISK/QRPGLESRC) SRCMBR(PCRBCRPT) OPTION(*EVENTF) BNDDIR(*NONE)" }],
  ["cl.run CALL of a trusted program", "ibmi.cl.run", { command: "CALL PGM(DEVLIB/PGMA) PARM('2024/01/01')" }],
  ["cl.run SBMJOB of a CALL", "ibmi.cl.run", { command: "SBMJOB CMD(CALL PGM(DEVLIB/PGMA)) JOB(TESTJOB) JOBD(QGPL/QDFTJOBD)" }],
  ["cl.run ADDLIBLE", "ibmi.cl.run", { command: "ADDLIBLE LIB(DISK)" }],
  ["cl.run RMVLIBLE", "ibmi.cl.run", { command: "RMVLIBLE LIB(DISK)" }],
  ["cl.run OVRDBF and DLTOVR", "ibmi.cl.run", { command: "OVRDBF FILE(X) TOFILE(DISK/X)" }],
  ["cl.run DLTOVR", "ibmi.cl.run", { command: "DLTOVR FILE(*ALL)" }],
  ["cl.run DSPLIBL", "ibmi.cl.run", { command: "DSPLIBL" }],
  ["sql.write CREATE ALIAS in a trusted library over another one", "ibmi.sql.execute", { sql: "CREATE ALIAS DEVLIB.X FOR DISK.F(M)" }],
  ["sql.write DROP ALIAS", "ibmi.sql.execute", { sql: "DROP ALIAS DEVLIB.X" }],
  ["sql.write CREATE VIEW", "ibmi.sql.execute", { sql: "CREATE OR REPLACE VIEW DEVLIB.V AS SELECT * FROM DISK.F" }],
  ["sql.write INSERT, UPDATE, MERGE", "ibmi.sql.execute", { sql: "INSERT INTO DEVLIB.T VALUES(1); UPDATE DEVLIB.T SET A = 2; MERGE INTO QTEMP.T USING DISK.S ON 1=1 WHEN MATCHED THEN UPDATE SET A = 1" }]
];

for (const [label, tool, args] of ROUTINE) {
  test(`host mode runs without a prompt: ${label}`, async () => {
    const { prompts, error, state } = await runHost(tool, args);
    assert.equal(prompts.length, 0, `unexpected prompt: ${prompts[0]?.reason}`);
    if (error) assert.doesNotMatch(String(error.message), /confirm|Blocked/);
    assert.equal(state.approvedBy, "host");
  });
}

const CRITICAL = [
  ["qsys.write outside trustedLibraries", "ibmi.objects.changeDescription", { library: "PRODLIB", object: "PGMA", objectType: "*PGM", text: "x" }, "qsys.write", /PRODLIB, outside trustedLibraries/],
  ["member delete", "ibmi.qsys.members.delete", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A" }, "members.delete", /alwaysConfirm/],
  ["member rename", "ibmi.qsys.members.rename", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A", newName: "B" }, "members.rename", /alwaysConfirm/],
  ["object delete", "ibmi.objects.delete", { library: "DEVLIB", object: "PGMA", objectType: "*PGM" }, "objects.delete", /alwaysConfirm/],
  ["object move", "ibmi.objects.move", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", toLibrary: "QTEMP" }, "objects.move", /alwaysConfirm/],
  ["object rename", "ibmi.objects.rename", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", newObject: "PGMB" }, "objects.rename", /alwaysConfirm/],
  ["job end", "ibmi.jobs.end", { jobName: "123456/DEV/JOB" }, "jobs.end", /alwaysConfirm/],
  ["spool delete", "ibmi.spool.delete", { jobName: "123456/DEV/JOB", spooledFileName: "QSYSPRT", spooledFileNumber: 1 }, "spool.delete", /alwaysConfirm/],
  ["ifs.delete", "ibmi.ifs.delete", { path: "/home/DEV/x.txt" }, "ifs.delete", /alwaysConfirm/],
  ["shell", "ibmi.cl.run", { command: "ls /tmp", environment: "qsh" }, "shell.run", /Shell/],
  ["audit purge", "ibmi.audit.purge", { before: "2000-01-01T00:00:00Z" }, "audit.purge", /alwaysConfirm/],
  ["deploy.sync", "ibmi.deploy.sync", { localPath: "C:/nowhere", remotePath: "/home/DEV/x" }, "deploy.sync", /alwaysConfirm/],
  ["cl.run DLTPGM", "ibmi.cl.run", { command: "DLTPGM PGM(DEVLIB/PGMA)" }, "cl.run", /DLTPGM is in confirmClCommands/],
  ["cl.run CLRPFM", "ibmi.cl.run", { command: "CLRPFM FILE(DEVLIB/F)" }, "cl.run", /CLRPFM is in confirmClCommands/],
  ["cl.run CALL outside trustedLibraries", "ibmi.cl.run", { command: "CALL PGM(DISK/PGMA)" }, "cl.run", /DISK, outside/],
  ["cl.run CALL through *LIBL", "ibmi.cl.run", { command: "CALL PGM(PGMA)" }, "cl.run", /cannot be determined/],
  ["cl.run SBMJOB of a delete", "ibmi.cl.run", { command: "SBMJOB CMD(DLTLIB LIB(DEVLIB))" }, "cl.run", /DLTLIB is in confirmClCommands/],
  ["cl.run CALL QCMDEXC of a delete", "ibmi.cl.run", { command: "CALL PGM(QSYS/QCMDEXC) PARM('DLTF FILE(DEVLIB/F)' 19)" }, "cl.run", /DLTF is in confirmClCommands/],
  ["cl.run CHGUSRPRF", "ibmi.cl.run", { command: "CHGUSRPRF USRPRF(X) STATUS(*DISABLED)" }, "cl.run", /CHGUSRPRF/],
  ["sql.write DELETE", "ibmi.sql.execute", { sql: "DELETE FROM DEVLIB.T WHERE A = 1" }, "sql.write", /DELETE statements/],
  ["sql.write DROP TABLE", "ibmi.sql.execute", { sql: "DROP TABLE DEVLIB.T" }, "sql.write", /DROP TABLE statements/],
  ["sql.write CALL", "ibmi.sql.execute", { sql: "CALL DEVLIB.PROC()" }, "sql.write", /CALL statements/],
  ["sql.write TRUNCATE, ALTER, GRANT", "ibmi.sql.execute", { sql: "ALTER TABLE DEVLIB.T ADD COLUMN B INT" }, "sql.write", /ALTER statements/],
  ["sql.write INSERT outside trustedLibraries", "ibmi.sql.execute", { sql: "INSERT INTO DISK.T VALUES(1)" }, "sql.write", /DISK, outside/],
  ["sql.write CREATE TABLE without a schema", "ibmi.sql.execute", { sql: "CREATE TABLE T (A INT)" }, "sql.write", /cannot be determined/],
  ["sql.write @ line with a delete", "ibmi.sql.execute", { sql: "@DLTPGM PGM(DEVLIB/X)\nSELECT 1 FROM SYSIBM.SYSDUMMY1" }, "sql.write", /DLTPGM/],
  ["sql.write data-change table reference", "ibmi.sql.execute", { sql: "SELECT * FROM FINAL TABLE (DELETE FROM DEVLIB.T)" }, "sql.write", /DELETE statements/]
];

for (const [label, tool, args, operation, reason] of CRITICAL) {
  test(`host mode asks the person with an empty form: ${label}`, async () => {
    const { prompts, error, calls } = await runHost(tool, args);
    assert.equal(prompts.length, 1, "expected exactly one prompt");
    const prompt = prompts[0];
    assert.equal(prompt.operation, operation);
    assert.equal(prompt.allowSession, false, "host-mode prompts never offer a session allowance");
    assert.equal(prompt.critical, true);
    assert.match(prompt.reason, reason);
    assert.match(String(error?.message), /was not confirmed by the user/);
    assert.equal(calls.deleted.length, 0);
  });
}

test("host mode: an accepted critical prompt runs once and is audited as approved by the person", async () => {
  const { prompts, calls, error, state } = await runHost(
    "ibmi.qsys.members.delete",
    { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A" },
    HOST,
    [{ allowed: true }]
  );
  assert.equal(error, undefined);
  assert.equal(prompts.length, 1);
  assert.deepEqual(calls.deleted, ["DEVLIB/QRPGLESRC(A)"]);
  assert.equal(state.approvedBy, "person");
});

test("host mode: deleting a library asks once, not twice", async () => {
  const { prompts, calls, error } = await runHost(
    "ibmi.objects.delete",
    { library: "DEVLIB", objectType: "*LIB", confirmName: "DEVLIB" },
    HOST,
    [{ allowed: true }]
  );
  assert.equal(error, undefined);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operation, "qsys.deleteLibrary");
  assert.ok(calls.sql.some(sql => sql.includes("DLTLIB LIB(DEVLIB)")));
});

test("host mode: approve=true neither replaces nor is needed for a decision", async () => {
  const routine = await runHost("ibmi.cl.run", { command: "CALL PGM(DEVLIB/PGMA)", approve: false });
  assert.equal(routine.prompts.length, 0);
  const critical = await runHost("ibmi.cl.run", { command: "DLTPGM PGM(DEVLIB/PGMA)", approve: true });
  assert.equal(critical.prompts.length, 1);
  assert.match(String(critical.error?.message), /was not confirmed/);
});

test("host mode without trustedLibraries: only the critical lists ask", async () => {
  const outside = await runHost("ibmi.objects.changeDescription", { library: "PRODLIB", object: "X", objectType: "*PGM", text: "x" }, HOST_NO_TRUST);
  assert.equal(outside.prompts.length, 0);
  const call = await runHost("ibmi.cl.run", { command: "CALL PGM(X)" }, HOST_NO_TRUST);
  assert.equal(call.prompts.length, 0);
  const del = await runHost("ibmi.sql.execute", { sql: "DELETE FROM PRODLIB.T" }, HOST_NO_TRUST);
  assert.equal(del.prompts.length, 1);
});

test("host mode: the lists are configurable", async () => {
  const policy = { ...HOST, alwaysConfirm: ["members.delete"], confirmClCommands: ["CRTBNDRPG"], confirmSqlVerbs: ["INSERT"] };
  assert.equal((await runHost("ibmi.ifs.delete", { path: "/home/DEV/x.txt" }, policy)).prompts.length, 0);
  assert.equal((await runHost("ibmi.cl.run", { command: "DLTPGM PGM(DEVLIB/X)" }, policy)).prompts.length, 0);
  assert.equal((await runHost("ibmi.cl.run", { command: "CRTBNDRPG PGM(DEVLIB/X)" }, policy)).prompts.length, 1);
  assert.equal((await runHost("ibmi.sql.execute", { sql: "INSERT INTO DEVLIB.T VALUES(1)" }, policy)).prompts.length, 1);
  assert.equal((await runHost("ibmi.sql.execute", { sql: "DELETE FROM DEVLIB.T" }, policy)).prompts.length, 0);
});

test("host mode keeps the rest of the policy: read-only profile, denyLibraries, denyCommands, safe delete paths", async () => {
  const readOnly = await runHost("ibmi.cl.run", { command: "CALL PGM(DEVLIB/X)" }, { ...HOST, profile: "read-only" });
  assert.match(String(readOnly.error?.message), /Blocked by policy \(read-only\)/);
  assert.equal(readOnly.prompts.length, 0);

  const denied = await runHost("ibmi.objects.changeDescription", { library: "DEVLIB", object: "X", objectType: "*PGM", text: "x" }, { ...HOST, denyLibraries: ["DEV*"] });
  assert.match(String(denied.error?.message), /DEVLIB is in denyLibraries/);
  assert.equal(denied.prompts.length, 0);

  const deniedCmd = await runHost("ibmi.cl.run", { command: "CALL PGM(DEVLIB/X)" }, { ...HOST, denyCommands: ["CALL"] });
  assert.match(String(deniedCmd.error?.message), /CALL is in denyCommands/);

  const unsafe = await runHost("ibmi.ifs.delete", { path: "/home/DEV" }, HOST, [{ allowed: true }]);
  assert.match(String(unsafe.error?.message), /cannot delete a user home directory/);
  assert.equal(unsafe.calls.commands.length, 0);
});

test("host mode: a client without prompts can't run critical operations but runs routine ones", async () => {
  const { conn, calls } = fakeConn();
  const ctx = { store: {}, activeName: "DEV", sessionApprovals: new Set(), ensureActive: async () => conn, getPolicy: () => HOST };
  await handleTool(ctx, "ibmi.cl.run", { command: "CALL PGM(DEVLIB/X)" });
  assert.equal(calls.sql.length, 1);
  await assert.rejects(handleTool(ctx, "ibmi.cl.run", { command: "DLTPGM PGM(DEVLIB/X)" }), /is critical and needs the user's confirmation/);
});

// ---- "prompt" and "agent" mode are unchanged ----

test("prompt mode: a member delete still asks as qsys.write with a session allowance", async () => {
  const policy = { profile: "guarded", requireApprovalFor: REQUIRE };
  const { prompts, state } = await runHost("ibmi.qsys.members.delete", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A" }, policy);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operation, "qsys.write");
  assert.equal(prompts[0].specificOperation, "members.delete");
  assert.equal(prompts[0].allowSession, true);
  assert.equal(state.approvedBy, undefined);
});

test("prompt mode: routine host-mode operations still ask", async () => {
  const policy = { profile: "guarded", requireApprovalFor: REQUIRE, trustedLibraries: ["DEVLIB"] };
  const { prompts } = await runHost("ibmi.cl.run", { command: "CALL PGM(DEVLIB/X)" }, policy);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operation, "cl.run");
  assert.equal(prompts[0].allowSession, true);
});

test("agent mode: approve=true is still required and enough", async () => {
  const policy = { profile: "guarded", approvalMode: "agent", requireApprovalFor: REQUIRE };
  const without = await runHost("ibmi.objects.delete", { library: "DEVLIB", object: "X", objectType: "*PGM" }, policy);
  assert.match(String(without.error?.message), /requires approve=true/);
  const withApprove = await runHost("ibmi.objects.delete", { library: "DEVLIB", object: "X", objectType: "*PGM", approve: true }, policy);
  assert.equal(withApprove.error, undefined);
  assert.equal(withApprove.prompts.length, 0);
});

// ---- the classifier on its own ----

test("classifier: defaults are exported and cover the required entries", () => {
  for (const op of ["shell.run", "ifs.delete", "audit.purge", "journal.receivers.delete", "deploy.sync", "members.delete", "objects.delete", "jobs.end"]) {
    assert.ok(DEFAULT_ALWAYS_CONFIRM.includes(op), op);
  }
  for (const cmd of ["DLT*", "CLR*", "RMV*", "RNM*", "MOV*", "END*", "PWRDWNSYS", "CHGUSRPRF", "CRTUSRPRF", "GRTOBJAUT", "RVKOBJAUT", "CHGOBJOWN", "CHGSYSVAL", "!RMVLIBLE"]) {
    assert.ok(DEFAULT_CONFIRM_CL_COMMANDS.includes(cmd), cmd);
  }
  for (const verb of ["DELETE", "TRUNCATE", "DROP TABLE", "ALTER", "GRANT", "REVOKE", "CALL"]) {
    assert.ok(DEFAULT_CONFIRM_SQL_VERBS.includes(verb), verb);
  }
});

test("classifier: CL targets resolve qualified names, *CURLIB and CRT defaults", () => {
  const policy = { profile: "guarded" };
  assert.deepEqual(classifyClText(policy, "CRTBNDRPG PGM(PCRBCRPT) SRCFILE(DISK/QRPGLESRC)", "DEVLIB").targets, { libraries: ["DEVLIB"], unknown: false });
  assert.deepEqual(classifyClText(policy, "CRTPGM PGM(DEVLIB/P) MODULE(DISK/M) BNDSRVPGM(DISK/S)", "DEVLIB").targets, { libraries: ["DEVLIB"], unknown: false });
  assert.deepEqual(classifyClText(policy, "CPYF FROMFILE(DISK/F) TOFILE(*CURLIB/F)", "DEVLIB").targets, { libraries: ["DEVLIB"], unknown: false });
  assert.deepEqual(classifyClText(policy, "DSPFD FILE(DISK/F) OUTPUT(*OUTFILE) OUTFILE(PROD/X)").targets, { libraries: ["PROD"], unknown: false });
  assert.equal(classifyClText(policy, "CALL PGM(*LIBL/X)").targets.unknown, true);
  assert.equal(classifyClText(policy, "CALL DEVLIB/X").targets.libraries[0], "DEVLIB");
});

test("classifier: SQL targets", () => {
  const policy = { profile: "guarded" };
  assert.deepEqual(classifySql(policy, "CREATE ALIAS DEVLIB/X FOR DISK/F(M)").targets, { libraries: ["DEVLIB"], unknown: false });
  assert.deepEqual(classifySql(policy, "CREATE INDEX DEVLIB.I ON DISK.T (A)").targets, { libraries: ["DEVLIB", "DISK"], unknown: false });
  assert.deepEqual(classifySql(policy, "SELECT * FROM DISK.T").targets, { libraries: [], unknown: false });
  assert.deepEqual(classifySql(policy, "DECLARE GLOBAL TEMPORARY TABLE SESSION.T (A INT)").targets, { libraries: ["QTEMP"], unknown: false });
  assert.match(classifySql(policy, "DROP SCHEMA DEVLIB").critical, /DROP SCHEMA/);
  assert.match(classifySql(policy, "BEGIN ATOMIC DELETE FROM X").critical, /BEGIN statements cannot be checked/);
  assert.match(classifySql(policy, "VALUES QSYS2.QCMDEXC(V)").critical, /built at run time/);
});

test("classifier: tools outside the library check stay routine with trustedLibraries set", () => {
  for (const toolName of ["ibmi.libl.add", "ibmi.jobs.hold", "ibmi.spool.hold", "ibmi.msgq.send"]) {
    const decision = classifyHostOperation({ policy: HOST, operation: "qsys.write", toolName, args: { library: "PROD" }, shell: false });
    assert.equal(decision.critical, false, toolName);
  }
  const ifsWrite = classifyHostOperation({ policy: HOST, operation: "ifs.write", toolName: "ibmi.ifs.write", args: { path: "/home/DEV/x" }, shell: false });
  assert.equal(ifsWrite.critical, false);
  const qsysPath = classifyHostOperation({ policy: HOST, operation: "qsys.write", toolName: "ibmi.ifs.write", args: { path: "/QSYS.LIB/PROD.LIB/F.FILE/M.MBR" }, shell: false });
  assert.equal(qsysPath.critical, true);
});

// ---- the prompt over a real MCP client/server pair ----

async function connectPair(onElicit) {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  const client = new Client({ name: "test-client", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, onElicit);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const META_KEYS = [
  "mcp-for-i/operation", "mcp-for-i/tool", "mcp-for-i/connection",
  "mcp-for-i/libraries", "mcp-for-i/critical", "mcp-for-i/reason"
];

test("every elicitation carries the _meta keys; host-mode ones have an empty form", async () => {
  const seen = [];
  const { server, client } = await connectPair(async request => {
    seen.push(request.params);
    return { action: "accept", content: {} };
  });
  const confirm = createElicitationConfirm(server);

  for (const [policy, tool, args] of [
    [HOST, "ibmi.objects.changeDescription", { library: "PRODLIB", object: "X", objectType: "*PGM", text: "x" }],
    [HOST, "ibmi.qsys.members.delete", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A" }],
    [HOST, "ibmi.cl.run", { command: "ls", environment: "pase" }],
    [{ profile: "guarded", requireApprovalFor: REQUIRE }, "ibmi.qsys.members.delete", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "A" }],
    [{ profile: "guarded", requireApprovalFor: REQUIRE }, "ibmi.cl.run", { command: "ls", environment: "pase" }]
  ]) {
    const { conn } = fakeConn();
    const ctx = { store: {}, activeName: "DEV", sessionApprovals: new Set(), ensureActive: async () => conn, getPolicy: () => policy, confirm };
    await handleTool(ctx, tool, args);
  }
  await client.close();

  assert.equal(seen.length, 5);
  for (const params of seen) {
    for (const key of META_KEYS) assert.ok(key in params._meta, `missing ${key}`);
    assert.equal(params._meta["mcp-for-i/connection"], "DEV");
  }
  // Host mode: empty forms, critical facts.
  for (const params of seen.slice(0, 3)) {
    assert.deepEqual(params.requestedSchema, { type: "object", properties: {} });
    assert.equal(params._meta["mcp-for-i/critical"], true);
  }
  assert.deepEqual(seen[0]._meta["mcp-for-i/libraries"], ["PRODLIB"]);
  assert.equal(seen[0]._meta["mcp-for-i/tool"], "ibmi.objects.changeDescription");
  assert.equal(seen[1]._meta["mcp-for-i/operation"], "members.delete");
  assert.equal(seen[2]._meta["mcp-for-i/operation"], "shell.run");
  // Prompt mode keeps its message and session checkbox, and gains the metadata.
  assert.ok(seen[3].requestedSchema.properties.allowForSession);
  assert.match(seen[3].message, /perform a guarded operation \(qsys\.write\)/);
  assert.equal(seen[3]._meta["mcp-for-i/operation"], "members.delete");
  assert.deepEqual(seen[4].requestedSchema, { type: "object", properties: {} });
});

// ---- configuration ----

test("validatePolicy accepts host mode and its lists", () => {
  assert.deepEqual(validatePolicy({
    profile: "guarded",
    approvalMode: "host",
    alwaysConfirm: ["shell.run", "members.delete"],
    confirmClCommands: ["DLT*", "!DLTOVR", "QSYS/PWRDWNSYS"],
    confirmSqlVerbs: ["DELETE", "DROP TABLE"],
    trustedLibraries: ["DEVASHISH", "PGM*", "QTEMP"]
  }), []);
});

test("validatePolicy rejects bad values", () => {
  const errors = validatePolicy({
    profile: "guarded",
    approvalMode: "trust-me",
    alwaysConfirm: "shell.run",
    confirmClCommands: ["DLT LIB"],
    confirmSqlVerbs: ["DELETE;"],
    trustedLibraries: ["DEV/ASHISH", ""]
  });
  assert.ok(errors.some(e => e.includes("approvalMode")));
  assert.ok(errors.some(e => e.startsWith("policy.alwaysConfirm")));
  assert.ok(errors.some(e => e.startsWith("policy.confirmClCommands")));
  assert.ok(errors.some(e => e.startsWith("policy.confirmSqlVerbs")));
  assert.ok(errors.some(e => e.startsWith("policy.trustedLibraries")));
});

test("config load keeps host mode and falls back safely on bad lists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-host-"));
  try {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
      connections: [
        { name: "A", host: "a", username: "u", policy: { profile: "guarded", approvalMode: "host", trustedLibraries: ["devashish", "BAD/NAME"], confirmSqlVerbs: "DELETE" } },
        { name: "B", host: "b", username: "u", policy: { profile: "guarded", approvalMode: "host", trustedLibraries: "DEVASHISH" } },
        { name: "C", host: "c", username: "u", policy: { profile: "guarded", approvalMode: "yes" } }
      ]
    }));
    const store = new ConfigStore({ configDir: dir });
    const a = await store.getConnection("A");
    assert.equal(a.policy.approvalMode, "host");
    assert.deepEqual(a.policy.trustedLibraries, ["DEVASHISH"]);
    assert.equal(a.policy.confirmSqlVerbs, undefined);
    const b = await store.getConnection("B");
    assert.deepEqual(b.policy.trustedLibraries, []);
    const c = await store.getConnection("C");
    assert.equal(c.policy.approvalMode, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("every approve parameter says it is ignored in host mode", async () => {
  const { getTools } = await import("../dist/mcp/tools.js");
  const withApprove = getTools().filter(tool => tool.inputSchema?.properties?.approve);
  assert.ok(withApprove.length > 30);
  for (const tool of withApprove) {
    assert.match(tool.inputSchema.properties.approve.description, /Ignored when the connection's approvalMode is "host"/, tool.name);
  }
});
