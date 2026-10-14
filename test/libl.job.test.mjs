import test from "node:test";
import assert from "node:assert/strict";
import { IBMiClient } from "../dist/ibmi/client.js";
import {
  PersistentSqlJob,
  qcmdexcLiteral,
  normalizeJobName,
  jdbcPropertiesString
} from "../dist/ibmi/sqlJob.js";
import {
  desiredLibraryList,
  libraryListCommand,
  resolveAgainstExisting,
  qshLibraryListPrefix
} from "../dist/ibmi/libraryList.js";
import { handleTool } from "../dist/mcp/tools.js";

const JOB = "123456/QUSER/QZDASOINIT";
const NOISE = { id: "MCH3401", type: "ESCAPE", text: "Cannot resolve to object PPTT. Type and Subtype X'0401' Authority X'0000'." };

/**
 * A fake Mapepire job with CL requests. `libraries` lists the libraries that
 * exist; CHGLIBL/CHGCURLIB fail when one is missing, like on the IBM i.
 */
function fakeClJob({ libraries = ["DEVLIB", "APPLIB", "DATA", "QGPL"], respond } = {}) {
  const job = {
    jobName: JOB,
    mode: "ssh",
    technique: "tcp",
    closed: false,
    statements: [],
    cl: [],
    libl: [],
    curlib: undefined,
    isAlive() { return !this.closed; },
    async run(sql, options) {
      job.statements.push({ sql, parameters: options.parameters });
      if (/OBJECT_STATISTICS/i.test(sql)) {
        const names = [...sql.matchAll(/'([A-Z0-9#@$_.]+)'/g)].map(m => m[1]).filter(n => libraries.includes(n));
        return { rows: names.map(OBJNAME => ({ OBJNAME })) };
      }
      return respond ? respond(sql, job) : { rows: [] };
    },
    async runCl(command) {
      job.cl.push(command);
      const missing = [...command.matchAll(/\b(LIBL|CURLIB)\(([^)]*)\)/g)]
        .flatMap(m => m[2].trim().split(/\s+/))
        .filter(lib => lib && !libraries.includes(lib));
      if (missing.length > 0) {
        return {
          success: false,
          messages: [NOISE, { id: "CPF2110", type: "DIAGNOSTIC", text: `Library ${missing[0]} not found.` }, { id: "CPF2184", type: "ESCAPE", text: "Library list not replaced." }]
        };
      }
      const libl = command.match(/LIBL\(([^)]*)\)/);
      if (libl) job.libl = libl[1].trim().split(/\s+/);
      const cur = command.match(/CURLIB\(([^)]*)\)/);
      if (cur) job.curlib = cur[1].trim();
      return { success: true, messages: [NOISE, { id: "CPC2101", type: "COMPLETION", text: "Library list changed." }] };
    },
    async close() { job.closed = true; }
  };
  return job;
}

function fakeSsh(calls, respond = () => ({})) {
  return {
    async execCommand(command, options) {
      calls.push({ command, stdin: options?.stdin });
      return { code: 0, signal: null, stdout: "", stderr: "", ...respond(command, options?.stdin) };
    },
    dispose() {}
  };
}

function connectedClient(config, factory, sshRespond) {
  const sshCalls = [];
  const client = new IBMiClient({ name: "t", host: "h", port: 22, username: "u", ...config }, { sqlJobFactory: factory });
  client.client = fakeSsh(sshCalls, sshRespond);
  client.connection = { name: "t", host: "h", port: 22, username: "u", password: "pw" };
  return { client, sshCalls };
}

/** QZDFMDB2 output for a failing CL call (CLI error block). */
function cliError(text) {
  return `DB2>\n\n **** CLI ERROR *****\n         SQLSTATE: 38501\nNATIVE ERROR CODE: -443\n${text}\nDB2>\n`;
}

/** QZDFMDB2 output for a one-column result. */
function db2Rows(column, values) {
  return `DB2>\n\n${column.padEnd(10)}\n----------\n${values.map(v => v.padEnd(10)).join("\n")}\n\n  ${values.length} RECORD(S) SELECTED.\n\nDB2>\n`;
}

