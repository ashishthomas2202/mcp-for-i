import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleTool, getTools } from "../dist/mcp/tools.js";
import { compareTexts } from "../dist/mcp/modules/compare.js";
import { buildBinderSource, formatSqlType, shapeProgramReference } from "../dist/mcp/modules/inspect.js";

function fakeConn(overrides = {}) {
  const calls = { sql: [], commands: [] };
  const conn = {
    currentConnectionName: "DEV",
    getConfig: () => ({ readOnlyMode: false }),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      return overrides.runSQL ? overrides.runSQL(sql, calls) : [];
    },
    async sendCommand(options) {
      calls.commands.push(options.command);
      return overrides.sendCommand ? overrides.sendCommand(options, calls) : { code: 0, stdout: "", stderr: "" };
    },
    content: overrides.content || {}
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

const data = response => response.structuredContent.data;

// ---- ibmi.compare.text ----

test("compare tools are registered read-only with strict schemas", () => {
  const names = ["ibmi.compare.text", "ibmi.objects.describe", "ibmi.members.describe", "ibmi.ifs.stat", "ibmi.programs.info",
    "ibmi.objects.whereUsed", "ibmi.tables.describe", "ibmi.routines.describe"];
  const tools = getTools();
  for (const name of names) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.connectionName, `${name} connectionName`);
  }
});

test("compareTexts returns a unified diff with counts and context", () => {
  const left = { label: "a", text: "one\ntwo\nthree\nfour\nfive\n" };
  const right = { label: "b", text: "one\ntwo\nTHREE!\nfour\nfive\nsix" };
  const res = compareTexts(left, right, { context: 1, ignoreTrailingWhitespace: true, ignoreCase: false, maxDiffLines: 100 });
  assert.equal(res.identical, false);
  assert.deepEqual(res.stats, { hunks: 1, added: 2, removed: 1 });
  assert.match(res.diff, /^--- a\n\+\+\+ b\n@@ -2,4 \+2,5 @@\n two\n-three\n\+THREE!\n four\n five\n\+six$/);
  const apart = compareTexts(
    { label: "a", text: "1\n2\n3\n4\n5\n6\n7\n8\n" },
    { label: "b", text: "x\n2\n3\n4\n5\n6\n7\ny\n" },
    { context: 1, ignoreTrailingWhitespace: true, ignoreCase: false, maxDiffLines: 100 }
  );
  assert.equal(apart.stats.hunks, 2);
  assert.doesNotMatch(res.diff, /No newline/);
});

