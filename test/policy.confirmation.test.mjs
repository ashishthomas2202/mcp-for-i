import test from "node:test";
import assert from "node:assert/strict";
import { actionCommandGuard, handleTool } from "../dist/mcp/tools.js";
import { clStartsShell, isShellOperation } from "../dist/mcp/policy.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createElicitationConfirm } from "../dist/mcp/confirm.js";

function fakeConn() {
  const calls = { sql: [], commands: [] };
  const conn = {
    currentConnectionName: "DEV",
    getConfig() {
      return { readOnlyMode: false };
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
    content: { invalidateMemberSnapshot() {} }
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

const GUARDED = { profile: "guarded", requireApprovalFor: ["qsys.write", "ifs.delete", "cl.run", "sql.write"] };
const DELETE_ARGS = { library: "DEVLIB", object: "PGMA", objectType: "*PGM" };

test("a guarded operation runs only after the user accepts the prompt", async () => {
  const { conn, calls } = fakeConn();
  const { ctx, prompts } = context(conn, GUARDED, [{ allowed: true }]);
  await handleTool(ctx, "ibmi.objects.delete", DELETE_ARGS);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operation, "qsys.write");
  assert.equal(prompts[0].connectionName, "DEV");
  assert.equal(prompts[0].toolName, "ibmi.objects.delete");
  assert.equal(prompts[0].allowSession, true);
  assert.ok(prompts[0].details.includes("library: DEVLIB"));
  assert.ok(prompts[0].details.includes("object: PGMA"));
  assert.ok(calls.sql.some(sql => sql.includes("DLTPGM")));
});

test("a declined prompt stops the operation, even when the agent passed approve=true", async () => {
  const { conn, calls } = fakeConn();
  const { ctx, prompts } = context(conn, GUARDED, [{ allowed: false }]);
  await assert.rejects(
    handleTool(ctx, "ibmi.objects.delete", { ...DELETE_ARGS, approve: true }),
    /was not confirmed by the user/
  );
  assert.equal(prompts.length, 1);
  assert.equal(calls.sql.length, 0);
});

test("a client without prompts gets a refusal, not a silent run", async () => {
  const { conn, calls } = fakeConn();
  const { ctx } = context(conn, GUARDED, ["unsupported"]);
  await assert.rejects(handleTool(ctx, "ibmi.objects.delete", DELETE_ARGS), /cannot show confirmation prompts/);
  delete ctx.confirm;
  await assert.rejects(handleTool(ctx, "ibmi.objects.delete", { ...DELETE_ARGS, approve: true }), /cannot show confirmation prompts/);
  assert.equal(calls.sql.length, 0);
});

test("approvalMode agent keeps the old approve=true behavior without prompting", async () => {
  const { conn, calls } = fakeConn();
  const { ctx, prompts } = context(conn, { ...GUARDED, approvalMode: "agent" });
  await assert.rejects(handleTool(ctx, "ibmi.objects.delete", DELETE_ARGS), /requires approve=true/);
  await handleTool(ctx, "ibmi.objects.delete", { ...DELETE_ARGS, approve: true });
  assert.equal(prompts.length, 0);
  assert.ok(calls.sql.some(sql => sql.includes("DLTPGM")));
});

test("allowing for the session skips later prompts for the same operation and connection", async () => {
  const { conn } = fakeConn();
  const { ctx, prompts } = context(conn, GUARDED, [{ allowed: true, forSession: true }]);
  await handleTool(ctx, "ibmi.objects.delete", DELETE_ARGS);
  await handleTool(ctx, "ibmi.objects.delete", { ...DELETE_ARGS, object: "PGMB" });
  assert.equal(prompts.length, 1);
});

test("power-user and operations outside requireApprovalFor do not prompt", async () => {
  const { conn } = fakeConn();
  const powerUser = context(conn, { profile: "power-user" });
  await handleTool(powerUser.ctx, "ibmi.objects.delete", DELETE_ARGS);
  assert.equal(powerUser.prompts.length, 0);

  const narrow = context(conn, { profile: "guarded", requireApprovalFor: ["sql.write"] });
  await handleTool(narrow.ctx, "ibmi.objects.delete", DELETE_ARGS);
  assert.equal(narrow.prompts.length, 0);
});

test("shell commands always prompt under guarded, never offer a session allowance, and show the command", async () => {
  const { conn, calls } = fakeConn();
  // cl.run is left out of requireApprovalFor on purpose: shell still prompts.
  const { ctx, prompts } = context(conn, { profile: "guarded", requireApprovalFor: [] });
  await assert.rejects(
    handleTool(ctx, "ibmi.cl.run", { command: "rm -rf /home/PGMASHISH", environment: "pase" }),
    /was not confirmed/
  );
  await assert.rejects(
    handleTool(ctx, "ibmi.cl.run", { command: "QSH CMD('rm -rf /home/PGMASHISH')" }),
    /was not confirmed/
  );
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.equal(prompt.operation, "shell.run");
    assert.equal(prompt.allowSession, false);
  }
  assert.ok(prompts[0].details.includes("command: rm -rf /home/PGMASHISH"));
  assert.ok(prompts[0].details.includes("environment: pase"));
  assert.equal(calls.commands.length + calls.sql.length, 0);
});

test("shell commands do not prompt under power-user", async () => {
  const { conn } = fakeConn();
  const { ctx, prompts } = context(conn, { profile: "power-user" });
  await handleTool(ctx, "ibmi.cl.run", { command: "ls /tmp", environment: "pase" });
  assert.equal(prompts.length, 0);
});

test("saved actions that run shell text ask with the expanded command", async () => {
  const { conn } = fakeConn();
  const { ctx, prompts } = context(conn, { profile: "guarded", requireApprovalFor: [] }, [{ allowed: true }]);
  const guard = actionCommandGuard(ctx, "pase", {});
  assert.equal(await guard("make all"), "make all");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operation, "shell.run");
  assert.ok(prompts[0].details.includes("command: make all"));

  await assert.rejects(actionCommandGuard(ctx, "ile", {})("STRQSH CMD('rm -rf /x')"), /was not confirmed/);
  // Plain ILE CL is covered by the qsys.write check that runs first, so no second prompt here.
  assert.equal(await actionCommandGuard(ctx, "ile", {})("CRTBNDRPG PGM(DEVLIB/PGMA)"), "CRTBNDRPG PGM(DEVLIB/PGMA)");
  assert.equal(prompts.length, 2);
});

