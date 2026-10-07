import test from "node:test";
import assert from "node:assert/strict";
import { getTools, handleTool } from "../dist/mcp/tools.js";
import { buildPaseProbeScript, parsePaseProbe } from "../dist/mcp/modules/system.js";
import { buildChangedLinesSql, parseDateArgument, srcdatToFullDate } from "../dist/mcp/modules/changedLines.js";
import { libraryListFromRows, moveLibrary } from "../dist/mcp/modules/libl.js";

function fakeConn(overrides = {}) {
  const calls = { sql: [], commands: [], qsh: [] };
  let config = { readOnlyMode: false, ...(overrides.config || {}) };
  const conn = {
    getConfig: () => config,
    setConfig: next => { config = next; },
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      return overrides.runSQL ? overrides.runSQL(sql, calls) : [];
    },
    async sendCommand(options) {
      calls.commands.push(options.command);
      return overrides.sendCommand ? overrides.sendCommand(options, calls) : { code: 0, stdout: "", stderr: "" };
    },
    async sendQsh(options) {
      calls.qsh.push(options.command);
      return { code: 0, stdout: "", stderr: "" };
    }
  };
  return { conn, calls };
}

function context(conn, stored = { name: "DEV", settings: {} }, policy = { profile: "power-user" }) {
  const saved = { connection: stored, profiles: [] };
  return {
    saved,
    activeName: "DEV",
    ensureActive: async () => conn,
    getPolicy: () => policy,
    store: {
      getConnection: async () => JSON.parse(JSON.stringify(saved.connection)),
      upsertConnection: async next => { saved.connection = next; },
      saveProfile: async (_name, profile) => { saved.profiles.push(profile); }
    }
  };
}

const data = response => response.structuredContent.data;

// ---- registration ----

test("new tools are registered with annotations and strict schemas", () => {
  const tools = getTools();
  for (const name of ["ibmi.system.info", "ibmi.search.changedLines", "ibmi.libl.move", "ibmi.libl.prune", "ibmi.libl.runProfileCommand"]) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.ok(tool.inputSchema.properties.connectionName, name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", name);
    assert.equal(tool.annotations.openWorldHint, false, name);
  }
  assert.equal(tools.find(item => item.name === "ibmi.system.info").annotations.readOnlyHint, true);
  assert.equal(tools.find(item => item.name === "ibmi.libl.move").annotations.readOnlyHint, false);
  const profileSchema = tools.find(item => item.name === "ibmi.profiles.save").inputSchema.properties.profile;
  assert.ok(profileSchema.properties.setLibraryListCommand);
});

// ---- ibmi.system.info ----