test("compareTexts honours ignoreCase, trailing whitespace and the diff line cap", () => {
  const opts = { context: 3, ignoreTrailingWhitespace: true, ignoreCase: true, maxDiffLines: 100 };
  assert.equal(compareTexts({ label: "a", text: "Hello  \r\nWorld" }, { label: "b", text: "hello\nWORLD\n" }, opts).identical, true);
  const strict = compareTexts({ label: "a", text: "x  \n" }, { label: "b", text: "x\n" }, { ...opts, ignoreTrailingWhitespace: false });
  assert.equal(strict.identical, false);
  const big = compareTexts({ label: "a", text: "" }, { label: "b", text: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") }, { ...opts, maxDiffLines: 10 });
  assert.equal(big.truncated, true);
  assert.equal(big.diff.split("\n").length, 10);
  assert.equal(big.stats.added, 50);
});

test("compare.text diffs a member against a local file without sequence numbers or dates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-compare-"));
  const local = path.join(dir, "order.rpgle");
  await fs.writeFile(local, "     D x  S  10A\r\n     C  eval x = 'B'\r\n");
  const previous = process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
  process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = dir;
  try {
    const seen = [];
    const { conn } = fakeConn({
      content: {
        async getMemberSnapshot(lib, file, mbr) {
          seen.push([lib, file, mbr]);
          return { content: "     D x  S  10A          \n     C  eval x = 'A'      " };
        }
      }
    });
    const res = await handleTool(context(conn), "ibmi.compare.text", {
      left: { type: "member", library: "mylib", sourceFile: "qrpglesrc", member: "order" },
      right: { type: "local", path: local },
      context: 0
    });
    const out = data(res);
    assert.deepEqual(seen, [["MYLIB", "QRPGLESRC", "ORDER"]]);
    assert.equal(out.left.label, "MYLIB/QRPGLESRC(ORDER)");
    assert.equal(out.right.type, "local");
    assert.deepEqual(out.stats, { hunks: 1, added: 1, removed: 1 });
    assert.match(out.diff, /@@ -2 \+2 @@\n-     C  eval x = 'A'\n\+     C  eval x = 'B'$/);
  } finally {
    if (previous === undefined) delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    else process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("compare.text reads IFS files, enforces the size cap and per-side policy", async () => {
  const files = { "/home/dev/a.txt": "same\nold\n", "/home/dev/b.txt": "same\nnew\n" };
  const { conn } = fakeConn({
    sendCommand: options => {
      const match = options.command.match(/ls -ldL (.+)$/);
      const file = match ? match[1].replace(/^'|'$/g, "") : "";
      const size = Buffer.byteLength(files[file] || "");
      return { code: 0, stdout: `-rw-r--r-- 1 DEV 0 ${size} Jan 1 00:00 ${file}`, stderr: "" };
    },
    content: { downloadStreamfileRaw: async p => Buffer.from(files[p]) }
  });
  const ok = data(await handleTool(context(conn), "ibmi.compare.text", {
    left: { type: "ifs", path: "/home/dev/a.txt" },
    right: { type: "ifs", path: "/home/dev/b.txt" }
  }));
  assert.equal(ok.stats.added, 1);
  assert.equal(ok.stats.removed, 1);

  await assert.rejects(handleTool(context(conn), "ibmi.compare.text", {
    left: { type: "ifs", path: "/home/dev/a.txt" },
    right: { type: "ifs", path: "/home/dev/b.txt" },
    maxBytes: 4
  }), /more than maxBytes/);

  const policy = { profile: "power-user", denyLibraries: ["SECRET"] };
  await assert.rejects(handleTool(context(conn, policy), "ibmi.compare.text", {
    left: { type: "member", library: "SECRET", sourceFile: "QRPGLESRC", member: "A" },
    right: { type: "ifs", path: "/home/dev/b.txt" }
  }), /Blocked by policy/);
});

test("compare.text refuses local files outside the allowed roots and bad names", async () => {
  const { conn } = fakeConn();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-compare-"));
  const previous = process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
  process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = dir;
  try {
    await assert.rejects(handleTool(context(conn), "ibmi.compare.text", {
      left: { type: "local", path: path.join(os.tmpdir(), "elsewhere.txt") },
      right: { type: "local", path: path.join(dir, "x.txt") }
    }), /outside the allowed local roots/);
    await assert.rejects(handleTool(context(conn), "ibmi.compare.text", {
      left: { type: "member", library: "BAD'LIB", sourceFile: "QRPGLESRC", member: "A" },
      right: { type: "local", path: path.join(dir, "x.txt") }
    }), /Invalid left.library/);
  } finally {
    if (previous === undefined) delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    else process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- ibmi.objects.describe ----

test("objects.describe queries OBJECT_STATISTICS and shapes the row", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [{
      OBJNAME: "ORDPGM", OBJTYPE: "*PGM", OBJOWNER: "QPGMR ", OBJSIZE: "65536", OBJTEXT: "Orders", OBJATTRIBUTE: "RPGLE",
      OBJCREATED: "2024-01-01-10.00.00.000000", CHANGE_TIMESTAMP: "2024-02-01-10.00.00.000000", LAST_USED_TIMESTAMP: null,
      SOURCE_LIBRARY: "MYLIB", SOURCE_FILE: "QRPGLESRC", SOURCE_MEMBER: "ORDPGM", DAYS_USED_COUNT: "3"
    }]
  });
  const out = data(await handleTool(context(conn), "ibmi.objects.describe", { library: "mylib", object: "ordpgm", objectType: "*pgm" }));
  assert.equal(calls.sql.length, 1);
  assert.match(calls.sql[0], /table\(QSYS2\.OBJECT_STATISTICS\('MYLIB', '\*PGM', 'ORDPGM'\)\) X fetch first 50 rows only/);
  const obj = out.objects[0];
  assert.equal(obj.owner, "QPGMR");
  assert.equal(obj.size, 65536);
  assert.equal(obj.daysUsed, 3);
  assert.deepEqual(obj.source, { library: "MYLIB", file: "QRPGLESRC", member: "ORDPGM" });
  assert.equal("lastUsed" in obj, false);
});

test("objects.describe falls back to filtering by OBJNAME and reports not found", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (/'ORDPGM'\)\)/.test(sql)) throw new Error("SQL0440 routine not found");
      return [];
    }
  });
  const res = await handleTool(context(conn), "ibmi.objects.describe", { library: "MYLIB", object: "ORDPGM" });
  assert.match(calls.sql[1], /OBJECT_STATISTICS\('MYLIB', '\*ALL'\)\) X where X\.OBJNAME = 'ORDPGM'/);
  assert.equal(res.isError, true);
  await assert.rejects(handleTool(context(conn), "ibmi.objects.describe", { library: "MY LIB", object: "X" }), /Invalid library/);
});

