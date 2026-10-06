import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleTool } from "../dist/mcp/tools.js";
import { IBMiContent } from "../dist/ibmi/IBMiContent.js";
import { Search } from "../dist/ibmi/Search.js";
import { csvEscape } from "../dist/mcp/audit.js";

function fakeConn(overrides = {}) {
  const calls = { sql: [], commands: [], qsh: [] };
  const conn = {
    currentConnectionName: "DEV",
    remoteFeatures: { grep: "/usr/bin/grep", find: "/usr/bin/find", setccsid: "/usr/bin/setccsid" },
    readOnlyMode: false,
    getConfig() {
      return { readOnlyMode: conn.readOnlyMode };
    },
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      return overrides.runSQL ? overrides.runSQL(sql, calls) : [];
    },
    async sendCommand(options) {
      calls.commands.push(options.command);
      return overrides.sendCommand
        ? overrides.sendCommand(options, calls)
        : { code: 0, stdout: "", stderr: "" };
    },
    async sendQsh(options) {
      calls.qsh.push(options.command);
      return overrides.sendQsh ? overrides.sendQsh(options, calls) : { code: 0, stdout: "", stderr: "" };
    },
    content: overrides.content || {},
    client: overrides.client
  };
  return { conn, calls };
}

function context(conn, policy = { profile: "power-user" }) {
  return {
    store: {},
    activeName: "DEV",
    ensureActive: async () => conn,
    getPolicy: () => policy
  };
}

function data(response) {
  return response.structuredContent.data;
}

// ---- R14: write tools report failures ----

test("ifs.mkdir, ifs.delete and deploy.setCcsid throw when the command fails", async () => {
  const { conn } = fakeConn({ sendCommand: () => ({ code: 1, stdout: "", stderr: "mkdir: Permission denied" }) });
  const ctx = context(conn);
  await assert.rejects(handleTool(ctx, "ibmi.ifs.mkdir", { path: "/home/dev/new" }), /mkdir failed.*Permission denied/);
  await assert.rejects(handleTool(ctx, "ibmi.ifs.delete", { path: "/home/dev/old.txt" }), /rm failed/);
  await assert.rejects(handleTool(ctx, "ibmi.deploy.setCcsid", { remotePath: "/home/dev/x" }), /setccsid failed/);
});

test("ifs.mkdir still returns OK when the command succeeds", async () => {
  const { conn } = fakeConn();
  const response = await handleTool(context(conn), "ibmi.ifs.mkdir", { path: "/home/dev/new" });
  assert.equal(response.structuredContent.text, "OK");
});

