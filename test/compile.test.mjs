import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEvfevent } from "../dist/ibmi/evfevent.js";
import { Variables } from "../dist/ibmi/variables.js";
import { LocalLanguageActions } from "../dist/ibmi/LocalLanguageActions.js";
// tools.js first: it loads the module registry, which loads compile.js.
import { getTools, handleTool } from "../dist/mcp/tools.js";
import { findCompiledObject, parseMemberTargetPath, assertNoUnresolvedVariables } from "../dist/mcp/modules/compile.js";

// CRTBNDRPG of DEVLIB/QRPGLESRC(HELLO) that /COPYs COPYDS at line 4.
const RPG_EVFEVENT = [
  "TIMESTAMP  0 20261006101530",
  "PROCESSOR  0 000 1",
  "FILEID     0 001 000000 023 DEVLIB/QRPGLESRC(HELLO) 20261006101500 0",
  "FILEID     0 002 000004 024 DEVLIB/QRPGLESRC(COPYDS) 20261001090000 0",
  "ERROR      0 002 1 000003 000003 007 000003 012 RNF3315 S 30 057 Keyword DIM is not valid for a standalone field; ignored.",
  "FILEEND    0 002 000006",
  "ERROR      0 001 1 000009 000009 000 000009 000 RNF7031 I 00 042 The name or indicator X is not referenced.",
  "ERROR      0 001 1 000012 000012 011 000012 014 RNF7030 S 30 041 The name or indicator FOO is not defined.",
  "ERROR      0 001 1 000015 000015 020 000015 024 RNF5410 E 20 067 The Factor 2 operand is not valid for the specified operation code.",
  "FILEEND    0 001 000020"
];

// CRTSQLRPGI: the precompiler pass expands lines, then the RPG compiler
// reports against the temporary QTEMP/QSQLTEMP1 source.
const SQLRPG_EVFEVENT = [
  "TIMESTAMP  0 20261006113000",
  "PROCESSOR  0 000 1",
  "FILEID     0 001 000000 024 DEVLIB/QRPGLESRC(ORDERS) 20261006112900 0",
  "EXPANSION  0 001 000000 000000 000001 000030",
  "EXPANSION  0 001 000025 000027 000055 000080",
  "ERROR      0 001 1 000025 000025 014 000027 030 SQL0206 E 30 044 Column or global variable CUSTNAM not found.",
  "FILEEND    0 001 000060",
  "PROCESSOR  0 000 2",
  "FILEID     0 001 000000 023 QTEMP/QSQLTEMP1(ORDERS) 20261006113001 1",
  "ERROR      0 001 1 000100 000100 008 000100 015 RNF7030 S 30 043 The name or indicator TOTAL is not defined.",
  "ERROR      0 001 1 000060 000060 010 000060 020 RNF0203 W 10 041 Conversion warning in generated SQL code.",
  "FILEEND    0 001 000090"
];

const CL_STREAMFILE_EVFEVENT = [
  "TIMESTAMP  0 20261006120000",
  "PROCESSOR  0 000 1",
  "FILEID     0 001 000000 024 /home/dev/src/hello.clle 20261006115900 0",
  "ERROR      0 001 1 000004 000004 001 000004 000 CPD0740 E 30 020 PGM command missing.",
  "FILEEND    0 001 000010"
];

test("parseEvfevent groups errors by file, including /COPY members", () => {
  const result = parseEvfevent(RPG_EVFEVENT.join("\r\n"));
  assert.equal(result.timestamp, "20261006101530");
  assert.equal(result.processors, 1);
  assert.equal(result.unparsedLines, 0);
  assert.deepEqual(result.summary, { total: 4, errors: 3, warnings: 0, infos: 1, highestSeverity: 30 });

  const main = result.files.find(f => f.file === "DEVLIB/QRPGLESRC(HELLO)");
  assert.equal(main.library, "DEVLIB");
  assert.equal(main.sourceFile, "QRPGLESRC");
  assert.equal(main.member, "HELLO");
  assert.deepEqual(main.counts, { errors: 2, warnings: 0, infos: 1 });
  assert.deepEqual(main.errors.map(e => [e.line, e.msgid, e.severity]), [
    [9, "RNF7031", "INFO"],
    [12, "RNF7030", "ERROR"],
    [15, "RNF5410", "ERROR"]
  ]);
  const foo = main.errors[1];
  assert.equal(foo.column, 11);
  assert.equal(foo.endColumn, 14);
  assert.equal(foo.severityChar, "S");
  assert.equal(foo.severityLevel, 30);
  assert.equal(foo.text, "The name or indicator FOO is not defined.");

  const copy = result.files.find(f => f.member === "COPYDS");
  assert.equal(copy.errors.length, 1);
  assert.equal(copy.errors[0].line, 3);
  assert.equal(copy.errors[0].text, "Keyword DIM is not valid for a standalone field; ignored.");
});