// ---- ibmi.members.describe ----

test("members.describe reads SYSPARTITIONSTAT with the source CCSID", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [{
      SYSTEM_TABLE_MEMBER: "ORDER", SOURCE_TYPE: "RPGLE", PARTITION_TEXT: "Order entry", NUMBER_ROWS: "120",
      LAST_SOURCE_UPDATE_TIMESTAMP: "2024-03-01-09.00.00.000000", FILE_RECORD_LENGTH: "112", SOURCE_CCSID: "37"
    }]
  });
  const out = data(await handleTool(context(conn), "ibmi.members.describe", { library: "mylib", sourceFile: "qrpglesrc", member: "order" }));
  assert.match(calls.sql[0], /from QSYS2\.SYSPARTITIONSTAT P/);
  assert.match(calls.sql[0], /SYSTEM_COLUMN_NAME = 'SRCDTA'/);
  assert.match(calls.sql[0], /P\.SYSTEM_TABLE_MEMBER = 'ORDER' fetch first 1 row only/);
  assert.deepEqual(
    { type: out.type, records: out.records, ccsid: out.ccsid, recordLength: out.recordLength },
    { type: "RPGLE", records: 120, ccsid: 37, recordLength: 112 }
  );
});

// ---- ibmi.ifs.stat ----

test("ifs.stat uses IFS_OBJECT_STATISTICS and falls back to ls", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [{ PATH_NAME: "/home/dev/a.txt", OBJECT_TYPE: "*STMF", CCSID: "1208", DATA_SIZE: "42", OBJECT_OWNER: "DEV" }]
  });
  const out = data(await handleTool(context(conn), "ibmi.ifs.stat", { path: "/home/dev/a.txt" }));
  assert.match(calls.sql[0], /IFS_OBJECT_STATISTICS\(START_PATH_NAME => '\/home\/dev\/a\.txt', SUBTREE_DIRECTORIES => 'NO'\)\) X where X\.PATH_NAME = '\/home\/dev\/a\.txt'/);
  assert.deepEqual({ ccsid: out.ccsid, size: out.size, owner: out.owner, source: out.source }, { ccsid: 1208, size: 42, owner: "DEV", source: "QSYS2.IFS_OBJECT_STATISTICS" });

  const old = fakeConn({
    runSQL: () => { throw new Error("SQL0204 IFS_OBJECT_STATISTICS not found"); },
    sendCommand: () => ({ code: 0, stdout: "drwxr-xr-x 2 DEV 0 8192 Jan 01 10:00 /home/dev/dir\n", stderr: "" })
  });
  const fallback = data(await handleTool(context(old.conn), "ibmi.ifs.stat", { path: "/home/dev/dir/" }));
  assert.match(old.calls.commands[0], /^ls -ldL '?\/home\/dev\/dir'?$/);
  assert.equal(fallback.objectType, "*DIR");
  assert.equal(fallback.size, 8192);
  assert.match(fallback.warnings[0], /unavailable/);

  const missing = fakeConn({ sendCommand: () => ({ code: 2, stdout: "", stderr: "No such file" }) });
  assert.equal((await handleTool(context(missing.conn), "ibmi.ifs.stat", { path: "/nope" })).isError, true);
  await assert.rejects(handleTool(context(missing.conn), "ibmi.ifs.stat", { path: "relative" }), /absolute/);
});