test("CL runs as a CL request so its library list changes last; the configured list is applied once", async () => {
  const job = fakeClJob({ respond: () => ({ rows: [{ A: 1 }] }) });
  let config = { libraryList: ["devlib", "APPLIB"], currentLibrary: "DEVLIB" };
  const { client } = connectedClient({}, async () => job);
  client.setConfig({ ...client.getConfig(), ...config });

  await client.runSQL("select a from t");
  await client.runSQL("@CHGJOB LOG(4 00 *SECLVL)\nselect a from t;\nCALL QSYS2.QCMDEXC('CHGCURLIB CURLIB(APPLIB)');\ncall qcmdexc('ADDLIBLE LIB(DATA)', 0000000018.00000)");
  assert.deepEqual(job.cl, [
    "CHGLIBL LIBL(DEVLIB APPLIB) CURLIB(DEVLIB)",
    "CHGJOB LOG(4 00 *SECLVL)",
    "CHGCURLIB CURLIB(APPLIB)",
    "ADDLIBLE LIB(DATA)"
  ], "the library list is applied before the first statement only; @ lines and literal QCMDEXC calls are CL requests");
  assert.ok(job.statements.every(s => !/QCMDEXC/i.test(s.sql)), "no CL runs through a SQL request");

  // CL from ibmi.cl.run / ibmi.libl.*: messages come back, noise is dropped.
  const result = await client.runCL("CHGCURLIB CURLIB(DEVLIB)");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "CPC2101: Library list changed.");

  // A changed setting is applied before the next statement, once.
  client.setConfig({ ...client.getConfig(), libraryList: ["DATA", "QGPL"] });
  await client.runSQL("select a from t");
  await client.runSQL("select a from t");
  assert.equal(job.cl.at(-1), "CHGLIBL LIBL(DATA QGPL) CURLIB(DEVLIB)");
  assert.equal(job.cl.filter(c => c.startsWith("CHGLIBL")).length, 2);
  assert.deepEqual(job.libl, ["DATA", "QGPL"]);
  assert.equal(client.sqlJob.status().libraryListWarning, undefined);
});

test("a failing CL request reports its messages; a missing library is left out with a warning", async () => {
  const job = fakeClJob({ libraries: ["DEVLIB", "QGPL"], respond: () => ({ rows: [{ A: 1 }] }) });
  const { client } = connectedClient({ libraryList: ["DEVLIB", "GONE", "QGPL"], currentLibrary: "OLDCUR" }, async () => job);

  const rows = await client.runSQL("select a from t");
  assert.deepEqual(rows, [{ A: 1 }], "the statement still runs");
  assert.deepEqual(job.cl, ["CHGLIBL LIBL(DEVLIB GONE QGPL) CURLIB(OLDCUR)", "CHGLIBL LIBL(DEVLIB QGPL)"]);
  assert.deepEqual(job.libl, ["DEVLIB", "QGPL"]);
  assert.match(client.sqlJob.status().libraryListWarning, /not found, left out of the library list: GONE, OLDCUR/);

  // Not retried on every call while the setting is unchanged.
  await client.runSQL("select a from t");
  assert.equal(job.cl.length, 2);

  const bad = await client.runCL("CHGCURLIB CURLIB(NOPE)");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /CHGCURLIB failed: CPF2110: Library NOPE not found\. CPF2184/);
  assert.doesNotMatch(bad.stderr, /PPTT/);
  await assert.rejects(client.runSQL("@CHGCURLIB CURLIB(NOPE)"), err => err.sqlstate === "38501" && /CPF2110/.test(err.message));

  // applyToJob reapplies now and reports the warning.
  const applied = await client.applyConfiguredLibraryList();
  assert.equal(applied.applied, "job");
  assert.match(applied.warning, /GONE/);
});