test("parseEvfevent maps errors in the SQL precompiler temp source back to the original lines", () => {
  const result = parseEvfevent(SQLRPG_EVFEVENT);
  assert.equal(result.processors, 2);
  assert.equal(result.files.length, 1, JSON.stringify(result.files.map(f => f.file)));
  const file = result.files[0];
  assert.equal(file.file, "DEVLIB/QRPGLESRC(ORDERS)");
  const byId = Object.fromEntries(file.errors.map(e => [e.msgid, e]));
  assert.equal(byId.SQL0206.line, 25);
  assert.equal(byId.SQL0206.endLine, 27);
  assert.equal(byId.SQL0206.mappedFrom, undefined);
  // Output line 100: 30 generated lines at the top and 26 lines replacing
  // input 25-27 come before it, so it is input line 47.
  assert.equal(byId.RNF7030.line, 47);
  assert.deepEqual(byId.RNF7030.mappedFrom, { file: "QTEMP/QSQLTEMP1(ORDERS)", line: 100 });
  // Output line 60 is inside the expansion of input lines 25-27.
  assert.equal(byId.RNF0203.line, 25);
  assert.equal(byId.RNF0203.severity, "WARN");
});

test("parseEvfevent handles IFS source and ignores blank lines", () => {
  const result = parseEvfevent(["", ...CL_STREAMFILE_EVFEVENT, "   "]);
  assert.equal(result.files[0].path, "/home/dev/src/hello.clle");
  assert.equal(result.files[0].errors[0].msgid, "CPD0740");
  assert.equal(result.files[0].errors[0].text, "PGM command missing.");
});

test("ibmi.diagnostics.parseEvfevent returns grouped errors", async () => {
  const res = await handleTool({ store: {}, getPolicy: () => ({ profile: "power-user" }) }, "ibmi.diagnostics.parseEvfevent", { content: RPG_EVFEVENT.join("\n") });
  assert.equal(res.structuredContent.data.summary.errors, 3);
  assert.equal(res.structuredContent.data.files.length, 2);
});

test("Variables.expand does not replace &EXT inside &EXTL or &OPENLIB inside &OPENLIBL", () => {
  const vars = new Variables(undefined, {
    "&EXT": "RPGLE",
    "&EXTL": "rpgle",
    "&OPENLIB": "DEVLIB",
    "&OPENLIBL": "devlib",
    "&NAME": "HELLO"
  });
  assert.equal(vars.expand("&OPENLIBL/&NAME.&EXTL &OPENLIB/&NAME.&EXT"), "devlib/HELLO.rpgle DEVLIB/HELLO.RPGLE");
  assert.equal(vars.expand("&NAMEX stays"), "&NAMEX stays");
  assert.equal(vars.expand("x&&EXT"), "x&RPGLE");
});

test("findCompiledObject takes the first object parameter", () => {
  assert.deepEqual(findCompiledObject("CRTBNDRPG PGM(DEVLIB/HELLO) SRCFILE(DEVLIB/QRPGLESRC) OPTION(*EVENTF)", "QGPL"), { library: "DEVLIB", object: "HELLO" });
  assert.deepEqual(findCompiledObject("CRTCMD CMD(*CURLIB/MYCMD) PGM(DEVLIB/MYPGM) OPTION(*EVENTF)", "CUR"), { library: "CUR", object: "MYCMD" });
  assert.deepEqual(findCompiledObject("CRTPF FILE(ORDERS) SRCFILE(DEVLIB/QDDSSRC) OPTION(*EVENTF)", "CUR"), { library: "CUR", object: "ORDERS" });
  assert.deepEqual(findCompiledObject("CRTSQLRPGI OBJ(DEVLIB/ORDERS) SRCFILE(DEVLIB/QRPGLESRC)", "CUR"), { library: "DEVLIB", object: "ORDERS" });
  assert.equal(findCompiledObject("DSPLIBL", "CUR"), undefined);
});