// ---- ibmi.programs.info ----

test("programs.info combines PROGRAM_INFO, modules, service programs and exports", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("QSYS2.PROGRAM_INFO")) {
        return [{ OBJECT_TYPE: "*SRVPGM", PROGRAM_TYPE: "ILE", ACTIVATION_GROUP: "*CALLER", SOURCE_FILE: "", MODULES: "2" }];
      }
      if (sql.includes("BOUND_MODULE_INFO")) {
        return [{ BOUND_MODULE_LIBRARY: "MYLIB", BOUND_MODULE: "UTILA", MODULE_ATTRIBUTE: "RPGLE", SOURCE_FILE: "QRPGLESRC", SOURCE_FILE_MEMBER: "UTILA" }];
      }
      if (sql.includes("BOUND_SRVPGM_INFO")) throw new Error("SQL0204 BOUND_SRVPGM_INFO not found");
      if (sql.includes("PROGRAM_EXPORT_IMPORT_INFO")) {
        return [
          { SYMBOL_NAME: "getOrder", SYMBOL_USAGE: "*PROCEXP" },
          { SYMBOL_NAME: "putOrder", SYMBOL_USAGE: "*PROCEXP" },
          { SYMBOL_NAME: "QleBndDummy", SYMBOL_USAGE: "*PROCIMP" }
        ];
      }
      return [];
    }
  });
  const out = data(await handleTool(context(conn), "ibmi.programs.info", { library: "mylib", program: "utils" }));
  assert.match(calls.sql[0], /from QSYS2\.PROGRAM_INFO where PROGRAM_LIBRARY = 'MYLIB' and PROGRAM_NAME = 'UTILS' fetch first 2 rows only/);
  assert.match(calls.sql[1], /BOUND_MODULE_INFO where .* and OBJECT_TYPE = '\*SRVPGM' fetch first 500 rows only/);
  assert.equal(out.objectType, "*SRVPGM");
  assert.equal(out.activationGroup, "*CALLER");
  assert.equal(out.modules[0].name, "UTILA");
  assert.equal(out.servicePrograms, undefined);
  assert.match(out.warnings[0], /BOUND_SRVPGM_INFO unavailable/);
  assert.deepEqual(out.exports.map(e => e.symbol), ["getOrder", "putOrder"]);
  assert.deepEqual(out.imports.map(e => e.symbol), ["QleBndDummy"]);
  assert.match(out.binderSource.text, /STRPGMEXP PGMLVL\(\*CURRENT\) SIGNATURE\(\*GEN\)\n  EXPORT SYMBOL\("getOrder"\)\n  EXPORT SYMBOL\("putOrder"\)\nENDPGMEXP$/);
});

test("programs.info asks for objectType when names collide and reports missing programs", async () => {
  const both = fakeConn({ runSQL: () => [{ OBJECT_TYPE: "*PGM" }, { OBJECT_TYPE: "*SRVPGM" }] });
  await assert.rejects(handleTool(context(both.conn), "ibmi.programs.info", { library: "A", program: "B" }), /pass objectType/);
  const none = fakeConn();
  assert.equal((await handleTool(context(none.conn), "ibmi.programs.info", { library: "A", program: "B", objectType: "*PGM" })).isError, true);
  assert.match(none.calls.sql[0], /and OBJECT_TYPE = '\*PGM'/);
});