test("member, source file and library writes throw when the CL command fails", async () => {
  const qsh = [];
  const ibmi = {
    getConfig: () => ({ readOnlyMode: false }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(name),
    async sendQsh(options) {
      qsh.push(options.command);
      return { code: 1, stdout: "", stderr: "CPF7306: Member ORDER not added to file." };
    }
  };
  const content = new IBMiContent(ibmi);
  await assert.rejects(content.createMember("MYLIB", "QRPGLESRC", "ORDER", "RPGLE"), /ADDPFM failed.*CPF7306/);
  await assert.rejects(content.renameMember("MYLIB", "QRPGLESRC", "ORDER", "ORDER2"), /RNMM failed/);
  await assert.rejects(content.deleteMember("MYLIB", "QRPGLESRC", "ORDER"), /RMVM failed/);
  await assert.rejects(content.createSourceFile("MYLIB", "QRPGLESRC"), /CRTSRCPF failed/);
  await assert.rejects(content.createLibrary("MYLIB"), /CRTLIB failed/);
});

test("CL commands sent through qsh escape $ in object names", async () => {
  const qsh = [];
  const ibmi = {
    getConfig: () => ({ readOnlyMode: false }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(name),
    async sendQsh(options) {
      qsh.push(options.command);
      return { code: 0, stdout: "", stderr: "" };
    }
  };
  const content = new IBMiContent(ibmi);
  await content.createMember("$LIB", "QRPGLESRC", "#ORDER", "RPGLE");
  assert.equal(qsh[0], `system "ADDPFM FILE(\\$LIB/QRPGLESRC) MBR(#ORDER) SRCTYPE(RPGLE)"`);
});

test("deploy.sync only records uploads that succeeded and returns an error", async () => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfori-sync-"));
  await fs.mkdir(path.join(localRoot, "src"));
  await fs.writeFile(path.join(localRoot, "src", "a.txt"), "a");
  await fs.writeFile(path.join(localRoot, "b.txt"), "b");
  try {
    const uploads = [];
    const { conn } = fakeConn({
      sendCommand: options => {
        if (options.command.includes(" -type f ")) return { code: 0, stdout: "", stderr: "" };
        if (options.command.startsWith("mkdir -p") && options.command.includes("/src")) {
          return { code: 1, stdout: "", stderr: "mkdir: Permission denied" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      client: {
        async putFile(local, remote) {
          uploads.push(remote);
        }
      }
    });
    const response = await handleTool(context(conn), "ibmi.deploy.sync", { localPath: localRoot, remotePath: "/home/dev/app" });
    assert.equal(response.isError, true);
    const payload = response.structuredContent.data;
    assert.deepEqual(payload.applied.uploaded, ["b.txt"]);
    assert.equal(payload.errors.length, 1);
    assert.equal(payload.errors[0].path, "src/a.txt");
    assert.deepEqual(uploads, ["/home/dev/app/b.txt"]);
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test("failed CL write tools come back as tool errors", async () => {
  const { conn } = fakeConn({ runSQL: () => { throw new Error("CPF3303: File QSYSPRT not found."); } });
  const response = await handleTool(context(conn), "ibmi.spool.release", {
    jobName: "123456/DEV/JOB",
    spooledFileName: "QSYSPRT",
    spooledFileNumber: 1
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.data.ok, false);
});

// ---- R15: broken commands and queries ----

test("spool.hold uses HLDSPLF and spool.read selects ORDINAL_POSITION", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => sql.includes("display_spooled_file_data")
      ? [{ ORDINAL_POSITION: 1, SPOOLED_DATA: "PAGE 1" }]
      : []
  });
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.spool.hold", { jobName: "123456/DEV/JOB", spooledFileName: "QSYSPRT", spooledFileNumber: 2 });
  assert.match(calls.sql[0], /QCMDEXC\('HLDSPLF FILE\(QSYSPRT\) JOB\(123456\/DEV\/JOB\) SPLNBR\(2\)'\)/);

  const lines = data(await handleTool(ctx, "ibmi.spool.read", {
    jobName: "123456/DEV/JOB",
    spooledFileName: "QSYSPRT",
    spooledFileNumber: 2
  }));
  assert.match(calls.sql[1], /select ordinal_position, spooled_data/);
  assert.doesNotMatch(calls.sql[1], /line_number/);
  assert.equal(lines[0].lineNumber, 1);
  assert.equal(lines[0].text, "PAGE 1");
});

test("dataqueue.send falls back to the QSNDDTAQ API, not a SNDDTAQ command", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("send_data_queue")) throw new Error("SEND_DATA_QUEUE in QSYS2 type *N not found. (42704)");
      return [];
    }
  });
  const response = await handleTool(context(conn), "ibmi.dataqueue.send", { library: "MYLIB", queue: "MYQ", message: "HELLO" });
  assert.equal(response.isError, undefined);
  assert.match(calls.sql[0], /send_data_queue\(message_data => 'HELLO', data_queue => 'MYQ', data_queue_library => 'MYLIB'\)/);
  assert.match(calls.sql[1], /CALL PGM\(QSYS\/QSNDDTAQ\) PARM\(\(''MYQ'' \(\*CHAR 10\)\) \(''MYLIB'' \(\*CHAR 10\)\) \(5 \(\*DEC 5 0\)\) \(''HELLO'' \(\*CHAR 5\)\)\)/);
  assert.doesNotMatch(calls.sql.join("\n"), /SNDDTAQ /);
});

