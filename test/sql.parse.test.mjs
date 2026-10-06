import test from "node:test";
import assert from "node:assert/strict";
import { Tools } from "../dist/ibmi/Tools.js";
import {
  checkReadOnlySql,
  isReadOnlySql,
  splitSqlStatements,
  getSqlStatementType,
  extractEmbeddedClCommands
} from "../dist/ibmi/sqlParse.js";
import { IBMiClient } from "../dist/ibmi/client.js";

test("db2Parse extracts rows from QZDFMDB2 tabular output", () => {
  const output = [
    "DB2>",
    "",
    "ROW_COUNT  ",
    "-----------",
    "     124760",
    "",
    "  1 RECORD(S) SELECTED.",
    "",
    "DB2>"
  ].join("\n");

  const rows = Tools.db2Parse(output, "select count(*) as row_count from disk.pcrimp;");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ROW_COUNT, 124760);
});

test("db2Parse throws SqlError when CLI error is present", () => {
  const output = [
    "DB2>",
    "",
    " **** CLI ERROR *****",
    "         SQLSTATE: 42704",
    "NATIVE ERROR CODE: -204",
    "PCRIMP in PGMASHISH type *FILE not found. ",
    "DB2>"
  ].join("\n");

  assert.throws(
    () => Tools.db2Parse(output, "select * from pcrimp"),
    error => error instanceof Tools.SqlError && error.message.includes("42704")
  );
});

