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

test("guarded libl tools advertise optional approve argument", () => {
  const names = [
    "ibmi.libl.set",
    "ibmi.libl.add",
    "ibmi.libl.remove",
    "ibmi.libl.setCurrent"
  ];

  for (const name of names) {
    const tool = getTools().find(t => t.name === name);
    assert.ok(tool, `${name} tool is missing`);
    assert.equal(tool.inputSchema.properties.approve.type, "boolean");
  }
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

test("ibmi.tn5250.sendKeys supports guarded approval and timeout", () => {
  const tool = getTools().find(t => t.name === "ibmi.tn5250.sendKeys");
  assert.ok(tool, "ibmi.tn5250.sendKeys tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    keys: "Enter",
    timeoutMs: 15000,
    approve: true,
    connectionName: "Prism PCR image"
  });
  assert.equal(valid.length, 0);
});

test("ibmi.audit.list accepts filter arguments", () => {
  const tool = getTools().find(t => t.name === "ibmi.audit.list");
  assert.ok(tool, "ibmi.audit.list tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    limit: 100,
    tool: "ibmi.cl.run",
    status: "ok",
    connectionName: "Prism PCR image",
    correlationId: "1234",
    since: "2026-03-12T00:00:00.000Z"
  });
  assert.equal(valid.length, 0);
});

test("ibmi.journal.startPf supports guarded approve argument", () => {
  const tool = getTools().find(t => t.name === "ibmi.journal.startPf");
  assert.ok(tool, "ibmi.journal.startPf tool is missing");
  assert.equal(tool.inputSchema.properties.approve.type, "boolean");

  const valid = validateToolInput(tool.inputSchema, {
    library: "MYLIB",
    file: "MYFILE",
    journalLibrary: "MYLIB",
    journal: "MYJRN",
    images: "*BOTH",
    approve: true
  });
  assert.equal(valid.length, 0);
});

test("ibmi.audit.export validates format and output path", () => {
  const tool = getTools().find(t => t.name === "ibmi.audit.export");
  assert.ok(tool, "ibmi.audit.export tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    outputPath: "C:/tmp/audit-export.jsonl",
    format: "jsonl",
    limit: 100
  });
  assert.equal(valid.length, 0);
});

test("ibmi.audit.purge accepts before/dryRun/approve", () => {
  const tool = getTools().find(t => t.name === "ibmi.audit.purge");
  assert.ok(tool, "ibmi.audit.purge tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    before: "2026-03-13T00:00:00.000Z",
    dryRun: true,
    approve: true
  });
  assert.equal(valid.length, 0);
});

test("ibmi.journal.entries.query validates required arguments", () => {
  const tool = getTools().find(t => t.name === "ibmi.journal.entries.query");
  assert.ok(tool, "ibmi.journal.entries.query tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    journalLibrary: "MYLIB",
    journal: "MYJRN",
    objectLibrary: "MYLIB",
    objectName: "MYFILE",
    limit: 100
  });
  assert.equal(valid.length, 0);
});

test("ibmi.qaudjrn.events.query supports filter arguments", () => {
  const tool = getTools().find(t => t.name === "ibmi.qaudjrn.events.query");
  assert.ok(tool, "ibmi.qaudjrn.events.query tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    journalCode: "T",
    entryType: "AF",
    userName: "QPGMR",
    jobName: "123456/QPGMR/JOB1",
    programName: "MYPGM",
    limit: 250
  });
  assert.equal(valid.length, 0);
});

test("ibmi.journal.startIfs and retention tools advertise approve", () => {
  const startIfs = getTools().find(t => t.name === "ibmi.journal.startIfs");
  assert.ok(startIfs, "ibmi.journal.startIfs tool is missing");
  assert.equal(startIfs.inputSchema.properties.approve.type, "boolean");

  const retention = getTools().find(t => t.name === "ibmi.journal.receivers.retention");
  assert.ok(retention, "ibmi.journal.receivers.retention tool is missing");
  assert.equal(retention.inputSchema.properties.approve.type, "boolean");
});

test("ibmi.compliance.report.generate validates preset and signing options", () => {
  const tool = getTools().find(t => t.name === "ibmi.compliance.report.generate");
  assert.ok(tool, "ibmi.compliance.report.generate tool is missing");

  const valid = validateToolInput(tool.inputSchema, {
    preset: "phase6_baseline",
    sinceTimestamp: "2026-03-12T00:00:00.000Z",
    auditLimit: 500,
    qaudLimit: 250,
    outputPath: "C:/tmp/compliance.json",
    sign: true,
    signingKey: "test-signing-key",
    includeRaw: true
  });
  assert.equal(valid.length, 0);
});

test("phase 7 guarded write tools advertise optional approve argument", () => {
  const names = [
    "ibmi.spool.hold",
    "ibmi.spool.release",
    "ibmi.spool.delete",
    "ibmi.spool.move",
    "ibmi.jobs.hold",
    "ibmi.jobs.release",
    "ibmi.jobs.end",
    "ibmi.subsystems.start",
    "ibmi.subsystems.end",
    "ibmi.msgq.send",
    "ibmi.msgq.reply",
    "ibmi.dataqueue.send",
    "ibmi.dataarea.write"
  ];

  for (const name of names) {
    const tool = getTools().find(t => t.name === name);
    assert.ok(tool, `${name} tool is missing`);
    assert.equal(tool.inputSchema.properties.approve.type, "boolean");
  }
});

test("phase 7 operations schemas validate required arguments", () => {
  const jobsEnd = getTools().find(t => t.name === "ibmi.jobs.end");
  assert.ok(jobsEnd, "ibmi.jobs.end tool is missing");

  const missingJobName = validateToolInput(jobsEnd.inputSchema, { option: "*CNTRLD" });
  assert.ok(missingJobName.some(msg => msg.includes("$.jobName is required")));

  const validJobsEnd = validateToolInput(jobsEnd.inputSchema, {
    jobName: "123456/PGMASHISH/MYJOB",
    option: "*IMMED",
    delaySeconds: 0,
    approve: true
  });
  assert.equal(validJobsEnd.length, 0);

  const msgqReply = getTools().find(t => t.name === "ibmi.msgq.reply");
  assert.ok(msgqReply, "ibmi.msgq.reply tool is missing");
  const validMsgqReply = validateToolInput(msgqReply.inputSchema, {
    library: "QSYS",
    messageQueue: "QSYSOPR",
    messageKey: "00A1B2C3",
    reply: "C"
  });
  assert.equal(validMsgqReply.length, 0);
});
