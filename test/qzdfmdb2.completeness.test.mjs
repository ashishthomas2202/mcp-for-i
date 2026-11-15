import test from "node:test";
import assert from "node:assert/strict";
import { parseQzdfmdb2Result, boundQzdfmdb2Sql, boundedQzdfmdb2Result } from "../dist/ibmi/qzdfmdb2.js";
import { IBMiClient } from "../dist/ibmi/client.js";
import { McpContext } from "../dist/mcp/context.js";
import { handleTool } from "../dist/mcp/tools.js";

const table = (count) => `DB2>\nDB20000I THE SQL COMMAND COMPLETED SUCCESSFULLY.\nDB2>\n  ?>\n\nN   \n----\n${Array.from({ length: count }, (_, i) => String(i).padStart(4)).join("\n")}\n\n  ${count} RECORD(S) SELECTED.`;
const output = (count, changes = {}) => ({ code: 0, signal: null, stdout: table(count), stderr: "", ...changes });

test("footer proves matching rows and exact live zero shape without final newline", () => {
  assert.equal(parseQzdfmdb2Result(output(3), true).proof.reportedRowCount, 3);
  const zero = "DB2>\nDB20000I THE SQL COMMAND COMPLETED SUCCESSFULLY.\nDB2>\n  ?>\n\nWC_SQL_COMPLETENESS_ZERO \n-------------------------\n\n  0 RECORD(S) SELECTED.";
  assert.equal(parseQzdfmdb2Result(output(0, { stdout: zero, stderr: "CPC2198 Current library changed." }), true).rows.length, 0);
});

for (const [label, changes] of [
  ["missing footer", { stdout: "N\n----\n   1\n" }],
  ["count mismatch", { stdout: table(2).replace("2 RECORD", "3 RECORD") }],
  ["SQL error stderr", { stderr: "SQL0204 failed" }],
  ["SQL warning stdout", { stdout: table(2) + "\n**** CLI ERROR *****\nSQLSTATE: 01004" }],
  ["nonzero exit", { code: 1 }],
  ["unknown exit", { code: null }],
  ["missing signal", { signal: undefined }],
  ["signal", { signal: "SIGTERM" }],
  ["ambiguous footer", { stdout: table(2) + "\n\n  2 RECORD(S) SELECTED." }],
  ["trailing row", { stdout: table(2) + "\n   3" }],
  ["data shaped as footer", { stdout: "N\n-------------------------\n1 RECORD(S) SELECTED." }],
]) test("rejects " + label, () => assert.throws(() => parseQzdfmdb2Result(output(2, changes), true)));

test("row sentinel stays visible; rows past the limit are dropped and reported as remaining", () => {
  const exact = boundedQzdfmdb2Result(output(3), 3);
  assert.equal(exact.rows.length, 3);
  assert.equal(exact.exhausted, true);
  assert.equal(exact.knownRemaining, false);
  // A statement that kept its own, larger row limit: the closing count proves the rest exists.
  const over = boundedQzdfmdb2Result(output(4), 3);
  assert.equal(over.rows.length, 3);
  assert.equal(over.exhausted, false);
  assert.equal(over.knownRemaining, true);
  assert.equal(over.completenessProof.reportedRowCount, 4);
});