test("buildBinderSource skips unsafe symbols", () => {
  const res = buildBinderSource("L", "P", [{ symbol: "ok" }, { symbol: 'bad"x' }]);
  assert.equal(res.exportCount, 1);
  assert.deepEqual(res.skipped, ['bad"x']);
});

// ---- ibmi.objects.whereUsed ----

test("whereUsed uses runs DSPPGMREF and SELECT in one SQL call", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [
      { WHLIB: "MYLIB", WHPNAM: "ORDPGM", WHSPKG: "P", WHLNAM: "*LIBL", WHFNAM: "ORDERS", WHOTYP: "*FILE", WHFUSG: "3", WHRFNM: "ORDREC" },
      { WHLIB: "MYLIB", WHPNAM: "ORDPGM", WHSPKG: "P", WHLNAM: "QSYS", WHFNAM: "QCMDEXC", WHOTYP: "*PGM", WHFUSG: "0" }
    ]
  });
  const out = data(await handleTool(context(conn), "ibmi.objects.whereUsed", { direction: "uses", library: "mylib", program: "ordpgm" }));
  assert.equal(calls.sql.length, 1);
  const sql = calls.sql[0];
  const outfile = sql.match(/QTEMP\/(MCPR[A-Z0-9]{6})/)[1];
  assert.match(sql, new RegExp(`^call QSYS2\\.QCMDEXC\\('DSPPGMREF PGM\\(MYLIB/ORDPGM\\) OUTPUT\\(\\*OUTFILE\\) OBJTYPE\\(\\*ALL\\) OUTFILE\\(QTEMP/${outfile}\\)'\\);\\nselect \\* from QTEMP\\.${outfile} order by`));
  assert.match(sql, /fetch first 1001 rows only$/);
  assert.equal(out.references.length, 2);
  assert.deepEqual(out.references[0].fileUsage, ["input", "output"]);
  assert.equal(out.references[0].programType, "*PGM");
  assert.equal(out.references[1].fileUsage, undefined);
  assert.equal(out.hasMore, false);
});

test("whereUsed usedBy scans a library and filters on the referenced object", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [
      { WHLIB: "MYLIB", WHPNAM: "A", WHSPKG: "P", WHLNAM: "MYLIB", WHFNAM: "ORDERS", WHOTYP: "*FILE", WHRFNM: "R1" },
      { WHLIB: "MYLIB", WHPNAM: "A", WHSPKG: "P", WHLNAM: "MYLIB", WHFNAM: "ORDERS", WHOTYP: "*FILE", WHRFNM: "R2" },
      { WHLIB: "MYLIB", WHPNAM: "B", WHSPKG: "V", WHLNAM: "*LIBL", WHFNAM: "ORDERS", WHOTYP: "*FILE" }
    ]
  });
  const out = data(await handleTool(context(conn), "ibmi.objects.whereUsed", {
    direction: "usedBy", library: "MYLIB", object: "orders", objectLibrary: "mylib", objectType: "*file", limit: 10
  }));
  const sql = calls.sql[0];
  assert.match(sql, /DSPPGMREF PGM\(MYLIB\/\*ALL\) OUTPUT\(\*OUTFILE\) OBJTYPE\(\*ALL\)/);
  assert.match(sql, /where WHFNAM = 'ORDERS' and WHLNAM in \('MYLIB', '\*LIBL'\) and WHOTYP = '\*FILE'/);
  assert.match(sql, /fetch first 11 rows only$/);
  assert.deepEqual(out.programs, [
    { library: "MYLIB", program: "A", programType: "*PGM" },
    { library: "MYLIB", program: "B", programType: "*SRVPGM" }
  ]);
  await assert.rejects(handleTool(context(conn), "ibmi.objects.whereUsed", { direction: "usedBy", library: "MYLIB", object: "A')" }), /Invalid object/);
  await assert.rejects(handleTool(context(conn), "ibmi.objects.whereUsed", { direction: "sideways", library: "MYLIB" }), /direction/);
});

