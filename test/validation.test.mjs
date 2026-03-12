import test from "node:test";
import assert from "node:assert/strict";
import { getTools } from "../dist/mcp/tools.js";
import { validateToolInput } from "../dist/mcp/validation.js";

test("ibmi.connect requires saved connection name", () => {
  const tool = getTools().find(t => t.name === "ibmi.connect");
  assert.ok(tool, "ibmi.connect tool is missing");

  const missing = validateToolInput(tool.inputSchema, {});
  assert.ok(missing.some(msg => msg.includes("$.name is required")));

  const withName = validateToolInput(tool.inputSchema, { name: "DEV400" });
  assert.equal(withName.length, 0);

  const withLegacyFields = validateToolInput(tool.inputSchema, { name: "DEV400", host: "legacy.example.com" });
  assert.ok(withLegacyFields.some(msg => msg.includes("$.host is not allowed")));
});

test("ibmi.sql.execute validates sql argument type", () => {
  const tool = getTools().find(t => t.name === "ibmi.sql.execute");
  assert.ok(tool, "ibmi.sql.execute tool is missing");

  const wrongType = validateToolInput(tool.inputSchema, { sql: 123 });
  assert.ok(wrongType.some(msg => msg.includes("$.sql must be string")));

  const valid = validateToolInput(tool.inputSchema, { sql: "delete from mylib.mytable" });
  assert.equal(valid.length, 0);

  const validWithTimeout = validateToolInput(tool.inputSchema, { sql: "delete from mylib.mytable", timeoutMs: 12000 });
  assert.equal(validWithTimeout.length, 0);
});

test("ibmi.sql.query supports timeout and metadata flags", () => {
  const tool = getTools().find(t => t.name === "ibmi.sql.query");
  assert.ok(tool, "ibmi.sql.query tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    sql: "select * from qsys2.systables fetch first 1 row only",
    pageSize: 100,
    maxRows: 1000,
    timeoutMs: 30000,
    includeMetadata: true
  });
  assert.equal(valid.length, 0);
});

test("ibmi.cl.run supports timeoutMs", () => {
  const tool = getTools().find(t => t.name === "ibmi.cl.run");
  assert.ok(tool, "ibmi.cl.run tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    command: "DSPJOB",
    environment: "ile",
    timeoutMs: 20000
  });
  assert.equal(valid.length, 0);
});

test("ibmi.connections.add rejects secret-bearing arguments", () => {
  const tool = getTools().find(t => t.name === "ibmi.connections.add");
  assert.ok(tool, "ibmi.connections.add tool is missing");

  const withPassword = validateToolInput(tool.inputSchema, {
    name: "DEV400",
    host: "dev400.company.com",
    username: "DEVUSER",
    password: "secret"
  });
  assert.ok(withPassword.some(msg => msg.includes("$.password is not allowed")));
});

test("guarded write tools advertise optional approve argument", () => {
  const memberWrite = getTools().find(t => t.name === "ibmi.qsys.members.write");
  assert.ok(memberWrite, "ibmi.qsys.members.write tool is missing");
  assert.equal(memberWrite.inputSchema.properties.approve.type, "boolean");

  const withApprove = validateToolInput(memberWrite.inputSchema, {
    library: "PGMASHISH",
    sourceFile: "QRPGLESRC",
    member: "HELLOAI",
    content: "**free\nreturn;\n",
    approve: true
  });
  assert.equal(withApprove.length, 0);
});

test("tool schemas reject unknown arguments by default", () => {
  const memberWrite = getTools().find(t => t.name === "ibmi.qsys.members.write");
  assert.ok(memberWrite, "ibmi.qsys.members.write tool is missing");

  const errors = validateToolInput(memberWrite.inputSchema, {
    library: "PGMASHISH",
    sourceFile: "QRPGLESRC",
    member: "HELLOAI",
    content: "**free\nreturn;\n",
    unexpected: "x"
  });
  assert.ok(errors.some(msg => msg.includes("$.unexpected is not allowed")));
});

test("ibmi.connections.add validates nested settings and policy", () => {
  const tool = getTools().find(t => t.name === "ibmi.connections.add");
  assert.ok(tool, "ibmi.connections.add tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    name: "DEV400",
    host: "dev400.company.com",
    username: "DEVUSER",
    settings: {
      tempLibrary: "ILEDITOR",
      sessionReconnectAttempts: 2
    },
    policy: {
      profile: "guarded",
      requireApprovalFor: ["sql.write", "deploy.sync"]
    }
  });
  assert.equal(valid.length, 0);

  const invalidSettings = validateToolInput(tool.inputSchema, {
    name: "DEV400",
    host: "dev400.company.com",
    username: "DEVUSER",
    settings: {
      debugPort: "bad"
    }
  });
  assert.ok(invalidSettings.some(msg => msg.includes("$.settings.debugPort must be number")));
});

test("ibmi.deploy.sync supports dry-run and delete-extra options", () => {
  const tool = getTools().find(t => t.name === "ibmi.deploy.sync");
  assert.ok(tool, "ibmi.deploy.sync tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    localPath: "C:/tmp/local",
    remotePath: "/tmp/remote",
    overwrite: true,
    dryRun: true,
    deleteExtraRemote: true
  });
  assert.equal(valid.length, 0);
});