test("clStartsShell finds shells started from CL, and isShellOperation from SQL", () => {
  assert.equal(clStartsShell("QSH CMD('ls')"), true);
  assert.equal(clStartsShell("qsys/strqsh"), true);
  assert.equal(clStartsShell("CALL PGM(QP2SHELL) PARM('/QOpenSys/usr/bin/rm' '-rf' '/x')"), true);
  assert.equal(clStartsShell("SBMJOB CMD(QSH CMD('rm -rf /x')) JOB(X)"), true);
  assert.equal(clStartsShell("CRTBNDRPG PGM(QSHLIB/PGMA)"), false);
  assert.equal(clStartsShell("DSPLIB QGPL"), false);

  assert.equal(isShellOperation({ sql: "CALL QSYS2.QCMDEXC('QSH CMD(''rm -rf /x'')')" }), true);
  assert.equal(isShellOperation({ sql: "CALL QSYS2.QCMDEXC(:cmd)" }), true);
  assert.equal(isShellOperation({ sql: "UPDATE DEVLIB.T SET A = 1" }), false);
  assert.equal(isShellOperation({ command: "DLTPGM DEVLIB/X" }), false);
  assert.equal(isShellOperation({ command: "ls", environment: "qsh" }), true);
});

test("the agent cannot change a connection's policy or safety settings", async () => {
  const ctx = { store: {}, getPolicy: () => GUARDED };
  await assert.rejects(
    handleTool(ctx, "ibmi.connections.update", { name: "DEV", policy: { profile: "power-user" } }),
    /cannot set a connection's policy/
  );
  await assert.rejects(
    handleTool(ctx, "ibmi.connections.add", { name: "NEW", host: "h", username: "u", policy: { profile: "power-user" } }),
    /cannot set a connection's policy/
  );
  for (const key of ["readOnlyMode", "tempDir", "autoClearTempData", "mapepireServerPath"]) {
    await assert.rejects(
      handleTool(ctx, "ibmi.connections.update", { name: "DEV", settings: { [key]: key === "tempDir" ? "/home/X" : false } }),
      new RegExp(`cannot change ${key}`)
    );
  }
});