test("member target paths parse in every accepted form", () => {
  assert.deepEqual(parseMemberTargetPath("DEVLIB/QRPGLESRC/HELLO.RPGLE"), { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "HELLO", extension: "RPGLE" });
  assert.deepEqual(parseMemberTargetPath("/QSYS.LIB/DEVLIB.LIB/QRPGLESRC.FILE/HELLO.MBR"), { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "HELLO" });
  assert.throws(() => assertNoUnresolvedVariables("CRTBNDRPG SRCSTMF('&RELATIVEPATH')", "member"), /&RELATIVEPATH/);
  assertNoUnresolvedVariables("a && b", "member");
});

test("built-in actions say which target they take and member actions use no streamfile variables", () => {
  const all = Object.values(LocalLanguageActions).flat();
  for (const action of all) {
    if (/&RELATIVEPATH|&FULLPATH|SRCSTMF/.test(action.command)) assert.equal(action.type, "streamfile", action.name);
    if (action.type === "member") assert.doesNotMatch(action.command, /&RELATIVEPATH|&FULLPATH|SRCSTMF/, action.name);
  }
  assert.ok(all.some(a => a.type === "member" && /^CRTBNDRPG PGM\(&OPENLIB\/&OPENMBR\)/.test(a.command)));
});

function fakeContext({ evfRows = [], qshCode = 0, spool, readOnlyMode = false, policy = { profile: "power-user" } } = {}) {
  const calls = [];
  const downloads = [];
  const conn = {
    getConfig: () => ({ readOnlyMode, currentLibrary: "DEVLIB", libraryList: ["DEVLIB"], homeDirectory: "/home/dev" }),
    async runSQL(sql) {
      calls.push(["sql", sql]);
      if (/sysdummy1/i.test(sql)) return [{ TS: "2026-10-06-10.15.00.000000" }];
      if (/EVFEVENT/.test(sql)) return evfRows.map(line => ({ EVFEVENT: line }));
      if (/output_queue_entries/i.test(sql)) return spool ? [spool.entry] : [];
      if (/display_spooled_file_data/i.test(sql)) return (spool?.lines || []).map((text, i) => ({ ORDINAL_POSITION: i + 1, SPOOLED_DATA: text }));
      if (/SYSPARTITIONSTAT/i.test(sql)) return [{ SYSTEM_TABLE_MEMBER: "HELLO", SOURCE_TYPE: "RPGLE", PARTITION_TEXT: "" }];
      return [];
    },
    async sendCommand(options) {
      calls.push(["cmd", options.command, options.directory]);
      if (/^test -d/.test(options.command)) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async sendQsh(options) {
      calls.push(["qsh", options.command, options.directory]);
      return { code: qshCode, stdout: "", stderr: qshCode ? "CPF5D0A: Compile failed." : "" };
    },
    client: {
      async getFile(local, remote) { downloads.push(["file", local, remote]); await fs.writeFile(local, "x"); },
      async getDirectory(local, remote) {
        downloads.push(["dir", local, remote]);
        await fs.writeFile(path.join(local, "HELLO.evfevent"), CL_STREAMFILE_EVFEVENT.join("\n"));
      }
    },
    content: {
      async getMemberInfo() { return { extension: "RPGLE" }; }
    },
    remoteFeatures: {},
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/.test(name),
    defaultUserLibraries: [],
    currentUser: "DEV",
    currentHost: "dev"
  };
  const ctx = {
    store: { listActions: async () => [], getSettings: async () => ({}) },
    activeName: "DEV",
    ensureActive: async () => conn,
    getPolicy: () => policy,
    resolvePolicy: async () => policy
  };
  return { ctx, calls, downloads };
}

test("actions.run compiles a member, reads EVFEVENT and returns errors by file", async () => {
  const { ctx, calls } = fakeContext({ evfRows: RPG_EVFEVENT, qshCode: 1 });
  const res = await handleTool(ctx, "ibmi.actions.run", {
    actionName: "Create Bound RPG Program (CRTBNDRPG)",
    targetType: "member",
    targetPath: "devlib/qrpglesrc/hello"
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /3 error\(s\); first: RNF3315 line 3/);
  const data = res.structuredContent.data;
  assert.equal(data.ok, false);
  assert.equal(data.target.path, "DEVLIB/QRPGLESRC/HELLO.RPGLE");
  assert.deepEqual(data.evfevent, { library: "DEVLIB", member: "HELLO", found: true, records: RPG_EVFEVENT.length, error: undefined });
  assert.equal(data.errorSummary.errors, 3);
  assert.deepEqual(data.errors.map(f => f.member).sort(), ["COPYDS", "HELLO"]);

  const qsh = calls.find(([kind]) => kind === "qsh");
  assert.ok(qsh[1].includes("system 'CRTBNDRPG PGM(DEVLIB/HELLO) SRCFILE(DEVLIB/QRPGLESRC) SRCMBR(HELLO) OPTION(*EVENTF) DBGVIEW(*SOURCE)'"), qsh[1]);
  const evfSql = calls.find(([kind, sql]) => kind === "sql" && /EVFEVENT/.test(sql));
  assert.match(evfSql[1], /create alias QTEMP\.MCP_EVFEVENT for "DEVLIB"\."EVFEVENT"\("HELLO"\)/);
});

test("actions.run sets &EXT and &EXTL for members and refuses streamfile variables", async () => {
  const { ctx, calls } = fakeContext();
  const res = await handleTool(ctx, "ibmi.actions.run", {
    action: { name: "echo", command: "SNDMSG MSG('&OPENLIBL &OPENLIB &EXT &EXTL &BASENAME') TOUSR(*SYSOPR)", environment: "ile" },
    targetType: "member",
    library: "DEVLIB",
    sourceFile: "QRPGLESRC",
    member: "HELLO"
  });
  assert.equal(res.isError, undefined);
  const qsh = calls.find(([kind]) => kind === "qsh");
  assert.ok(qsh[1].includes("devlib DEVLIB RPGLE rpgle HELLO.RPGLE"), qsh[1]);

  const before = calls.length;
  await assert.rejects(
    handleTool(ctx, "ibmi.actions.run", {
      action: { name: "stmf", command: "CRTBNDRPG PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH')", environment: "ile" },
      targetType: "member",
      targetPath: "DEVLIB/QRPGLESRC/HELLO.RPGLE"
    }),
    /&RELATIVEPATH, which is not set for member targets/
  );
  await assert.rejects(
    handleTool(ctx, "ibmi.actions.run", { actionName: "Create RPGLE Program", targetType: "member", targetPath: "DEVLIB/QRPGLESRC/HELLO.RPGLE" }),
    /runs against streamfile targets, not member targets/
  );
  assert.equal(calls.slice(before).filter(([kind]) => kind === "qsh").length, 0);
});

test("actions.run keeps the write gate", async () => {
  const { ctx, calls } = fakeContext({ readOnlyMode: true });
  await assert.rejects(
    handleTool(ctx, "ibmi.actions.run", { actionName: "Create Bound RPG Program (CRTBNDRPG)", targetType: "member", targetPath: "DEVLIB/QRPGLESRC/HELLO" }),
    /read-only mode/
  );
  assert.equal(calls.length, 0);
});

test("actions.run streamfile targets use a relative path from the working directory", async () => {
  const { ctx, calls } = fakeContext({ evfRows: CL_STREAMFILE_EVFEVENT, qshCode: 0 });
  const res = await handleTool(ctx, "ibmi.actions.run", {
    actionName: "Create Bound CL Program",
    targetType: "streamfile",
    targetPath: "/home/dev/src/hello.clle"
  });
  const qsh = calls.find(([kind]) => kind === "qsh");
  assert.equal(qsh[2], "/home/dev");
  assert.ok(qsh[1].includes("CRTBNDCL PGM(DEVLIB/hello) SRCSTMF('\\''src/hello.clle'\\'')"), qsh[1]);
  const data = res.structuredContent.data;
  assert.equal(data.status, "warning");
  assert.equal(data.evfevent.member, "HELLO");
  assert.equal(data.errors[0].path, "/home/dev/src/hello.clle");
});

test("actions.run honours postDownload, outputToFile, includeListing and a skipped deployFirst", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-compile-"));
  const previous = process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
  process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = dir;
  try {
    const { ctx, calls, downloads } = fakeContext({
      spool: {
        entry: { JOB_NAME: "123456/DEV/QZSHSH", SPOOLED_FILE_NAME: "HELLO", FILE_NUMBER: 2, CREATE_TIMESTAMP: "2026-10-06-10.15.01", USER_NAME: "DEV" },
        lines: ["5770WDS V7R5M0 ILE RPG HELLO", "Compile listing line"]
      }
    });
    const action = {
      name: "Build with make",
      command: "/QOpenSys/pkgs/bin/gmake &BASENAME BUILDLIB=&CURLIB ERR=*EVENTF",
      environment: "pase",
      type: "streamfile",
      deployFirst: true,
      postDownload: [".evfevent/"],
      outputToFile: "&LOCAL/.logs/&NAME.log"
    };
    const res = await handleTool(ctx, "ibmi.actions.run", {
      action,
      targetType: "streamfile",
      targetPath: "/home/dev/proj/hello.pgm.clle",
      remoteWorkspace: "/home/dev/proj",
      downloadTo: dir,
      includeListing: true
    });
    const data = res.structuredContent.data;
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.deepEqual(data.deploy, { skipped: true, reason: "deployFirst is set but no localWorkspace was given" });
    const cmd = calls.find(([kind, command]) => kind === "cmd" && /gmake/.test(command));
    assert.equal(cmd[2], "/home/dev/proj");
    assert.match(cmd[1], /gmake hello\.pgm\.clle BUILDLIB=DEVLIB/);

    assert.equal(downloads[0][0], "dir");
    assert.equal(downloads[0][2], "/home/dev/proj/.evfevent");
    assert.equal(data.postDownload[0].ok, true);
    assert.equal(data.errors[0].errors[0].msgid, "CPD0740");

    // outputToFile needs a local workspace for &LOCAL.
    assert.equal(data.outputFile.ok, false);

    assert.equal(data.listing.found, true);
    assert.equal(data.listing.spooledFileName, "HELLO");
    assert.deepEqual(data.listing.lines, ["5770WDS V7R5M0 ILE RPG HELLO", "Compile listing line"]);
    const spoolSql = calls.find(([kind, sql]) => kind === "sql" && /output_queue_entries/i.test(sql));
    assert.match(spoolSql[1], /spooled_file_name in \('HELLO\.PGM', 'QSYSPRT', 'QPJOBLOG'\)|create_timestamp >= timestamp\('2026-10-06-10\.15\.00\.000000'\)/);

    const withLocal = await handleTool(ctx, "ibmi.actions.run", {
      action: { ...action, deployFirst: false, postDownload: [] },
      targetType: "streamfile",
      targetPath: "/home/dev/proj/hello.clle",
      localWorkspace: dir
    });
    const outputFile = withLocal.structuredContent.data.outputFile;
    assert.equal(typeof outputFile, "string");
    assert.equal(path.basename(outputFile), "hello.log");
    assert.match(await fs.readFile(outputFile, "utf8"), /Command: \/QOpenSys\/pkgs\/bin\/gmake hello\.clle/);
  } finally {
    if (previous === undefined) delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    else process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("actions.run with deployFirst syncs the local workspace before running", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-deploy-"));
  const previous = process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
  process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = dir;
  try {
    await fs.writeFile(path.join(dir, "hello.clle"), "PGM\nENDPGM\n");
    const { ctx, calls } = fakeContext();
    const uploads = [];
    const conn = await ctx.ensureActive();
    conn.client.putFile = async (local, remote) => { uploads.push([local, remote]); calls.push(["put", remote]); };
    const res = await handleTool(ctx, "ibmi.actions.run", {
      actionName: "Create Bound CL Program",
      targetType: "streamfile",
      targetPath: "/home/dev/proj/hello.clle",
      localWorkspace: dir,
      remoteWorkspace: "/home/dev/proj"
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.deepEqual(res.structuredContent.data.deploy.applied.uploaded, ["hello.clle"]);
    const putIndex = calls.findIndex(([kind]) => kind === "put");
    const qshIndex = calls.findIndex(([kind]) => kind === "qsh");
    assert.ok(putIndex >= 0 && putIndex < qshIndex, "upload must happen before the compile");
    assert.ok(calls[qshIndex][1].includes("SRCSTMF('\\''hello.clle'\\'')"), calls[qshIndex][1]);
  } finally {
    if (previous === undefined) delete process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS;
    else process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ibmi.compile.listing returns the newest listing and is declared read-only", async () => {
  const tool = getTools().find(t => t.name === "ibmi.compile.listing");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.inputSchema.properties.connectionName);

  const { ctx, calls } = fakeContext({
    spool: { entry: { JOB_NAME: "123456/DEV/QZSHSH", SPOOLED_FILE_NAME: "HELLO", FILE_NUMBER: 1 }, lines: ["a", "b", "c"] }
  });
  const res = await handleTool(ctx, "ibmi.compile.listing", { objectName: "hello", maxLines: 2 });
  assert.deepEqual(res.structuredContent.data.lines, ["a", "b"]);
  assert.equal(res.structuredContent.data.truncated, true);
  const read = calls.find(([kind, sql]) => kind === "sql" && /display_spooled_file_data/.test(sql));
  assert.match(read[1], /display_spooled_file_data\('123456\/DEV\/QZSHSH', 'HELLO', 1\)/);
  await assert.rejects(handleTool(ctx, "ibmi.compile.listing", { objectName: "hello", since: "yesterday'; drop" }), /Invalid since/);
});