test("the row limit is added at the end of the statement, never as a wrapper", () => {
  const bound = (sql) => boundQzdfmdb2Sql(sql, 3);
  const LIMIT = "FETCH FIRST 3 ROWS ONLY";
  // Db2 for i rejects WITH, WITH NC and FOR READ ONLY inside a derived table, so nothing is wrapped.
  for (const sql of [
    "select N from T", "values 1, 2", "with X(N) as (values 1, 2, 3) select N from X order by N desc",
    "select N from T order by N offset 5 rows", "select A from T union select B from U",
  ]) {
    const out = bound(sql);
    assert.equal(out, sql + "\n" + LIMIT);
    assert.doesNotMatch(out, /MCP_BOUNDED_RESULT|^SELECT \* FROM \(/);
  }
  // Before a trailing isolation or read-only clause, in any order.
  assert.equal(bound("select N from T with ur"), "select N from T\n" + LIMIT + " with ur");
  assert.equal(bound("select N from T with NC"), "select N from T\n" + LIMIT + " with NC");
  assert.equal(bound("select N from T for read only"), "select N from T\n" + LIMIT + " for read only");
  assert.equal(bound("select N from T for fetch only with cs"), "select N from T\n" + LIMIT + " for fetch only with cs");
  assert.equal(bound("with X as (select 1 N from T) select N from X with rr for read only"),
    "with X as (select 1 N from T) select N from X\n" + LIMIT + " with rr for read only");
  // A statement with its own row limit, or a clause the limit cannot follow, is left as it is.
  for (const sql of [
    "select N from T fetch first 999 rows only", "select N from T fetch first 999 rows only with ur",
    "select N from T fetch first row only", "select N from T limit 10", "select N from T limit 10 offset 5",
    "select N from T limit 5, 10", "select N from T optimize for 10 rows",
    "select N from T with rs keep update locks", "select N from T skip locked data",
    "select N from T use currently committed", "select N from T wait for outcome",
  ]) assert.equal(bound(sql), sql);
  // Comments and the terminator: a commented-out clause is not a clause, and nothing follows the statement.
  assert.equal(bound("select N from T -- WITH UR"), "select N from T\n" + LIMIT);
  assert.equal(bound("select N from T -- note\nwith ur"), "select N from T\n" + LIMIT + " -- note\nwith ur");
  assert.doesNotMatch(bound("select N from T; -- okay"), /;/);
  assert.match(bound("select N from T; -- okay"), /^select N from T\nFETCH FIRST 3 ROWS ONLY/);
  assert.throws(() => bound("delete from T"), /safe QZDFMDB2 result bound/);
});

test("a statement the database rejects comes back in its own words, with its SQLSTATE", () => {
  // The shape PRISMPCR printed for an unknown column on 2026-11-15.
  const stdout = "DB2>\nDB20000I  THE SQL COMMAND COMPLETED SUCCESSFULLY.\nDB2>\n  ?>\n  ?>\n\n" +
    " **** CLI ERROR *****\n         SQLSTATE: 42703\nNATIVE ERROR CODE: -206\n" +
    "Column or global variable NOPE_COLUMN not found. \n";
  const stderr = "CPC2198:  Current library changed to DEVLIB.\nSQL0206:  Column or global variable NOPE_COLUMN not found.\n";
  for (const requireResult of [true, false]) {
    assert.throws(() => parseQzdfmdb2Result(output(0, { stdout, stderr }), requireResult), (error) => {
      assert.equal(error.constructor.name, "SqlError");
      assert.equal(error.sqlstate, "42703");
      assert.equal(error.message, "Column or global variable NOPE_COLUMN not found. (42703)");
      return true;
    });
  }
  // A following prompt is not part of the message.
  const prompted = "DB2>\n\n **** CLI ERROR *****\n         SQLSTATE: 38501\nNATIVE ERROR CODE: -443\nNot authorized to library X.\nDB2>\n";
  assert.throws(() => parseQzdfmdb2Result(output(0, { stdout: prompted }), false),
    (error) => error.message === "Not authorized to library X. (38501)" && error.sqlstate === "38501");
});

test("a diagnostic with rows still printed fails, and says what the job said", () => {
  // A data mapping error prints a row with a wrong value in it and a clean closing count.
  const stderr = "CPF5029:  Data mapping error on member SYSDUMMY1.\nSQL0420:  Character in CAST argument not valid.\n";
  assert.throws(() => parseQzdfmdb2Result(output(1, { stderr }), true), (error) => {
    assert.equal(error.constructor.name, "SqlError");
    assert.equal(error.message, "SQL0420: Character in CAST argument not valid. The result may be wrong, so no rows are returned.");
    return true;
  });
  // A warning block is not an SQL error, but the result is still not proven: it says which warning.
  const warning = table(2) + "\n\n **** CLI ERROR *****\n         SQLSTATE: 01004\nNATIVE ERROR CODE: 0\nString truncated.\n";
  assert.throws(() => parseQzdfmdb2Result(output(2, { stdout: warning }), true), /completeness failed: SQL warning 01004: String truncated\./);
});

test("a count that does not match says a line break in a value is the likely cause", () => {
  const broken = "DB2>\n\nT    N   \n---- ----\nL1  \nL2      7\n\n  1 RECORD(S) SELECTED.";
  assert.throws(() => parseQzdfmdb2Result(output(1, { stdout: broken }), true),
    /selected-row count does not match parsed rows \(1 reported, 2 read\)\. A value may contain a line break/);
});

test("SQL-looking headers and data are ordinary result content", () => {
  for (const stdout of ["SQLSTATE\n--------\n00000\n\n  1 RECORD(S) SELECTED.", "C\n--------\nSQL0123\n\n  1 RECORD(S) SELECTED."]) {
    assert.equal(parseQzdfmdb2Result(output(1, { stdout }), true).rows.length, 1);
  }
});

test("live padded CHAR rows are distinct from the physical closing footer", () => {
  const body = "WC_SQL_COMPLETENESS_ZERO\n-------------------------\n" +
    "                         \n  0 RECORD(S) SELECTED.  ";
  const complete = body + "\n\n  2 RECORD(S) SELECTED.";
  const result = parseQzdfmdb2Result(output(2, { stdout: complete }), true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.proof.reportedRowCount, 2);
  assert.throws(() => parseQzdfmdb2Result(output(2, { stdout: body }), true), /missing/);
});

for (const [label, code, signal] of [
  ["unknown", null, null], ["missing", undefined, null], ["nonzero", 1, null],
  ["signalled", 0, "SIGTERM"], ["missing signal", 0, undefined],
]) test("raw SSH " + label + " exit cannot be normalized into proof", async () => {
  const client = new IBMiClient({});
  client.client = { execCommand: async () => ({ ...output(0), code, signal }) };
  await assert.rejects(client.sendCommand({ command: "test", requireCleanExit: true }), /exit was not clean/);
});

test("no-row DDL does not require SELECT footer", () => {
  assert.deepEqual(parseQzdfmdb2Result(output(0, { stdout: "DB20000I THE SQL COMMAND COMPLETED SUCCESSFULLY." }), false).rows, []);
});

test("SSH abort closes only its channel and rejects late success", async () => {
  const client = new IBMiClient({});
  const controller = new AbortController();
  let closed = 0;
  let finish;
  client.client = { execCommand: async (_command, options) => {
    options.onChannel({ close() { closed++; }, destroy() { closed++; } });
    return await new Promise((resolve) => { finish = resolve; });
  } };
  const pending = client.sendCommand({ command: "test", signal: controller.signal, requireCleanExit: true });
  controller.abort();
  finish(output(0));
  await assert.rejects(pending, /cancelled/);
  assert.equal(closed, 2);
});

test("MCP QZ fallback preserves sentinel truncation and proof across cursors", async () => {
  const client = new IBMiClient({ sqlTransport: "qzdfmdb2" });
  client.resolveFallbackLibraryList = async () => undefined;
  client.sendCommand = async (options) => {
    assert.doesNotMatch(options.stdin, /;/);
    // The statement itself, limited at its end: no wrapper, no terminator.
    assert.equal(options.stdin, "select N from T\nfetch first 3 rows only\n");
    return output(3);
  };
  const context = Object.create(McpContext.prototype);
  context.cursors = new Map();
  context.cursorTtlMs = 60000;
  context.ensureActive = async () => client;
  const parse = (r) => JSON.parse(r.content[0].text);
  const first = parse(await handleTool(context, "ibmi.sql.query", {
    sql: "select N from T; -- okay", maxRows: 2, pageSize: 1, includeMetadata: true,
  }));
  assert.equal(first.truncated, true);
  assert.equal(first.totalRows, 2);
  assert.equal(first.metadata.completenessProof.reportedRowCount, 3);
  const next = parse(await handleTool(context, "ibmi.sql.query", { cursor: first.cursor, pageSize: 1, includeMetadata: true }));
  assert.equal(next.truncated, true);
  assert.deepEqual(next.metadata.completenessProof, first.metadata.completenessProof);
});

test("MCP timeout closes the QZ SSH channel once and rejects late success", async () => {
  const client = new IBMiClient({ sqlTransport: "qzdfmdb2" });
  client.resolveFallbackLibraryList = async () => undefined;
  let closed = 0;
  let destroyed = 0;
  let finish;
  client.client = { execCommand: async (_command, options) => {
    assert.equal(options.noTrim, true);
    options.onChannel({ close() { closed++; }, destroy() { destroyed++; } });
    return await new Promise((resolve) => { finish = resolve; });
  } };
  const query = client.querySQL.bind(client);
  let actualQuery;
  client.querySQL = (...args) => {
    actualQuery = query(...args);
    return actualQuery;
  };
  const context = Object.create(McpContext.prototype);
  context.ensureActive = async () => client;
  await assert.rejects(handleTool(context, "ibmi.sql.query", {
    sql: "select N from T", timeoutMs: 1000,
  }), /timed out/);
  assert.equal(closed, 1);
  assert.equal(destroyed, 1);
  finish(output(1));
  await assert.rejects(actualQuery, /cancelled/);
  assert.equal(closed, 1);
  assert.equal(destroyed, 1);
});

test("a WITH query reaches QZDFMDB2 as written, limited at its end", async () => {
  const client = new IBMiClient({ sqlTransport: "qzdfmdb2" });
  client.resolveFallbackLibraryList = async () => undefined;
  let sent;
  client.sendCommand = async (options) => { sent = options.stdin; return output(3); };
  const context = Object.create(McpContext.prototype);
  context.cursors = new Map();
  context.cursorTtlMs = 60000;
  context.ensureActive = async () => client;
  const result = JSON.parse((await handleTool(context, "ibmi.sql.query", {
    sql: "with X(N) as (values 1, 2, 3) select N from X order by N desc", maxRows: 5, includeMetadata: true,
  })).content[0].text);
  assert.equal(sent, "with X(N) as (values 1, 2, 3) select N from X order by N desc\nfetch first 6 rows only\n");
  assert.equal(result.truncated, false);
  assert.equal(result.metadata.transport, "qzdfmdb2");
});

test("a statement with its own larger row limit is cut at maxRows and reported truncated", async () => {
  const client = new IBMiClient({ sqlTransport: "qzdfmdb2" });
  client.resolveFallbackLibraryList = async () => undefined;
  let sent;
  client.sendCommand = async (options) => { sent = options.stdin; return output(9); };
  const context = Object.create(McpContext.prototype);
  context.cursors = new Map();
  context.cursorTtlMs = 60000;
  context.ensureActive = async () => client;
  const result = JSON.parse((await handleTool(context, "ibmi.sql.query", {
    sql: "select N from T fetch first 9 rows only", maxRows: 5, pageSize: 5, includeMetadata: true,
  })).content[0].text);
  assert.equal(sent, "select N from T fetch first 9 rows only\n");
  assert.equal(result.rows.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.metadata.completenessProof.reportedRowCount, 9);
});

test("an SQL error on QZDFMDB2 reaches the tool caller with the database's text", async () => {
  const client = new IBMiClient({ sqlTransport: "qzdfmdb2" });
  client.resolveFallbackLibraryList = async () => undefined;
  client.sendCommand = async () => output(0, { stdout: "DB2>\n\n **** CLI ERROR *****\n         SQLSTATE: 42703\nNATIVE ERROR CODE: -206\nColumn or global variable NOPE not found. \n" });
  const context = Object.create(McpContext.prototype);
  context.cursors = new Map();
  context.cursorTtlMs = 60000;
  context.ensureActive = async () => client;
  await assert.rejects(handleTool(context, "ibmi.sql.query", { sql: "select NOPE from T" }),
    /Column or global variable NOPE not found\. \(42703\)/);
});