test("journal DSPJRN fallback runs the command and the query in one SQL request", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("display_journal")) throw new Error("DISPLAY_JOURNAL not found (42704)");
      return [{ JOSEQN: 10, JOCODE: "F", JOENTT: "OP", JOLIB: "MYLIB", JOOBJ: "ORDERS", JOUSPF: "DEV" }];
    }
  });
  const rows = data(await handleTool(context(conn), "ibmi.journal.entries.query", {
    journalLibrary: "MYLIB",
    journal: "MYJRN",
    objectLibrary: "MYLIB",
    objectName: "ORDERS",
    userName: "DEV",
    limit: 5
  }));
  assert.equal(calls.sql.length, 2);
  const outfileSql = calls.sql[1];
  const outfile = outfileSql.match(/OUTFILE\(QTEMP\/(MCPJ\d+)\)/)[1];
  assert.match(outfileSql, /^CALL QSYS2\.QCMDEXC\('DSPJRN JRN\(MYLIB\/MYJRN\) OUTPUT\(\*OUTFILE\) OUTFILFMT\(\*TYPE5\)/);
  assert.match(outfileSql, new RegExp(`select \\* from QTEMP\\.${outfile} where JOLIB = 'MYLIB' and JOOBJ = 'ORDERS' and JOUSPF = 'DEV' order by JOSEQN desc fetch first 5 rows only`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userName, "DEV");
});

// ---- R16: filters before the row cap ----

test("journal.entries.query pushes filters into DISPLAY_JOURNAL before FETCH FIRST", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => [{ SEQUENCE_NUMBER: 7, JOURNAL_CODE: "R", JOURNAL_ENTRY_TYPE: "PT" }] });
  await handleTool(context(conn), "ibmi.journal.entries.query", {
    journalLibrary: "MYLIB",
    journal: "MYJRN",
    objectLibrary: "MYLIB",
    objectName: "ORDERS",
    journalCode: "R",
    entryType: "PT",
    userName: "DEV",
    programName: "ORDPGM",
    jobName: "ORDJOB",
    sinceTimestamp: "2026-10-01 08:30:00",
    limit: 25
  });
  const sql = calls.sql[0];
  assert.match(sql, /journal_library => 'MYLIB', journal_name => 'MYJRN'/);
  assert.match(sql, /starting_receiver_name => '\*CURCHAIN'/);
  assert.match(sql, /starting_timestamp => timestamp\('2026-10-01-08\.30\.00\.000000'\)/);
  assert.match(sql, /journal_codes => 'R'/);
  assert.match(sql, /journal_entry_types => 'PT'/);
  assert.match(sql, /object_library => 'MYLIB', object_name => 'ORDERS', object_objtype => '\*FILE', object_member => '\*ALL'/);
  assert.match(sql, /user => 'DEV'/);
  assert.match(sql, /program => 'ORDPGM'/);
  assert.match(sql, /where job_name = 'ORDJOB' order by sequence_number desc fetch first 25 rows only$/);
});

test("qaudjrn and compliance queries convert UTC timestamps on the IBM i", async () => {
  const { conn, calls } = fakeConn();
  await handleTool(context(conn), "ibmi.qaudjrn.events.query", {
    journalCode: "T",
    entryType: "PW",
    sinceTimestamp: "2026-10-01T12:00:00Z"
  });
  assert.match(calls.sql[0], /journal_library => 'QSYS', journal_name => 'QAUDJRN'/);
  assert.match(calls.sql[0], /starting_timestamp => \(timestamp\('2026-10-01-12\.00\.00\.000000'\) \+ current timezone\)/);
  assert.match(calls.sql[0], /journal_codes => 'T'/);
});

test("locks.list filters in the OBJECT_LOCK_INFO query", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [{ OBJECT_SCHEMA: "MYLIB", OBJECT_NAME: "ORDERS", OBJECT_TYPE: "*FILE", SYSTEM_TABLE_MEMBER: "ORDERS", LOCK_STATE: "*SHRRD" }]
  });
  const rows = data(await handleTool(context(conn), "ibmi.locks.list", {
    objectLibrary: "mylib",
    objectName: "orders",
    objectType: "*file",
    member: "orders",
    limit: 10
  }));
  assert.equal(
    calls.sql[0],
    "select * from qsys2.object_lock_info where object_schema = 'MYLIB' and object_name = 'ORDERS' and object_type = '*FILE' and system_table_member = 'ORDERS' fetch first 10 rows only"
  );
  assert.equal(rows[0].member, "ORDERS");
});

