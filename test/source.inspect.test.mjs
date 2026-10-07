import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSourceLanguage,
  inspectSource,
  parseClParameters,
  sqlTableReferences
} from "../dist/ibmi/sourceInspect.js";

function deps(result, kind) {
  return result.dependencies.filter(dep => !kind || dep.kind === kind).map(dep => dep.name);
}

function symbols(result, kind) {
  return result.symbols.filter(symbol => !kind || symbol.kind === kind).map(symbol => symbol.name);
}

// Builds a fixed-form line: columns 1-5 sequence, column 6 spec, then the rest.
function fixed(spec, rest) {
  return `     ${spec}${rest}`;
}

// D and P specs: name in columns 7-21, definition type in 24-25, keywords from 44.
function named(spec, name, type, keywords = "") {
  return `     ${spec}${name.padEnd(15)}  ${type.padEnd(2)}${" ".repeat(18)}${keywords}`;
}

test("language detection follows the member source type", () => {
  assert.equal(detectSourceLanguage("SQLRPGLE", []), "rpg");
  assert.equal(detectSourceLanguage("clle", []), "cl");
  assert.equal(detectSourceLanguage("CLP", []), "cl");
  assert.equal(detectSourceLanguage("SQL", []), "sql");
  assert.equal(detectSourceLanguage("DSPF", []), "dds");
  assert.equal(detectSourceLanguage("PRTF", []), "dds");
  assert.equal(detectSourceLanguage("TXT", ["**FREE"]), "rpg");
  assert.equal(detectSourceLanguage("TXT", ["hello"]), "unknown");
});

test("CL CALL PGM(X) yields X, never PGM", () => {
  const result = inspectSource([
    "             PGM        PARM(&A)",
    "             DCL        VAR(&A) TYPE(*CHAR) LEN(10)",
    "             DCLF       FILE(MYLIB/CUSTDSP)",
    "             CALL       PGM(MYLIB/ORDPGM) PARM(&A)",
    "             CALL       INVPGM",
    "             CALL       PGM(&DYN)",
    "/* CALL PGM(COMMENTED) */",
    "             CALLPRC    PRC('Helper') PARM(&A)",
    "             SBMJOB     CMD(CALL PGM(BATCHPGM)) JOB(NIGHTLY)",
    "             OVRDBF     FILE(CUST) TOFILE(PRODLIB/CUSTMAST)",
    "             RUNSQL     SQL('DELETE FROM MYLIB.WORKF') COMMIT(*NONE)",
    "LOOP:        CHGVAR     VAR(&A) +",
    "                          VALUE('X')",
    "             SUBR       SUBR(CLEANUP)",
    "             ENDSUBR",
    "             ENDPGM"
  ], "CLLE");
  assert.equal(result.language, "cl");
  const programs = deps(result, "program");
  assert.deepEqual(programs, ["MYLIB/ORDPGM", "INVPGM", "&DYN", "BATCHPGM"]);
  assert.ok(!programs.includes("PGM"));
  assert.ok(!programs.includes("COMMENTED"));
  assert.equal(result.dependencies.find(dep => dep.name === "&DYN").dynamic, true);
  assert.deepEqual(deps(result, "procedure"), ["Helper"]);
  assert.deepEqual(deps(result, "file"), ["MYLIB/CUSTDSP", "PRODLIB/CUSTMAST"]);
  assert.deepEqual(deps(result, "sql-table"), ["MYLIB.WORKF"]);
  assert.deepEqual(symbols(result, "label"), ["LOOP"]);
  assert.deepEqual(symbols(result, "subroutine"), ["CLEANUP"]);
});

test("CL parameter parser keeps nested parentheses and quotes together", () => {
  assert.deepEqual(parseClParameters("PGM(A/B) PARM('x y' (1 2)) POS"), [
    { keyword: "PGM", value: "A/B" },
    { keyword: "PARM", value: "'x y' (1 2)" },
    { value: "POS" }
  ]);
});