test("system.info returns all sections and uses one PASE call", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("ENV_SYS_INFO")) return [{ OS_NAME: "IBM i", OS_VERSION: "7", OS_RELEASE: "5", HOST_NAME: "DEV400", TOTAL_CPUS: 2, CONFIGURED_CPUS: 2, TOTAL_MEMORY: 16384 }];
      if (sql.includes("SYSTEM_STATUS_INFO")) return [{ PARTITION_ID: 3, SYSTEM_ASP_USED: 61.2 }];
      if (sql.includes("GROUP_PTF_INFO")) return [
        { PTF_GROUP_NAME: "SF99750", DESCRIPTION: "CUMULATIVE", LATEST_LEVEL: 24100, INSTALLED_LEVEL: 24100, LATEST_STATUS: "INSTALLED" },
        { PTF_GROUP_NAME: "SF99950", DESCRIPTION: "DB2", LATEST_LEVEL: 7, INSTALLED_LEVEL: 6, LATEST_STATUS: "NOT INSTALLED" }
      ];
      if (sql.includes("USER_INFO")) return [{ RUNTIME_USER: "DEVUSER", SYSTEM_USER_NAME: "DEVUSER", USER_CLASS_NAME: "*PGMR", SPECIAL_AUTHORITIES: "*JOBCTL   *SPLCTL", GROUP_PROFILE_NAME: "*NONE", SUPPLEMENTAL_GROUP_LIST: null, LIMIT_CAPABILITIES: "*NO", STATUS: "*ENABLED" }];
      if (sql.includes("SYSTEM_VALUE_INFO")) return [
        { SYSTEM_VALUE_NAME: "QSECURITY", CURRENT_NUMERIC_VALUE: null, CURRENT_CHARACTER_VALUE: "40" },
        { SYSTEM_VALUE_NAME: "QCCSID", CURRENT_NUMERIC_VALUE: 37, CURRENT_CHARACTER_VALUE: null }
      ];
      return [];
    },
    sendCommand: () => ({
      code: 0,
      stderr: "",
      stdout: "uname=OS400 5 7\nenv.PATH=/QOpenSys/pkgs/bin:/usr/bin\nenv.LANG=\ntool.pfgrep=/QOpenSys/pkgs/bin/pfgrep\ntool.git=\ntool.mapepire-server=/QOpenSys/pkgs/bin/mapepire\n"
    })
  });
  const out = data(await handleTool(context(conn), "ibmi.system.info", {}));
  assert.equal(out.os.release, "7.5");
  assert.equal(out.os.hostName, "DEV400");
  assert.equal(out.os.status.partitionId, 3);
  assert.deepEqual(out.ptfGroups.groups[1], { group: "SF99950", description: "DB2", latestLevel: 7, latestStatus: "NOT INSTALLED", installedLevel: 6 });
  assert.equal(out.ptfGroups.truncated, false);
  assert.deepEqual(out.authorities.specialAuthorities, ["*JOBCTL", "*SPLCTL"]);
  assert.deepEqual(out.authorities.supplementalGroups, []);
  assert.equal(out.authorities.groupProfile, "*NONE");
  assert.deepEqual(out.systemValues.values, { QCCSID: 37, QSECURITY: "40" });
  assert.equal(out.pase.uname, "OS400 5 7");
  assert.equal(out.pase.env.PATH, "/QOpenSys/pkgs/bin:/usr/bin");
  assert.equal(out.pase.env.LANG, null);
  assert.equal(out.tools.pfgrep, "/QOpenSys/pkgs/bin/pfgrep");
  assert.equal(out.tools.git, null);
  assert.equal(out.tools["mapepire-server"], "/QOpenSys/pkgs/bin/mapepire");
  assert.equal(calls.commands.length, 1);
  assert.equal(out.errors, undefined);
  // Only allow-listed system values are queried.
  const svSql = calls.sql.find(sql => sql.includes("SYSTEM_VALUE_INFO"));
  assert.match(svSql, /'QSECURITY'/);
});

test("system.info honours sections, caps PTF groups and reports section errors", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("GROUP_PTF_INFO")) {
        const limit = Number(/fetch first (\d+) rows/.exec(sql)[1]);
        return Array.from({ length: limit }, (_v, i) => ({ PTF_GROUP_NAME: `SF${i}`, LATEST_LEVEL: 1, INSTALLED_LEVEL: 1 }));
      }
      if (sql.includes("USER_INFO")) throw new Error("SQL0204 USER_INFO not found");
      return [];
    }
  });
  const out = data(await handleTool(context(conn), "ibmi.system.info", { sections: ["ptfGroups", "authorities"], ptfGroupLimit: 3 }));
  assert.deepEqual(out.sections, ["ptfGroups", "authorities"]);
  assert.equal(out.ptfGroups.groups.length, 3);
  assert.equal(out.ptfGroups.truncated, true);
  assert.match(out.errors.authorities, /SQL0204/);
  assert.equal(out.os, undefined);
  assert.equal(calls.commands.length, 0, "no PASE call when pase/tools not requested");
});

test("system.info rejects system values outside the allow-list and unknown sections", async () => {
  const { conn, calls } = fakeConn();
  await assert.rejects(handleTool(context(conn), "ibmi.system.info", { systemValues: ["QSECURITY", "QPWDRULES'--"] }), /allow-list/);
  await assert.rejects(handleTool(context(conn), "ibmi.system.info", { sections: ["secrets"] }), /Unknown section/);
  assert.equal(calls.sql.length, 0);
});

test("PASE probe script is static and its output parses", () => {
  const script = buildPaseProbeScript();
  assert.match(script, /command -v/);
  assert.match(script, /pfgrep openssl git bash python3 node/);
  const parsed = parsePaseProbe("uname=AIX\nenv.HOME=/home/dev\ntool.bash=/QOpenSys/pkgs/bin/bash\nnoise\n");
  assert.deepEqual(parsed, { uname: "AIX", env: { HOME: "/home/dev" }, tools: { bash: "/QOpenSys/pkgs/bin/bash" } });
});