// ---- R17: data queue peek is never destructive ----

test("dataqueue.receive peeks by default and never falls back to a destructive receive", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("receive_data_queue")) throw new Error("REMOVE not valid (42613)");
      return [{ MESSAGE_DATA: "HELLO", ORDINAL_POSITION: 1 }];
    }
  });
  const rows = data(await handleTool(context(conn), "ibmi.dataqueue.receive", { library: "MYLIB", queue: "MYQ", waitSeconds: 99999 }));
  assert.equal(rows[0].message, "HELLO");
  assert.match(calls.sql[0], /remove => 'NO'/);
  assert.match(calls.sql[0], /wait_time => 60/);
  assert.match(calls.sql[1], /qsys2\.data_queue_entries/);
  assert.doesNotMatch(calls.sql.join("\n"), /'YES'/);
});

test("dataqueue.receive with remove=true goes through the write gate", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => [] });
  conn.readOnlyMode = true;
  await assert.rejects(
    handleTool(context(conn), "ibmi.dataqueue.receive", { library: "MYLIB", queue: "MYQ", remove: true }),
    /read-only/
  );
  assert.equal(calls.sql.length, 0);

  const writable = fakeConn({ runSQL: () => [] });
  await handleTool(context(writable.conn), "ibmi.dataqueue.receive", { library: "MYLIB", queue: "MYQ", remove: true });
  assert.match(writable.calls.sql[0], /remove => 'YES'/);
});

// ---- R20: retention dryRun default ----

test("journal.receivers.retention defaults to a dry run", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [{ JOURNAL_RECEIVER_LIBRARY: "MYLIB", JOURNAL_RECEIVER: "RCV0001", DETACH_TIMESTAMP: "2020-01-01 00:00:00" }]
  });
  const response = data(await handleTool(context(conn), "ibmi.journal.receivers.retention", {
    journalLibrary: "MYLIB",
    journal: "MYJRN",
    retentionDays: 30,
    approve: true
  }));
  assert.equal(response.dryRun, true);
  assert.equal(response.candidates.length, 1);
  assert.equal(calls.sql.some(sql => sql.includes("DLTJRNRCV")), false);
});

// ---- R39: caps and ordering ----

test("sql.query caps rows in SQL and reports truncation", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => [{ A: 1 }, { A: 2 }, { A: 3 }] });
  const ctx = { ...context(conn), createSqlCursor: () => ({ cursor: undefined }) };
  const response = data(await handleTool(ctx, "ibmi.sql.query", { sql: "select a from t order by a;", maxRows: 2 }));
  assert.equal(calls.sql[0], "select a from t order by a\nfetch first 3 rows only");
  assert.equal(response.totalRows, 2);
  assert.equal(response.truncated, true);
  assert.match(response.truncationNote, /more than 2 rows/);
});

test("sql.query leaves queries that already limit rows unchanged", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => [{ A: 1 }] });
  const ctx = { ...context(conn), createSqlCursor: () => ({ cursor: undefined }) };
  await handleTool(ctx, "ibmi.sql.query", { sql: "select a from t fetch first 5 rows only" });
  await handleTool(ctx, "ibmi.sql.query", { sql: "select a from t with ur" });
  assert.equal(calls.sql[0], "select a from t fetch first 5 rows only");
  assert.equal(calls.sql[1], "select a from t with ur");
});

test("msgq.read returns newest messages first", async () => {
  const { conn, calls } = fakeConn();
  await handleTool(context(conn), "ibmi.msgq.read", { limit: 5 });
  assert.match(calls.sql[0], /message_queue_info\(queue_library => 'QSYS', queue_name => 'QSYSOPR'\)\) order by message_timestamp desc fetch first 5 rows only/);
});