test("fully free RPG: outline, dcl-f, prototypes, callp and copy reported once", () => {
  const result = inspectSource([
    "**free",
    "ctl-opt dftactgrp(*no);",
    "/copy QRPGLESRC,COMMON",
    "/include 'common/protos.rpgleinc'",
    "dcl-f CUSTMAST usage(*input) keyed;",
    "dcl-f ORDERS extdesc('PRODLIB/ORDHDR') extfile(*extdesc);",
    "dcl-pr QCMDEXC extpgm('QCMDEXC');",
    "  cmd char(3000) const;",
    "end-pr;",
    "dcl-pr getRate extproc(*cwiden : 'get_rate');",
    "end-pr;",
    "dcl-pr ORDPGM extpgm;",
    "end-pr;",
    "dcl-ds Totals qualified;",
    "end-ds;",
    "for i = 1 to 10; // for loops are not F-specs",
    "  callp(e) QCMDEXC('DSPLIB');",
    "endfor;",
    "exec sql select count(*) into :n from MYLIB.ORDERS o",
    "  join CUSTMAST c on c.id = o.cust;",
    "exec sql insert into AUDITLOG values(:a);",
    "exec sql update PRICES set p = 1 where extract(year from d) = 2026;",
    "exec sql delete from TEMPWORK;",
    "exec sql fetch next from C1 into :row;",
    "dcl-proc CalculateTotal;",
    "  begsr Reset;",
    "  endsr;",
    "end-proc;",
    "/copy QRPGLESRC,COMMON"
  ], "SQLRPGLE");
  assert.equal(result.language, "rpg");
  assert.equal(result.format, "free");
  assert.deepEqual(deps(result, "copy"), ["QRPGLESRC,COMMON", "common/protos.rpgleinc"]);
  assert.deepEqual(deps(result, "file"), ["CUSTMAST", "PRODLIB/ORDHDR"]);
  assert.deepEqual(deps(result, "program"), ["QCMDEXC", "ORDPGM"]);
  assert.deepEqual(deps(result, "procedure"), ["get_rate"]);
  assert.deepEqual(deps(result, "call"), ["QCMDEXC"]);
  assert.deepEqual(deps(result, "sql-table"), ["MYLIB.ORDERS", "CUSTMAST", "AUDITLOG", "PRICES", "TEMPWORK"]);
  assert.ok(!deps(result).includes("I"));
  assert.ok(!deps(result).includes("C1"));
  assert.deepEqual(symbols(result, "procedure"), ["CalculateTotal"]);
  assert.deepEqual(symbols(result, "subroutine"), ["Reset"]);
  assert.deepEqual(symbols(result, "prototype"), ["QCMDEXC", "getRate", "ORDPGM"]);
  assert.deepEqual(symbols(result, "data-structure"), ["Totals"]);
});

test("fixed-form RPG: F, D, P and C specs plus embedded SQL and mixed free-form", () => {
  const result = inspectSource([
    fixed("H", " DFTACTGRP(*NO)"),
    fixed("F", "CUSTMAST  IF   E           K DISK"),
    fixed("F", "*COMMENTED IF   E           K DISK"),
    named("D", "QCMDEXC", "PR", "EXTPGM('QCMDEXC')"),
    named("D", " Cmd", "", "CONST"),
    named("D", "LongProc...", ""),
    named("D", "Name", "PR", "EXTPROC('longProc')"),
    named("D", "Totals", "DS"),
    fixed("C", "     *ENTRY        PLIST"),
    fixed("C", "                   CALL      'ORDPGM'"),
    fixed("C", "                   CALLB     'helper'"),
    fixed("C", "                   CALLP     QCMDEXC(cmd)"),
    fixed("C", "     INIT          BEGSR"),
    fixed("C", "                   ENDSR"),
    fixed("C", "/EXEC SQL"),
    fixed("C", "+ SELECT NAME INTO :NAME FROM CUSTMAST"),
    fixed("C", "+   JOIN ADDRESSES A ON A.ID = 1"),
    fixed("C", "/END-EXEC"),
    "      /free",
    "        for idx = 1 to 10;",
    "        endfor;",
    "      /end-free",
    "      /COPY QRPGLESRC,PROTOS",
    named("P", "Calc", "B", "EXPORT"),
    named("P", "Calc", "E"),
    "**CTDATA ARR",
    "     F CALL PGM(NOTCODE)"
  ], "RPGLE");
  assert.equal(result.format, "fixed");
  assert.deepEqual(deps(result, "file"), ["CUSTMAST"]);
  assert.deepEqual(deps(result, "program"), ["QCMDEXC", "ORDPGM"]);
  assert.deepEqual(deps(result, "procedure"), ["longProc", "helper"]);
  assert.deepEqual(deps(result, "call"), ["QCMDEXC"]);
  assert.deepEqual(deps(result, "copy"), ["QRPGLESRC,PROTOS"]);
  assert.deepEqual(deps(result, "sql-table"), ["CUSTMAST", "ADDRESSES"]);
  assert.ok(!deps(result).includes("FOR"));
  assert.deepEqual(symbols(result, "prototype"), ["QCMDEXC", "LongProcName"]);
  assert.deepEqual(symbols(result, "subroutine"), ["INIT"]);
  assert.deepEqual(symbols(result, "procedure"), ["Calc"]);
  assert.deepEqual(symbols(result, "file"), ["CUSTMAST"]);
});