test("whereUsed reports hasMore when the limit is exceeded", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ WHLIB: "L", WHPNAM: `P${i}`, WHFNAM: "X" }));
  const { conn } = fakeConn({ runSQL: () => rows });
  const out = data(await handleTool(context(conn), "ibmi.objects.whereUsed", { direction: "uses", library: "L", program: "P", limit: 2 }));
  assert.equal(out.returned, 2);
  assert.equal(out.hasMore, true);
  assert.equal(shapeProgramReference({ WHLIB: "L", WHPNAM: "P", WHFUSG: "5" }).fileUsage.join("+"), "input+update");
});

// ---- ibmi.tables.describe ----

test("tables.describe resolves the SQL name and returns columns, constraints and indexes", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("QSYS2.SYSTABLES")) {
        return [{ TABLE_SCHEMA: "MYLIB", TABLE_NAME: "CUSTOMER_MASTER", SYSTEM_TABLE_NAME: "CUSTM00001", TABLE_TYPE: "T", COLUMN_COUNT: "2" }];
      }
      if (sql.includes("QSYS2.SYSCOLUMNS")) {
        return [
          { COLUMN_NAME: "ID", ORDINAL_POSITION: "1", DATA_TYPE: "DECIMAL", LENGTH: "9", NUMERIC_SCALE: "0", IS_NULLABLE: "N", IS_IDENTITY: "YES" },
          { COLUMN_NAME: "NAME", ORDINAL_POSITION: "2", DATA_TYPE: "VARCHAR", LENGTH: "50", IS_NULLABLE: "Y", CCSID: "37" }
        ];
      }
      if (sql.includes("QSYS2.SYSCST")) return [{ CONSTRAINT_SCHEMA: "MYLIB", CONSTRAINT_NAME: "PK", CONSTRAINT_TYPE: "PRIMARY KEY", COLUMN_NAME: "ID" }];
      if (sql.includes("QSYS2.SYSINDEXES")) {
        return [
          { INDEX_SCHEMA: "MYLIB", INDEX_NAME: "CUST_NAME_IX", IS_UNIQUE: "D", COLUMN_NAME: "NAME", ORDERING: "A" },
          { INDEX_SCHEMA: "MYLIB", INDEX_NAME: "CUST_NAME_IX", IS_UNIQUE: "D", COLUMN_NAME: "ID", ORDERING: "D" }
        ];
      }
      return [];
    }
  });
  const out = data(await handleTool(context(conn), "ibmi.tables.describe", { library: "mylib", table: "custm00001" }));
  assert.match(calls.sql[0], /\(TABLE_SCHEMA = 'MYLIB' or SYSTEM_TABLE_SCHEMA = 'MYLIB'\) and \(TABLE_NAME = 'CUSTM00001' or SYSTEM_TABLE_NAME = 'CUSTM00001'\)/);
  assert.match(calls.sql[1], /SYSCOLUMNS where TABLE_SCHEMA = 'MYLIB' and TABLE_NAME = 'CUSTOMER_MASTER' order by ORDINAL_POSITION fetch first 1000 rows only/);
  assert.match(calls.sql[2], /where C\.TABLE_SCHEMA = 'MYLIB' and C\.TABLE_NAME = 'CUSTOMER_MASTER'/);
  assert.match(calls.sql[3], /where I\.TABLE_SCHEMA = 'MYLIB' and I\.TABLE_NAME = 'CUSTOMER_MASTER'/);
  assert.equal(out.name, "CUSTOMER_MASTER");
  assert.equal(out.columns[0].type, "DECIMAL(9, 0)");
  assert.equal(out.columns[0].nullable, false);
  assert.equal(out.columns[0].identity, true);
  assert.equal(out.columns[1].type, "VARCHAR(50)");
  assert.deepEqual(out.constraints, [{ schema: "MYLIB", name: "PK", type: "PRIMARY KEY", columns: ["ID"] }]);
  assert.deepEqual(out.indexes[0].keys, [{ column: "NAME", ordering: "A" }, { column: "ID", ordering: "D" }]);
});