// ---- ibmi.search.changedLines ----

test("SRCDAT century handling follows the 1940-2039 window", () => {
  assert.equal(srcdatToFullDate(991231), 19991231);
  assert.equal(srcdatToFullDate(400101), 19400101);
  assert.equal(srcdatToFullDate(391231), 20391231);
  assert.equal(srcdatToFullDate(260115), 20260115);
  assert.equal(srcdatToFullDate(0), 0);
  assert.equal(parseDateArgument("2026-01-15", "from"), 20260115);
  assert.equal(parseDateArgument("20260115", "from"), 20260115);
  assert.equal(parseDateArgument("991231", "from"), 19991231);
  assert.throws(() => parseDateArgument("2026-02-30", "from"), /not a real date/);
  assert.throws(() => parseDateArgument("yesterday", "from"), /Invalid from/);
});

test("changedLines builds a QTEMP alias query in one runSQL call", () => {
  const sql = buildChangedLinesSql("MYLIB", "QRPGLESRC", "ORDERS", 20250101, 20251231, 11);
  assert.match(sql, /^create or replace alias QTEMP\."MCP_[0-9A-F]+" for "MYLIB"\."QRPGLESRC"\("ORDERS"\);/);
  assert.match(sql, /between 20250101 and 20251231/);
  assert.match(sql, /M\.SRCDAT >= 400000 then 19000000 \+ M\.SRCDAT else 20000000 \+ M\.SRCDAT/);
  assert.match(sql, /fetch first 11 rows only/);
});

test("changedLines returns lines for one member and reports truncation", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [
      { LINE_NUMBER: 3, SRCSEQ: 3, FULL_DATE: 20250310, SRCDTA: "     C                   EVAL      X = 1   " },
      { LINE_NUMBER: 9, SRCSEQ: 9, FULL_DATE: 19991231, SRCDTA: "old" },
      { LINE_NUMBER: 12, SRCSEQ: 12, FULL_DATE: 20250311, SRCDTA: "extra" }
    ]
  });
  const out = data(await handleTool(context(conn), "ibmi.search.changedLines", {
    library: "mylib", sourceFile: "qrpglesrc", member: "orders", from: "1999-01-01", to: "2025-12-31", maxLines: 2
  }));
  assert.equal(calls.sql.length, 1);
  assert.match(calls.sql[0], /fetch first 3 rows only/);
  assert.equal(out.member, "ORDERS");
  assert.deepEqual(out.hits[0], { member: "ORDERS", line: 3, sequence: 3, date: "2025-03-10", text: "     C                   EVAL      X = 1" });
  assert.equal(out.hits[1].date, "1999-12-31");
  assert.equal(out.returned, 2);
  assert.equal(out.truncated, true);
  assert.match(out.truncatedReason, /maxLines=2/);
});

test("changedLines searches generic members, caps members and keeps going after a member error", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("SYSPARTITIONSTAT")) return [{ SYSTEM_TABLE_MEMBER: "ORD_A" }, { SYSTEM_TABLE_MEMBER: "ORDB" }, { SYSTEM_TABLE_MEMBER: "ORDC" }];
      if (sql.includes('("ORDB")')) throw new Error("SQL0204 not found");
      return [{ LINE_NUMBER: 1, SRCSEQ: 1, FULL_DATE: 20250101, SRCDTA: "x" }];
    }
  });
  const out = data(await handleTool(context(conn), "ibmi.search.changedLines", {
    library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORD_*", memberType: "rpgle", from: "2025-01-01", maxMembers: 2
  }));
  const listSql = calls.sql[0];
  assert.match(listSql, /SYSTEM_TABLE_MEMBER like 'ORD\\_%' escape '\\'/);
  assert.match(listSql, /SOURCE_TYPE = 'RPGLE'/);
  assert.match(listSql, /fetch first 3 rows only/);
  assert.deepEqual(out.hits.map(hit => hit.member), ["ORD_A"]);
  assert.equal(out.errors[0].member, "ORDB");
  assert.equal(out.truncated, true);
  assert.match(out.truncatedReason, /maxMembers=2/);
});