test("QZDFMDB2: the configured list leads every batch; it is checked once per setting", async () => {
  const { client, sshCalls } = connectedClient(
    { sqlTransport: "qzdfmdb2", libraryList: ["DEVLIB", "APPLIB"], currentLibrary: "DEVLIB" },
    async () => { throw new Error("no job"); }
  );
  await client.runSQL("select 1 from sysibm.sysdummy1");
  await client.runSQL("select 2 from sysibm.sysdummy1");
  assert.equal(sshCalls.length, 3, "one check, then one call per batch");
  assert.equal(sshCalls[0].stdin, "Call QSYS2.QCMDEXC('CHGLIBL LIBL(DEVLIB APPLIB) CURLIB(DEVLIB)');\n");
  for (const call of sshCalls.slice(1)) {
    assert.match(call.stdin, /^Call QSYS2\.QCMDEXC\('CHGLIBL LIBL\(DEVLIB APPLIB\) CURLIB\(DEVLIB\)'\);\nselect \d from sysibm\.sysdummy1\n$/);
    assert.match(call.command, /QZDFMDB2/);
  }

  // CL that falls back to qsh gets the list through the liblist builtin.
  await client.runCL("CALL PGM(MYPGM)");
  const qsh = sshCalls.at(-1).stdin;
  assert.match(qsh, /liblist -a 'APPLIB' >\/dev\/null 2>&1; liblist -a 'DEVLIB' >\/dev\/null 2>&1; liblist -c 'DEVLIB' >\/dev\/null 2>&1; system 'CALL PGM\(MYPGM\)'$/);
});

