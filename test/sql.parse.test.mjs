import test from "node:test";
import assert from "node:assert/strict";
import { Tools } from "../dist/ibmi/Tools.js";

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