test("libraries.list turns a generic filter into LIKE", async () => {
  const sql = [];
  const ibmi = {
    getConfig: () => ({}),
    async runSQL(statement) {
      sql.push(statement);
      return [{ OBJNAME: "DEVLIB", OBJTEXT: "Dev" }];
    }
  };
  const content = new IBMiContent(ibmi);
  const libs = await content.getLibraries("dev*");
  assert.match(sql[0], /OBJECT_STATISTICS\('QSYS', '\*LIB', '\*ALLSIMPLE'\)\) where OBJNAME like 'DEV%' escape '!'/);
  assert.equal(libs[0].name, "DEVLIB");
  await content.getLibraries("*");
  assert.match(sql[1], /OBJECT_STATISTICS\('\*ALL', 'LIB'/);
});

test("spool.list filters by user, output queue and job in SQL", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => [] });
  await handleTool(context(conn), "ibmi.spool.list", {
    userName: "dev",
    outputQueue: "qprint",
    outputQueueLibrary: "qgpl",
    jobName: "123456/DEV/ORDJOB",
    limit: 20
  });
  assert.equal(
    calls.sql[0],
    "select * from qsys2.output_queue_entries where user_name = 'DEV' and output_queue_name = 'QPRINT' and output_queue_library_name = 'QGPL' and job_name = '123456/DEV/ORDJOB' order by create_timestamp desc fetch first 20 rows only"
  );
  await handleTool(context(conn), "ibmi.spool.list", { jobName: "ORDJOB" });
  assert.match(calls.sql[1], /job_name like '%\/ORDJOB'/);
});

// ---- R46: small tool fixes ----

test("msgq.send sends *COMP and *DIAG with SNDPGMMSG", async () => {
  const { conn, calls } = fakeConn();
  const response = data(await handleTool(context(conn), "ibmi.msgq.send", { message: "Done", messageType: "*COMP" }));
  assert.equal(response.mappedMessageType, "*COMP");
  assert.match(calls.sql[0], /SNDPGMMSG MSG\(''Done''\) TOMSGQ\(QSYS\/QSYSOPR\) MSGTYPE\(\*COMP\)/);
  await handleTool(context(conn), "ibmi.msgq.send", { message: "Note", messageType: "*DIAG" });
  assert.match(calls.sql[1], /MSGTYPE\(\*DIAG\)/);
});

test("dataarea.write formats values by data area type", async () => {
  const typeFor = { DECAREA: ["*DEC", 7, 2], LGLAREA: ["*LGL", 1, null], CHRAREA: ["*CHAR", 10, null] };
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      const match = sql.match(/data_area_name => '(\w+)'/);
      if (match) {
        const [type, length, decimals] = typeFor[match[1]];
        return [{ DATA_AREA_TYPE: type, LENGTH: length, DECIMAL_POSITIONS: decimals }];
      }
      return [];
    }
  });
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.dataarea.write", { library: "MYLIB", dataArea: "DECAREA", value: "123.45" });
  assert.match(calls.sql.at(-1), /CHGDTAARA DTAARA\(MYLIB\/DECAREA\) VALUE\(123\.45\)/);
  await handleTool(ctx, "ibmi.dataarea.write", { library: "MYLIB", dataArea: "LGLAREA", value: "true" });
  assert.match(calls.sql.at(-1), /CHGDTAARA DTAARA\(MYLIB\/LGLAREA\) VALUE\(''1''\)/);
  await handleTool(ctx, "ibmi.dataarea.write", { library: "MYLIB", dataArea: "CHRAREA", value: "AB" });
  assert.match(calls.sql.at(-1), /CHGDTAARA DTAARA\(MYLIB\/CHRAREA \(1 2\)\) VALUE\(''AB''\)/);
  await assert.rejects(handleTool(ctx, "ibmi.dataarea.write", { library: "MYLIB", dataArea: "DECAREA", value: "abc" }), /numeric/);
  await assert.rejects(handleTool(ctx, "ibmi.dataarea.write", { library: "MYLIB", dataArea: "DECAREA", value: "123456" }), /does not fit/);
});