test("QZDFMDB2: when CHGLIBL fails, missing libraries are dropped and the warning is shown", async () => {
  const { client, sshCalls } = connectedClient(
    { sqlTransport: "qzdfmdb2", libraryList: ["DEVLIB", "GONE"], currentLibrary: "DEVLIB" },
    async () => { throw new Error("no job"); },
    (_command, stdin) => {
      if (/CHGLIBL LIBL\(DEVLIB GONE\)/.test(stdin)) return { stdout: cliError("Library GONE not found.") };
      if (/OBJECT_STATISTICS/.test(stdin)) return { stdout: db2Rows("OBJNAME", ["DEVLIB"]) };
      return {};
    }
  );
  const rows = await client.runSQL("select 1 from sysibm.sysdummy1");
  assert.deepEqual(rows, []);
  assert.match(sshCalls.at(-1).stdin, /^Call QSYS2\.QCMDEXC\('CHGLIBL LIBL\(DEVLIB\) CURLIB\(DEVLIB\)'\);\nselect 1/);
  const status = client.sqlJob.status();
  assert.equal(status.active, "qzdfmdb2");
  assert.match(status.libraryListWarning, /left out of the library list: GONE/);

  // When even the reduced list fails, batches run without it.
  const other = connectedClient(
    { sqlTransport: "qzdfmdb2", libraryList: ["DEVLIB"] },
    async () => { throw new Error("no job"); },
    (_command, stdin) => /^Call QSYS2\.QCMDEXC\('CHGLIBL/.test(stdin) ? { stdout: cliError("Not authorized to library DEVLIB.") } : { stdout: db2Rows("OBJNAME", ["DEVLIB"]) }
  );
  await other.client.runSQL("select 1 from sysibm.sysdummy1").catch(() => undefined);
  assert.doesNotMatch(other.sshCalls.at(-1).stdin, /CHGLIBL/);
  assert.match(other.client.sqlJob.status().libraryListWarning, /not applied: CHGLIBL LIBL\(DEVLIB\) failed: Not authorized/);
});

test("a job without CL requests still applies the list through QCMDEXC", async () => {
  const statements = [];
  const job = {
    jobName: JOB, mode: "daemon",
    isAlive: () => true,
    async run(sql, options) { statements.push([sql, options.parameters]); return { rows: [] }; },
    async close() {}
  };
  const sqlJob = new PersistentSqlJob({ getConfig: () => ({ libraryList: ["A"] }), getOpenRequest: () => ({}), factory: async () => job });
  await sqlJob.runSql("select 1 from x");
  assert.deepEqual(statements, [["CALL QSYS2.QCMDEXC(?)", ["CHGLIBL LIBL(A)"]], ["select 1 from x", undefined]]);
});

test("ibmi.libl.* applyToJob uses the client's configured list and reports warnings", async () => {
  let applied = 0;
  const store = {
    connection: { name: "DEV", settings: { libraryList: ["A"] } },
    async getConnection() { return this.connection; },
    async upsertConnection(conn) { this.connection = conn; }
  };
  let config = { readOnlyMode: false, libraryList: ["A"] };
  const conn = {
    currentConnectionName: "DEV",
    getConfig: () => config,
    setConfig: next => { config = next; },
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(name),
    async applyConfiguredLibraryList() { applied += 1; return { applied: "job", warning: "Configured library list: not found, left out of the library list: B" }; }
  };
  const ctx = { store, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => ({ profile: "power-user" }) };
  const response = await handleTool(ctx, "ibmi.libl.add", { library: "b", applyToJob: true });
  assert.equal(applied, 1);
  assert.deepEqual(config.libraryList, ["A", "B"], "the active config is updated before it is applied");
  assert.match(response.content[0].text, /^OK\. Warning: .*left out of the library list: B/);
  await assert.rejects(handleTool(ctx, "ibmi.libl.setCurrent", { library: "1BAD", applyToJob: true }), /Invalid library name/);
});

test("library list helpers", () => {
  const desired = desiredLibraryList({ libraryList: [" devlib", "APPLIB", "devlib", "bad name"], currentLibrary: "cur" });
  assert.deepEqual(desired.libraries, ["DEVLIB", "APPLIB"]);
  assert.equal(desired.currentLibrary, "CUR");
  assert.deepEqual(desired.invalid, ["BAD NAME"]);
  assert.equal(libraryListCommand(desired.libraries, desired.currentLibrary), "CHGLIBL LIBL(DEVLIB APPLIB) CURLIB(CUR)");
  assert.equal(libraryListCommand([], "CUR"), "CHGCURLIB CURLIB(CUR)");
  assert.equal(libraryListCommand([]), undefined);
  const resolved = resolveAgainstExisting(desired, new Set(["APPLIB"]));
  assert.equal(resolved.command, "CHGLIBL LIBL(APPLIB)");
  assert.match(resolved.warning, /DEVLIB, CUR.*invalid library name\(s\) ignored: BAD NAME/);
  assert.equal(
    qshLibraryListPrefix({ libraries: ["A", "B"], currentLibrary: "C" }, ["QGPL", "QTEMP"]),
    "liblist -d 'QGPL' >/dev/null 2>&1; liblist -a 'B' >/dev/null 2>&1; liblist -a 'A' >/dev/null 2>&1; liblist -c 'C' >/dev/null 2>&1"
  );

  assert.equal(qcmdexcLiteral("CALL QSYS2.QCMDEXC('CHGCURLIB CURLIB(''X'')')"), "CHGCURLIB CURLIB('X')");
  assert.equal(qcmdexcLiteral("call qsys/qcmdexc('DSPLIBL', 7)"), "DSPLIBL");
  assert.equal(qcmdexcLiteral("CALL QSYS2.QCMDEXC(?)"), undefined);
  assert.equal(qcmdexcLiteral("CALL QSYS2.QCMDEXC('A' || 'B')"), undefined);
  assert.equal(qcmdexcLiteral("select 'CALL QCMDEXC(''X'')' from t"), undefined);

  assert.equal(normalizeJobName("220537-QSECOFR-QP0ZSPWT"), "220537/QSECOFR/QP0ZSPWT");
  assert.equal(normalizeJobName(JOB), JOB);
  assert.equal(normalizeJobName(undefined), undefined);
  assert.equal(jdbcPropertiesString({ naming: "system", libraries: ["A", "B"] }), "naming=system;libraries=A,B");
});