test("tables.describe reports missing tables and rejects quotes in names", async () => {
  const { conn } = fakeConn();
  assert.equal((await handleTool(context(conn), "ibmi.tables.describe", { library: "MYLIB", table: "NOPE" })).isError, true);
  await assert.rejects(handleTool(context(conn), "ibmi.tables.describe", { library: "MYLIB", table: "X' or '1'='1" }), /Invalid table/);
});

// ---- ibmi.routines.describe ----

test("routines.describe builds signatures for procedures and functions", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("SYSROUTINES")) {
        return [
          { ROUTINE_SCHEMA: "MYLIB", ROUTINE_NAME: "GET_ORDER", SPECIFIC_SCHEMA: "MYLIB", SPECIFIC_NAME: "GET_ORDER", ROUTINE_TYPE: "PROCEDURE", RESULT_SETS: "1", ROUTINE_DEFINITION: "BEGIN END" },
          { ROUTINE_SCHEMA: "MYLIB", ROUTINE_NAME: "GET_ORDER", SPECIFIC_SCHEMA: "MYLIB", SPECIFIC_NAME: "GET_ORDER_F", ROUTINE_TYPE: "FUNCTION", FUNCTION_TYPE: "S" }
        ];
      }
      return [
        { SPECIFIC_NAME: "GET_ORDER", ORDINAL_POSITION: "1", PARAMETER_MODE: "IN", PARAMETER_NAME: "ID", DATA_TYPE: "INTEGER", ROW_TYPE: "P" },
        { SPECIFIC_NAME: "GET_ORDER", ORDINAL_POSITION: "2", PARAMETER_MODE: "OUT", PARAMETER_NAME: "STATUS", DATA_TYPE: "CHARACTER", CHARACTER_MAXIMUM_LENGTH: "10", ROW_TYPE: "P" },
        { SPECIFIC_NAME: "GET_ORDER_F", ORDINAL_POSITION: "1", PARAMETER_MODE: "IN", PARAMETER_NAME: "ID", DATA_TYPE: "INTEGER", ROW_TYPE: "P" },
        { SPECIFIC_NAME: "GET_ORDER_F", ORDINAL_POSITION: "2", DATA_TYPE: "DECIMAL", NUMERIC_PRECISION: "11", NUMERIC_SCALE: "2", ROW_TYPE: "R" }
      ];
    }
  });
  const out = data(await handleTool(context(conn), "ibmi.routines.describe", { library: "mylib", routine: "get_order" }));
  assert.match(calls.sql[0], /from QSYS2\.SYSROUTINES where ROUTINE_SCHEMA = 'MYLIB' and \(ROUTINE_NAME = 'GET_ORDER' or SPECIFIC_NAME = 'GET_ORDER'\) order by SPECIFIC_NAME fetch first 50 rows only/);
  assert.match(calls.sql[1], /SYSPARMS where SPECIFIC_SCHEMA = 'MYLIB' and SPECIFIC_NAME in \('GET_ORDER', 'GET_ORDER_F'\)/);
  assert.equal(out.routines[0].signature, "MYLIB.GET_ORDER(IN ID INTEGER, OUT STATUS CHARACTER(10))");
  assert.equal(out.routines[0].definition, undefined);
  assert.equal(out.routines[1].signature, "MYLIB.GET_ORDER(ID INTEGER) RETURNS DECIMAL(11, 2)");
  assert.equal(formatSqlType("TIMESTAMP", 26), "TIMESTAMP");
});