test("the agent can still change everyday connection settings", async () => {
  const saved = [];
  const stored = { name: "DEV", host: "dev.example.com", port: 22, username: "DEVUSER", settings: {}, policy: GUARDED };
  const ctx = {
    getPolicy: () => GUARDED,
    store: {
      getConnection: async name => (name === "DEV" ? structuredClone(stored) : undefined),
      upsertConnection: async conn => { saved.push(conn); }
    }
  };
  await handleTool(ctx, "ibmi.connections.update", { name: "DEV", settings: { currentLibrary: "DEVLIB", libraryList: ["DEVLIB"] } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].settings.currentLibrary, "DEVLIB");
  assert.deepEqual(saved[0].policy, GUARDED);
});

// ---- the prompt itself, over a real MCP client/server pair ----

async function connectPair(clientCapabilities, onElicit) {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { tools: {} } });
  const client = new Client({ name: "test-client", version: "0" }, { capabilities: clientCapabilities });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const REQUEST = {
  operation: "shell.run",
  connectionName: "DEV",
  toolName: "ibmi.cl.run",
  details: ["command: rm -rf /tmp/x", "environment: pase"],
  allowSession: false
};

test("the confirmation prompt reaches the client and its answer decides", async () => {
  const seen = [];
  const { server, client } = await connectPair({ elicitation: {} }, async request => {
    seen.push(request.params);
    return seen.length === 1 ? { action: "accept", content: {} } : { action: "decline" };
  });
  const confirm = createElicitationConfirm(server);
  assert.deepEqual(await confirm(REQUEST), { allowed: true, forSession: false });
  assert.deepEqual(await confirm(REQUEST), { allowed: false, forSession: false });
  assert.match(seen[0].message, /run a shell command on IBM i connection "DEV"/);
  assert.match(seen[0].message, /command: rm -rf \/tmp\/x/);
  assert.deepEqual(seen[0].requestedSchema.properties, {});
  await client.close();
});

test("the session allowance is offered only when allowed and read back from the answer", async () => {
  const { server, client } = await connectPair({ elicitation: {} }, async request => {
    assert.ok(request.params.requestedSchema.properties.allowForSession);
    return { action: "accept", content: { allowForSession: true } };
  });
  const confirm = createElicitationConfirm(server);
  assert.deepEqual(
    await confirm({ ...REQUEST, operation: "qsys.write", allowSession: true }),
    { allowed: true, forSession: true }
  );
  await client.close();
});

test("a client without elicitation is reported as unsupported", async () => {
  const { server, client } = await connectPair({}, undefined);
  assert.equal(await createElicitationConfirm(server)(REQUEST), "unsupported");
  await client.close();
});

test("deleting a library under guarded is confirmed on its own, even after a session allowance", async () => {
  const { conn, calls } = fakeConn();
  const { ctx, prompts } = context(conn, GUARDED, [{ allowed: true, forSession: true }, { allowed: false }]);
  const args = { library: "OLDLIB", objectType: "*LIB", confirmName: "OLDLIB" };
  await assert.rejects(handleTool(ctx, "ibmi.objects.delete", args), /was not confirmed/);
  assert.deepEqual(prompts.map(p => [p.operation, p.allowSession]), [["qsys.write", true], ["qsys.deleteLibrary", false]]);
  assert.ok(prompts[1].details.includes("confirmName: OLDLIB"));
  assert.equal(calls.sql.length, 0);
});

test("audit purge and journal receiver deletes ask the user under guarded", async () => {
  const { conn } = fakeConn();
  const { ctx, prompts } = context(conn, GUARDED);
  await assert.rejects(
    handleTool(ctx, "ibmi.audit.purge", { before: "2000-01-01T00:00:00Z", approve: true }),
    /'audit.purge' was not confirmed/
  );
  await assert.rejects(
    handleTool(ctx, "ibmi.journal.receivers.retention", { journalLibrary: "DEVLIB", journal: "JRN", dryRun: false, approve: true }),
    /'journal.receivers.delete' was not confirmed/
  );
  assert.equal(prompts.length, 2);
});