test("db2Parse keeps last row when record footer is missing", () => {
  const output = [
    "DB2>",
    "",
    "NOW                       ",
    "--------------------------",
    "2026-03-12-12.34.56.789012",
    "DB2>"
  ].join("\n");

  const rows = Tools.db2Parse(output, "select current timestamp as now from sysibm.sysdummy1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].NOW, "2026-03-12-12.34.56.789012");
});

test("read-only check allows plain queries", () => {
  for (const sql of [
    "select * from qsys2.systables",
    "SELECT 1 FROM SYSIBM.SYSDUMMY1;",
    "  -- comment\nselect 1 from sysibm.sysdummy1  ;  -- trailing\n",
    "/* hdr */ with x as (select 1 a from sysibm.sysdummy1) select * from x",
    "values current timestamp",
    "(select 1 from sysibm.sysdummy1) union (select 2 from sysibm.sysdummy1)",
    "select 'it''s -- not a comment' from sysibm.sysdummy1",
    "select \"Odd--Name\" from t",
    "select a from t for update"
  ]) {
    assert.equal(isReadOnlySql(sql), true, sql);
  }
});

test("read-only check rejects multiple statements", () => {
  for (const sql of [
    "select 1 from sysibm.sysdummy1; drop table x",
    "select 1 from sysibm.sysdummy1;drop table x;",
    "select 1 from sysibm.sysdummy1 /* c */ ; delete from t",
    "select 1 from sysibm.sysdummy1;;"
  ]) {
    const check = checkReadOnlySql(sql);
    assert.equal(check.readOnly, false, sql);
    assert.match(check.reason, /multiple statements/);
  }
});

test("read-only check rejects semicolons hidden in literals or comments", () => {
  for (const sql of [
    "select 1 from t where a <> ';delete from t --'",
    "select 1 from t /* ; delete from t */",
    "select 1 from t -- ; delete from t"
  ]) {
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

test("read-only check rejects @ CL lines and QCMDEXC", () => {
  for (const sql of [
    "select 1 from sysibm.sysdummy1\n@DLTLIB FOO",
    "@DLTLIB FOO",
    "select 1 from t where x = '\n@DLTLIB FOO\n'",
    "select qsys2.qcmdexc('DLTLIB FOO') from sysibm.sysdummy1",
    "select \"QCMDEXC\"('DLTLIB FOO') from sysibm.sysdummy1",
    "values QSYS2 . QCMDEXC ( 'DLTLIB FOO' )"
  ]) {
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

test("read-only check rejects data-change table references and non-queries", () => {
  for (const sql of [
    "select * from final table (insert into t values (1))",
    "SELECT * FROM NEW TABLE(UPDATE t SET a = 1)",
    "select * from old /* x */ table\n(delete from t)",
    "with x as (select * from final table(merge into t using s on 1=1 when matched then delete)) select * from x",
    "delete from t",
    "insert into t select * from s",
    "call qsys2.something()",
    "selectx from t",
    "",
    "-- only a comment",
    "select 'unterminated",
    "select 1 /* unterminated"
  ]) {
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

test("splitSqlStatements respects quotes and comments", () => {
  const parts = splitSqlStatements("insert into t values ('a;b'); /* ; */ select 1 from t -- ;\n; @SNDMSG MSG('x;y') TOUSR(QSYSOPR);\nvalues 1");
  assert.deepEqual(parts.map(p => p.tokens[0].value), ["INSERT", "SELECT", "@SNDMSG", "VALUES"]);
  const clParts = splitSqlStatements("select 1 from t;\n@SNDMSG MSG('x;y') TOUSR(QSYSOPR);\nvalues 1");
  assert.deepEqual(clParts.map(p => p.tokens[0].value), ["SELECT", "SNDMSG MSG('x;y') TOUSR(QSYSOPR)", "VALUES"]);
  assert.equal(clParts[1].tokens[0].type, "cl");
});

test("getSqlStatementType returns the first keyword", () => {
  assert.equal(getSqlStatementType("/* c */\n-- x\n  insert into t values 1"), "INSERT");
  assert.equal(getSqlStatementType("(select 1 from t)"), "SELECT");
  assert.equal(getSqlStatementType("@DLTLIB X"), "CL");
  assert.equal(getSqlStatementType("  "), "UNKNOWN");
});

test("extractEmbeddedClCommands lists @ lines and QCMDEXC arguments", () => {
  const sql = [
    "@CRTLIB LIB(A);",
    "call qsys2.qcmdexc('DLTLIB LIB(''B'')');",
    "call QCMDEXC('CHGJOB LOG(4)', 0000000013.00000);",
    "values qsys2.qcmdexc('DLT' || 'LIB X');",
    "select 'call qcmdexc(''x'')' from t"
  ].join("\n");
  const found = extractEmbeddedClCommands(sql).map(({ source, command }) => ({ source, command }));
  assert.deepEqual(found, [
    { source: "at-line", command: "CRTLIB LIB(A)" },
    { source: "qcmdexc", command: "DLTLIB LIB('B')" },
    { source: "qcmdexc", command: "CHGJOB LOG(4)" },
    { source: "qcmdexc", command: null }
  ]);
});

test("fixSQL keeps -- inside string literals and drops real comments", () => {
  assert.equal(
    Tools.fixSQL("select 'a -- b' from t -- real comment\nwhere x = 1", true),
    "select 'a -- b' from t \nwhere x = 1"
  );
  assert.equal(
    Tools.fixSQL("call qsys2.send_message('CPF9898', 10, 'x--y') /* -- */", true),
    "call qsys2.send_message('CPF9898', 10, 'x--y') /* -- */"
  );
  assert.equal(Tools.fixSQL("-- whole line\nselect 1 from t", true), "\nselect 1 from t");
});

test("fixSQL turns @ lines into QCMDEXC calls but not inside literals", () => {
  assert.equal(
    Tools.fixSQL("@SNDMSG MSG('hi') TOUSR(QSYSOPR);", true),
    "Call QSYS2.QCMDEXC('SNDMSG MSG(''hi'') TOUSR(QSYSOPR)');"
  );
  assert.equal(
    Tools.fixSQL("insert into t values ('line1\n@line2')", true),
    "insert into t values ('line1\n@line2')"
  );
});

test("runSQL sends SQL on stdin, never in the shell command", async () => {
  const calls = [];
  const client = new IBMiClient({ name: "t", host: "h", port: 22, username: "u" });
  client.client = {
    async execCommand(command, options) {
      calls.push({ command, options });
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
  };
  const sql = "select '$(rm -rf ~)' as x from sysibm.sysdummy1\n__MCP_FOR_I_SQL__\nrm -rf /tmp/x\n`id`";
  await client.runSQL(sql);
  assert.equal(calls.length, 1);
  const { command, options } = calls[0];
  assert.doesNotMatch(command, /rm -rf|__MCP_FOR_I_SQL__|sysdummy1|`id`/);
  assert.match(command, /qsh -c /);
  assert.match(command, /QZDFMDB2/);
  assert.equal(options.stdin, `${Tools.fixSQL(sql, true).trim()}\n`);
});

test("runSQL rejects a non-numeric sqlJobCcsid", async () => {
  const client = new IBMiClient({ name: "t", host: "h", port: 22, username: "u", sqlJobCcsid: "1208) X(" });
  client.client = { async execCommand() { throw new Error("should not run"); } };
  await assert.rejects(client.runSQL("select 1 from sysibm.sysdummy1"), /Invalid sqlJobCcsid/);
});