test("ifs.read returns binary content as base64 and enforces maxBytes", async () => {
  const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  const { conn } = fakeConn({
    sendCommand: () => ({ code: 0, stdout: "-rw-r--r-- 1 dev 0 4 Oct 06 10:00 /home/dev/a.bin\n", stderr: "" }),
    content: { downloadStreamfileRaw: async () => binary }
  });
  const ctx = context(conn);
  const response = data(await handleTool(ctx, "ibmi.ifs.read", { path: "/home/dev/a.bin" }));
  assert.equal(response.encoding, "base64");
  assert.equal(Buffer.from(response.content, "base64").equals(binary), true);

  const tooBig = await handleTool(ctx, "ibmi.ifs.read", { path: "/home/dev/a.bin", maxBytes: 2 });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.content[0].text, /more than maxBytes/);

  const text = fakeConn({ content: { downloadStreamfileRaw: async () => Buffer.from("héllo", "utf8") } });
  const textResponse = await handleTool(context(text.conn), "ibmi.ifs.read", { path: "/home/dev/a.txt" });
  assert.equal(textResponse.structuredContent.text, "héllo");
});

test("CSV export cells cannot start a spreadsheet formula", () => {
  assert.equal(csvEscape("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvEscape("+1"), "'+1");
  assert.equal(csvEscape("-2"), "'-2");
  assert.equal(csvEscape("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvEscape("\tx"), "'\tx");
  assert.equal(csvEscape("plain"), "plain");
});

test("member search filters escape # and $ instead of rejecting them", async () => {
  const commands = [];
  const conn = {
    remoteFeatures: {},
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(name),
    async sendCommand(options) {
      commands.push(options.command);
      return { code: 0, stdout: "", stderr: "" };
    }
  };
  await Search.searchMembersTerms(conn, "MYLIB", "QRPGLESRC", ["X"], ["#ORDER", "$PAY", "@AUDIT"]);
  assert.match(commands[0], / \\#ORDER\.MBR \\\$PAY\.MBR @AUDIT\.MBR$/);
  await assert.rejects(Search.searchMembersTerms(conn, "MYLIB", "QRPGLESRC", ["X"], "A;rm"), /Invalid members filter/);
});

// ---- R36: IFS search and find ----

test("findIFS keeps results when find exits non-zero and drops empty lines", async () => {
  const conn = {
    remoteFeatures: { find: "/usr/bin/find" },
    async sendCommand() {
      return { code: 1, stdout: "/home/dev/a.rpgle\n/home/dev/b.rpgle\n", stderr: "find: /home/dev/private: Permission denied\n" };
    }
  };
  const resultSet = await Search.findIFS(conn, "/home/dev", "rpgle");
  assert.deepEqual(resultSet.hits.map(hit => hit.path), ["/home/dev/a.rpgle", "/home/dev/b.rpgle"]);
  assert.deepEqual(resultSet.warnings, ["find: /home/dev/private: Permission denied"]);
  assert.equal(resultSet.exitCode, 1);
});

test("searchIFS keeps matches when grep exits 2 for an unreadable directory", async () => {
  const conn = {
    remoteFeatures: { grep: "/usr/bin/grep" },
    async sendCommand() {
      return { code: 2, stdout: "/home/dev/a.txt:3:hello world\n", stderr: "grep: /home/dev/private: Permission denied\n" };
    }
  };
  const resultSet = await Search.searchIFS(conn, "/home/dev", "hello");
  assert.equal(resultSet.hits.length, 1);
  assert.deepEqual(resultSet.hits[0].lines, [{ number: 3, content: "hello world" }]);
  assert.equal(resultSet.warnings.length, 1);
});

test("searchIFS with no matches returns an empty list without warnings", async () => {
  const conn = {
    remoteFeatures: { grep: "/usr/bin/grep" },
    async sendCommand() {
      return { code: 1, stdout: "", stderr: "" };
    }
  };
  const resultSet = await Search.searchIFS(conn, "/home/dev", "nothing");
  assert.deepEqual(resultSet.hits, []);
  assert.equal(resultSet.warnings, undefined);
});