test("changedLines validates names and dates before any SQL", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await assert.rejects(handleTool(ctx, "ibmi.search.changedLines", { library: "MY\"LIB", sourceFile: "QRPGLESRC", from: "2025-01-01" }), /Invalid library/);
  await assert.rejects(handleTool(ctx, "ibmi.search.changedLines", { library: "MYLIB", sourceFile: "QRPGLESRC", member: "A'*", from: "2025-01-01" }), /Invalid member filter/);
  await assert.rejects(handleTool(ctx, "ibmi.search.changedLines", { library: "MYLIB", sourceFile: "QRPGLESRC", from: "2025-02-01", to: "2025-01-01" }), /before from/);
  assert.equal(calls.sql.length, 0);
});

// ---- library list tools ----

test("moveLibrary handles positions and directions", () => {
  const list = ["A", "B", "C", "D"];
  assert.deepEqual(moveLibrary(list, "C", { direction: "up" }), ["A", "C", "B", "D"]);
  assert.deepEqual(moveLibrary(list, "A", { direction: "up" }), list);
  assert.deepEqual(moveLibrary(list, "A", { direction: "down", steps: 2 }), ["B", "C", "A", "D"]);
  assert.deepEqual(moveLibrary(list, "D", { direction: "top" }), ["D", "A", "B", "C"]);
  assert.deepEqual(moveLibrary(list, "A", { direction: "bottom" }), ["B", "C", "D", "A"]);
  assert.deepEqual(moveLibrary(list, "D", { position: 2 }), ["A", "D", "B", "C"]);
  assert.deepEqual(moveLibrary(list, "A", { position: 99 }), ["B", "C", "D", "A"]);
  assert.throws(() => moveLibrary(list, "X", { position: 1 }), /not in the library list/);
  assert.throws(() => moveLibrary(list, "A", {}), /either position or direction/);
  assert.throws(() => moveLibrary(list, "A", { position: 1, direction: "up" }), /either position or direction/);
});

test("libl.move stores the new order and applies it to the job on request", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn, { name: "DEV", settings: { libraryList: ["APP", "UTIL", "DATA"], currentLibrary: "APP" } });
  const out = data(await handleTool(ctx, "ibmi.libl.move", { library: "data", direction: "top", applyToJob: true }));
  assert.deepEqual(out.libraryList, ["DATA", "APP", "UTIL"]);
  assert.equal(out.from, 3);
  assert.equal(out.to, 1);
  assert.deepEqual(ctx.saved.connection.settings.libraryList, ["DATA", "APP", "UTIL"]);
  assert.deepEqual(conn.getConfig().libraryList, ["DATA", "APP", "UTIL"]);
  assert.ok(calls.qsh.some(cmd => cmd.includes("CHGLIBL LIBL(DATA APP UTIL)")));
});

test("libl tools respect read-only mode and policy", async () => {
  const { conn } = fakeConn({ config: { readOnlyMode: true } });
  const ctx = context(conn, { name: "DEV", settings: { libraryList: ["APP", "UTIL"] } });
  await assert.rejects(handleTool(ctx, "ibmi.libl.move", { library: "UTIL", direction: "up" }), /read-only/);
  const { conn: conn2 } = fakeConn();
  const guarded = context(conn2, { name: "DEV", settings: { libraryList: ["APP", "UTIL"] } }, { profile: "read-only" });
  await assert.rejects(handleTool(guarded, "ibmi.libl.move", { library: "UTIL", direction: "up" }), /Blocked by policy/);
  assert.deepEqual(guarded.saved.connection.settings.libraryList, ["APP", "UTIL"]);
});