test("SQL source: created objects in the outline and referenced tables as dependencies", () => {
  const result = inspectSource([
    "-- order views",
    "CREATE OR REPLACE VIEW MYLIB.OPENORD AS",
    "  WITH recent AS (SELECT * FROM MYLIB.ORDHDR)",
    "  SELECT r.*, c.name FROM recent r, MYLIB.CUSTMAST c",
    "  WHERE trim(leading ' ' from c.name) <> '';",
    "CREATE INDEX MYLIB.ORDIDX ON MYLIB.ORDHDR (ID);",
    "CREATE TABLE MYLIB.ORDLINE (ID INT REFERENCES MYLIB.ORDHDR (ID));",
    "/* CREATE TABLE MYLIB.GONE (X INT); */",
    "CREATE PROCEDURE MYLIB.PURGE () BEGIN",
    "  DELETE FROM MYLIB.ORDLINE WHERE 1 = 0;",
    "  CALL MYLIB.LOGIT();",
    "END;"
  ], "SQL");
  assert.equal(result.language, "sql");
  assert.deepEqual(result.symbols.map(symbol => `${symbol.kind}:${symbol.name}`), [
    "view:MYLIB.OPENORD", "index:MYLIB.ORDIDX", "table:MYLIB.ORDLINE", "procedure:MYLIB.PURGE"
  ]);
  assert.deepEqual(deps(result, "sql-table"), ["MYLIB.ORDHDR", "MYLIB.CUSTMAST", "MYLIB.ORDLINE"]);
  assert.ok(!deps(result).includes("RECENT"));
  assert.ok(!deps(result).includes("C.NAME"));
  assert.deepEqual(deps(result, "procedure"), ["MYLIB.LOGIT"]);
});

test("SQL table references skip host variables, cursors and function FROM clauses", () => {
  const names = sqlTableReferences(
    "select substring(a from 2) into :x from T1, LIB.T2 as b where c in (select d from T3) for update of e"
  ).map(ref => ref.name);
  assert.deepEqual(names, ["T1", "LIB.T2", "T3"]);
});

test("DDS: record formats, keys, fields and REF/REFFLD/PFILE/JFILE files", () => {
  const dds = name => name.padEnd(10, " ");
  const line = (nameType, name, keywords = "") =>
    `     A${" ".repeat(10)}${nameType}${" "}${dds(name)}${" ".repeat(16)}${keywords}`;
  const pf = inspectSource([
    `     A${" ".repeat(38)}REF(REFLIB/FLDREF)`,
    line("R", "CUSTR"),
    line(" ", "CUSTID", "REFFLD(CUSTNO MYLIB/CUSTREF)"),
    line(" ", "NAME", "REFFLD(NAME *SRC)"),
    "     A*  comment line REF(NOPE)",
    line("K", "CUSTID")
  ], "PF");
  assert.equal(pf.language, "dds");
  assert.deepEqual(symbols(pf, "record-format"), ["CUSTR"]);
  assert.deepEqual(symbols(pf, "field"), ["CUSTID", "NAME"]);
  assert.deepEqual(symbols(pf, "key"), ["CUSTID"]);
  assert.deepEqual(deps(pf, "file"), ["REFLIB/FLDREF", "MYLIB/CUSTREF"]);

  const lf = inspectSource([
    line("R", "JOINR", "JFILE(MYLIB/ORDHDR MYLIB/CUSTMAST)"),
    line("R", "CUSTR2", "PFILE(CUSTMAST)")
  ], "LF");
  assert.deepEqual(deps(lf, "file"), ["MYLIB/ORDHDR", "MYLIB/CUSTMAST", "CUSTMAST"]);

  const dspf = inspectSource([line("R", "SCREEN1"), line(" ", "OPTION")], "DSPF");
  assert.deepEqual(symbols(dspf, "record-format"), ["SCREEN1"]);
  assert.deepEqual(symbols(dspf, "field"), []);
});