test("libl.prune removes missing libraries, and dryRun only reports", async () => {
  const runSQL = sql => {
    assert.match(sql, /QSYS2\.OBJECT_STATISTICS\('QSYS', '\*LIB'/);
    return [{ OBJNAME: "APP" }, { OBJNAME: "DATA" }];
  };
  const { conn } = fakeConn({ runSQL });
  const ctx = context(conn, { name: "DEV", settings: { libraryList: ["APP", "GONE", "DATA"], currentLibrary: "OLDCUR" } });
  const dry = data(await handleTool(ctx, "ibmi.libl.prune", { dryRun: true }));
  assert.deepEqual(dry.removed, ["GONE"]);
  assert.deepEqual(dry.wouldBecome, ["APP", "DATA"]);
  assert.deepEqual(ctx.saved.connection.settings.libraryList, ["APP", "GONE", "DATA"]);
  assert.match(dry.warning, /OLDCUR does not exist/);

  const done = data(await handleTool(ctx, "ibmi.libl.prune", {}));
  assert.deepEqual(done.libraryList, ["APP", "DATA"]);
  assert.deepEqual(ctx.saved.connection.settings.libraryList, ["APP", "DATA"]);
});

test("libl.prune falls back when *ALLSIMPLE is not supported", async () => {
  const { conn, calls } = fakeConn({
    runSQL: sql => {
      if (sql.includes("*ALLSIMPLE")) throw new Error("SQL0171");
      return [{ OBJNAME: "APP" }];
    }
  });
  const ctx = context(conn, { name: "DEV", settings: { libraryList: ["APP"] } });
  const out = data(await handleTool(ctx, "ibmi.libl.prune", {}));
  assert.deepEqual(out.removed, []);
  assert.equal(calls.sql.length, 2);
});

test("libraryListFromRows keeps the user portion and current library", () => {
  const parsed = libraryListFromRows([
    { SYSTEM_SCHEMA_NAME: "QSYS", TYPE: "SYSTEM" },
    { SYSTEM_SCHEMA_NAME: "MYCUR", TYPE: "CURRENT" },
    { SYSTEM_SCHEMA_NAME: "APP", TYPE: "USER" },
    { SYSTEM_SCHEMA_NAME: "QGPL", TYPE: "USER" }
  ]);
  assert.deepEqual(parsed, { libraryList: ["APP", "QGPL"], currentLibrary: "MYCUR" });
});

test("libl.runProfileCommand runs the profile command and stores the resulting list", async () => {
  const { conn, calls } = fakeConn({
    runSQL: () => [
      { ORDINAL_POSITION: 1, SYSTEM_SCHEMA_NAME: "QSYS", TYPE: "SYSTEM" },
      { ORDINAL_POSITION: 2, SYSTEM_SCHEMA_NAME: "DEVCUR", TYPE: "CURRENT" },
      { ORDINAL_POSITION: 3, SYSTEM_SCHEMA_NAME: "APPLIB", TYPE: "USER" },
      { ORDINAL_POSITION: 4, SYSTEM_SCHEMA_NAME: "QGPL", TYPE: "USER" }
    ]
  });
  const stored = {
    name: "DEV",
    settings: { libraryList: ["OLD"] },
    currentProfile: "dev",
    profiles: [{ name: "dev", setLibraryListCommand: "CALL PGM(MYLIB/SETLIBL) PARM('DEV')" }]
  };
  const ctx = context(conn, stored);
  const out = data(await handleTool(ctx, "ibmi.libl.runProfileCommand", { saveToProfile: true }));
  assert.equal(calls.sql.length, 1);
  assert.match(calls.sql[0], /^CALL QSYS2\.QCMDEXC\('CALL PGM\(MYLIB\/SETLIBL\) PARM\(''DEV''\)'\);\nselect .* from QSYS2\.LIBRARY_LIST_INFO/);
  assert.deepEqual(out.libraryList, ["APPLIB", "QGPL"]);
  assert.equal(out.currentLibrary, "DEVCUR");
  assert.deepEqual(ctx.saved.connection.settings.libraryList, ["APPLIB", "QGPL"]);
  assert.equal(ctx.saved.connection.settings.currentLibrary, "DEVCUR");
  assert.deepEqual(ctx.saved.profiles[0].libraryList, ["APPLIB", "QGPL"]);
});

test("libl.runProfileCommand needs a command and honours CL command policy", async () => {
  const { conn, calls } = fakeConn();
  const noCommand = context(conn, { name: "DEV", settings: {}, currentProfile: "p", profiles: [{ name: "p" }] });
  await assert.rejects(handleTool(noCommand, "ibmi.libl.runProfileCommand", {}), /no setLibraryListCommand/);
  const noProfile = context(conn, { name: "DEV", settings: {}, profiles: [] });
  await assert.rejects(handleTool(noProfile, "ibmi.libl.runProfileCommand", {}), /No active profile/);
  const denied = context(
    conn,
    { name: "DEV", settings: {}, currentProfile: "p", profiles: [{ name: "p", setLibraryListCommand: "CHGLIBL LIBL(A)" }] },
    { profile: "power-user", denyCommands: ["CHGLIBL"] }
  );
  await assert.rejects(handleTool(denied, "ibmi.libl.runProfileCommand", {}), /denyCommands/);
  assert.equal(calls.sql.length, 0);
});
