import test from "node:test";
import assert from "node:assert/strict";
import { getTools, handleTool } from "../dist/mcp/tools.js";
import { assertSafeIfsTargetPath, assertSafeIfsDeletePath } from "../dist/mcp/policy.js";

function fakeConn(overrides = {}) {
  const calls = { sql: [], commands: [], invalidated: [] };
  const conn = {
    currentConnectionName: "DEV",
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
      return overrides.sendCommand ? overrides.sendCommand(options, calls) : { code: 0, stdout: "", stderr: "" };
    },
    content: {
      invalidateMemberSnapshot(library, sourceFile, member) {
        calls.invalidated.push(`${library}/${sourceFile}/${member}`);
      }
    }
  };
  return { conn, calls };
}

function context(conn, policy = { profile: "power-user" }) {
  return { store: {}, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => policy };
}

// CL runs through SQL as CALL QSYS2.QCMDEXC('<command>'), with quotes doubled.
function clCommands(calls) {
  return calls.sql
    .filter(sql => sql.startsWith("CALL QSYS2.QCMDEXC("))
    .map(sql => sql.slice("CALL QSYS2.QCMDEXC('".length, -2).replace(/''/g, "'"));
}

// ---- tool definitions ----

test("object, member and IFS tools are registered with strict schemas and annotations", () => {
  const names = [
    "ibmi.objects.copy", "ibmi.objects.move", "ibmi.objects.rename", "ibmi.objects.delete",
    "ibmi.objects.changeDescription", "ibmi.libraries.copy", "ibmi.qsys.members.copy",
    "ibmi.qsys.members.changeText", "ibmi.qsys.members.changeType", "ibmi.ifs.copy", "ibmi.ifs.move"
  ];
  const tools = getTools();
  for (const name of names) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    assert.ok(tool.inputSchema.properties.connectionName, name);
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.openWorldHint, false, name);
  }
});

// ---- objects ----

test("objects.copy builds CRTDUPOBJ with DATA only for files", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.objects.copy", { library: "devlib", object: "orders", objectType: "*file", toLibrary: "testlib", data: true });
  await handleTool(ctx, "ibmi.objects.copy", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", newObject: "PGMB" });
  assert.deepEqual(clCommands(calls), [
    "CRTDUPOBJ OBJ(ORDERS) FROMLIB(DEVLIB) OBJTYPE(*FILE) TOLIB(TESTLIB) NEWOBJ(ORDERS) DATA(*YES)",
    "CRTDUPOBJ OBJ(PGMA) FROMLIB(DEVLIB) OBJTYPE(*PGM) TOLIB(DEVLIB) NEWOBJ(PGMB)"
  ]);
});

test("objects.copy refuses a copy onto itself, bad names and unsupported types", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await assert.rejects(handleTool(ctx, "ibmi.objects.copy", { library: "DEVLIB", object: "PGMA", objectType: "*PGM" }), /same as the source/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.copy", { library: "DEVLIB", object: "A) DATA(*YES", objectType: "*PGM", newObject: "B" }), /Invalid object/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.copy", { library: "DEVLIB", object: "A", objectType: "*USRPRF", newObject: "B" }), /Unsupported objectType/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.copy", { library: "DEVLIB", object: "A", objectType: "*PGM", toLibrary: "QSYS" }), /system library QSYS/);
  assert.equal(calls.sql.length, 0);
});

test("objects.move, rename and changeDescription build the expected CL", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.objects.move", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", toLibrary: "TESTLIB" });
  await handleTool(ctx, "ibmi.objects.rename", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", newObject: "PGMB" });
  await handleTool(ctx, "ibmi.objects.changeDescription", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", text: "Bob's \"order\" program" });
  await handleTool(ctx, "ibmi.objects.changeDescription", { library: "DEVLIB", object: "PGMA", objectType: "*PGM", text: "" });
  assert.deepEqual(clCommands(calls), [
    "MOVOBJ OBJ(DEVLIB/PGMA) OBJTYPE(*PGM) TOLIB(TESTLIB)",
    "RNMOBJ OBJ(DEVLIB/PGMA) OBJTYPE(*PGM) NEWOBJ(PGMB)",
    "CHGOBJD OBJ(DEVLIB/PGMA) OBJTYPE(*PGM) TEXT('Bob''s \"order\" program')",
    "CHGOBJD OBJ(DEVLIB/PGMA) OBJTYPE(*PGM) TEXT(*BLANK)"
  ]);
  // The SQL literal doubles the CL quotes again.
  assert.match(calls.sql[2], /TEXT\(''Bob''''s "order" program''\)/);
});

test("objects.changeDescription rejects long or multiline text", async () => {
  const { conn } = fakeConn();
  const ctx = context(conn);
  const base = { library: "DEVLIB", object: "PGMA", objectType: "*PGM" };
  await assert.rejects(handleTool(ctx, "ibmi.objects.changeDescription", { ...base, text: "x".repeat(51) }), /at most 50/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.changeDescription", { ...base, text: "a\nb" }), /control characters/);
});

test("objects.move and rename refuse system libraries and no-op targets", async () => {
  const { conn } = fakeConn();
  const ctx = context(conn);
  await assert.rejects(handleTool(ctx, "ibmi.objects.move", { library: "QSYS", object: "A", objectType: "*PGM", toLibrary: "DEVLIB" }), /system library/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.move", { library: "DEVLIB", object: "A", objectType: "*PGM", toLibrary: "QSYS2" }), /system library/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.move", { library: "DEVLIB", object: "A", objectType: "*PGM", toLibrary: "DEVLIB" }), /must differ/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.rename", { library: "QUSRSYS", object: "A", objectType: "*PGM", newObject: "B" }), /system library/);
  await assert.rejects(handleTool(ctx, "ibmi.objects.rename", { library: "DEVLIB", object: "A", objectType: "*PGM", newObject: "a" }), /must differ/);
});

test("objects.delete uses the delete command for the type", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.objects.delete", { library: "DEVLIB", object: "ORDERS", objectType: "*FILE" });
  await handleTool(ctx, "ibmi.objects.delete", { library: "DEVLIB", object: "PGMA", objectType: "*PGM" });
  await handleTool(ctx, "ibmi.objects.delete", { library: "DEVLIB", object: "SVC", objectType: "*SRVPGM" });
  await handleTool(ctx, "ibmi.objects.delete", { library: "DEVLIB", object: "CFG", objectType: "*DTAARA" });
  assert.deepEqual(clCommands(calls), [
    "DLTF FILE(DEVLIB/ORDERS)",
    "DLTPGM PGM(DEVLIB/PGMA)",
    "DLTSRVPGM SRVPGM(DEVLIB/SVC)",
    "DLTDTAARA DTAARA(DEVLIB/CFG)"
  ]);
  await assert.rejects(handleTool(ctx, "ibmi.objects.delete", { library: "QSYS", object: "X", objectType: "*PGM" }), /system library/);
});

test("deleting a library needs approve and the repeated name, and refuses system libraries", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  const noApprove = await handleTool(ctx, "ibmi.objects.delete", { library: "OLDLIB", objectType: "*LIB" });
  assert.equal(noApprove.isError, true);
  const wrongName = await handleTool(ctx, "ibmi.objects.delete", { library: "OLDLIB", objectType: "*LIB", approve: true, confirmName: "OLDLIB2" });
  assert.equal(wrongName.isError, true);
  assert.match(wrongName.content[0].text, /confirmName/);
  for (const lib of ["QSYS", "QSYS2", "QGPL", "QUSRSYS", "QTEMP", "QRECOVERY", "SYSIBM", "#LIBRARY"]) {
    await assert.rejects(
      handleTool(ctx, "ibmi.objects.delete", { library: lib, objectType: "*LIB", approve: true, confirmName: lib }),
      /system library/,
      lib
    );
  }
  assert.equal(calls.sql.length, 0);
  const ok = await handleTool(ctx, "ibmi.objects.delete", { library: "OLDLIB", objectType: "*LIB", approve: true, confirmName: "oldlib" });
  assert.equal(ok.structuredContent.ok, true);
  assert.deepEqual(clCommands(calls), ["DLTLIB LIB(OLDLIB)"]);
});

test("libraries.copy builds CPYLIB and refuses system targets", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.libraries.copy", { fromLibrary: "DEVLIB", toLibrary: "DEVBKP" });
  await handleTool(ctx, "ibmi.libraries.copy", { fromLibrary: "DEVLIB", toLibrary: "DEVBKP", createLibrary: false, data: false });
  assert.deepEqual(clCommands(calls), [
    "CPYLIB FROMLIB(DEVLIB) TOLIB(DEVBKP) CRTLIB(*YES) DATA(*YES)",
    "CPYLIB FROMLIB(DEVLIB) TOLIB(DEVBKP) CRTLIB(*NO) DATA(*NO)"
  ]);
  await assert.rejects(handleTool(ctx, "ibmi.libraries.copy", { fromLibrary: "DEVLIB", toLibrary: "QGPL" }), /system library/);
  await assert.rejects(handleTool(ctx, "ibmi.libraries.copy", { fromLibrary: "DEVLIB", toLibrary: "DEVLIB" }), /must differ/);
});

test("object tools return a tool error when the CL command fails", async () => {
  const { conn } = fakeConn({ runSQL: () => { throw new Error("CPF2105: Object PGMA in DEVLIB type *PGM not found."); } });
  const response = await handleTool(context(conn), "ibmi.objects.delete", { library: "DEVLIB", object: "PGMA", objectType: "*PGM" });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /DLTPGM PGM\(DEVLIB\/PGMA\).*CPF2105/);
});

test("object tools respect read-only mode, policy approval, denyCommands and library policy", async () => {
  const args = { library: "DEVLIB", object: "PGMA", objectType: "*PGM" };
  const readOnly = fakeConn();
  readOnly.conn.readOnlyMode = true;
  await assert.rejects(handleTool(context(readOnly.conn), "ibmi.objects.delete", args), /read-only/);

  const guarded = fakeConn();
  const guardedPolicy = { profile: "guarded", requireApprovalFor: ["qsys.write"] };
  await assert.rejects(handleTool(context(guarded.conn, guardedPolicy), "ibmi.objects.delete", args), /approve=true/);

  const denied = fakeConn();
  await assert.rejects(
    handleTool(context(denied.conn, { profile: "power-user", denyCommands: ["DLT*"] }), "ibmi.objects.delete", args),
    /DLTPGM is in denyCommands/
  );
  await assert.rejects(
    handleTool(context(denied.conn, { profile: "power-user", denyLibraries: ["PROD"] }), "ibmi.objects.move", { ...args, toLibrary: "PROD" }),
    /PROD is in denyLibraries/
  );
  assert.equal(denied.calls.sql.length, 0);
});

// ---- members ----

test("members.copy refuses an existing target unless replace=true", async () => {
  const { conn, calls } = fakeConn({ runSQL: sql => (sql.includes("SYSPARTITIONSTAT") ? [{ SYSTEM_TABLE_MEMBER: "ORDERS" }] : []) });
  const ctx = context(conn);
  const args = { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", toLibrary: "TESTLIB" };
  const refused = await handleTool(ctx, "ibmi.qsys.members.copy", args);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /already exists/);
  assert.deepEqual(clCommands(calls), []);

  await handleTool(ctx, "ibmi.qsys.members.copy", { ...args, replace: true });
  assert.deepEqual(clCommands(calls), [
    "CPYSRCF FROMFILE(DEVLIB/QRPGLESRC) TOFILE(TESTLIB/QRPGLESRC) FROMMBR(ORDERS) TOMBR(ORDERS) MBROPT(*REPLACE)"
  ]);
  assert.deepEqual(calls.invalidated, ["TESTLIB/QRPGLESRC/ORDERS"]);
});

test("members.copy copies to a new member when the target does not exist", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.qsys.members.copy", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", toMember: "ORDERS2" });
  assert.match(calls.sql[0], /SYSTEM_TABLE_SCHEMA = 'DEVLIB' and SYSTEM_TABLE_NAME = 'QRPGLESRC' and SYSTEM_TABLE_MEMBER = 'ORDERS2'/);
  assert.deepEqual(clCommands(calls), [
    "CPYSRCF FROMFILE(DEVLIB/QRPGLESRC) TOFILE(DEVLIB/QRPGLESRC) FROMMBR(ORDERS) TOMBR(ORDERS2) MBROPT(*REPLACE)"
  ]);
  await assert.rejects(
    handleTool(ctx, "ibmi.qsys.members.copy", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS" }),
    /same as the source/
  );
});

test("members.changeText and changeType build CHGPFM and drop the cached snapshot", async () => {
  const { conn, calls } = fakeConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.qsys.members.changeText", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", text: "Order entry" });
  await handleTool(ctx, "ibmi.qsys.members.changeType", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", srctype: "sqlrpgle" });
  assert.deepEqual(clCommands(calls), [
    "CHGPFM FILE(DEVLIB/QRPGLESRC) MBR(ORDERS) TEXT('Order entry')",
    "CHGPFM FILE(DEVLIB/QRPGLESRC) MBR(ORDERS) SRCTYPE(SQLRPGLE)"
  ]);
  assert.deepEqual(calls.invalidated, ["DEVLIB/QRPGLESRC/ORDERS", "DEVLIB/QRPGLESRC/ORDERS"]);
  await assert.rejects(
    handleTool(ctx, "ibmi.qsys.members.changeType", { library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", srctype: "RPG LE" }),
    /Invalid srctype/
  );
});

test("member tools return a tool error when CHGPFM fails and still drop the snapshot", async () => {
  const { conn, calls } = fakeConn({ runSQL: () => { throw new Error("CPF3C27: Member ORDERS not found."); } });
  const response = await handleTool(context(conn), "ibmi.qsys.members.changeText", {
    library: "DEVLIB", sourceFile: "QRPGLESRC", member: "ORDERS", text: "x"
  });
  assert.equal(response.isError, true);
  assert.deepEqual(calls.invalidated, ["DEVLIB/QRPGLESRC/ORDERS"]);
});

// ---- IFS ----

function ifsConn({ exists = false, fail = false } = {}) {
  return fakeConn({
    sendCommand: options => {
      if (options.command.startsWith("test -e ")) return { code: exists ? 0 : 1, stdout: "", stderr: "" };
      return fail ? { code: 1, stdout: "", stderr: "cp: Permission denied" } : { code: 0, stdout: "", stderr: "" };
    }
  });
}

test("ifs.copy and ifs.move quote paths and build cp / mv", async () => {
  const { conn, calls } = ifsConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/home/dev/a file.txt", destinationPath: "/home/dev/it's.txt" });
  await handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/home/dev/src", destinationPath: "/home/dev/src2", recursive: true });
  await handleTool(ctx, "ibmi.ifs.move", { sourcePath: "/home/dev/old.txt", destinationPath: "/home/dev/archive/old.txt" });
  assert.deepEqual(calls.commands, [
    "test -e '/home/dev/it'\"'\"'s.txt'",
    "cp '/home/dev/a file.txt' '/home/dev/it'\"'\"'s.txt'",
    "test -e '/home/dev/src2'",
    "cp -R '/home/dev/src' '/home/dev/src2'",
    "test -e '/home/dev/archive/old.txt'",
    "mv '/home/dev/old.txt' '/home/dev/archive/old.txt'"
  ]);
});

test("ifs.copy reads from system paths but refuses system destinations", async () => {
  const { conn, calls } = ifsConn();
  const ctx = context(conn);
  await handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/QIBM/ProdData/OS/x.txt", destinationPath: "/home/dev/x.txt" });
  assert.equal(calls.commands.at(-1), "cp '/QIBM/ProdData/OS/x.txt' '/home/dev/x.txt'");
  for (const bad of ["/", "/home", "/QSYS.LIB/MYLIB.LIB", "/QOpenSys/usr", "/QIBM/ProdData/x", "/home/dev/../x", "/home/*", "relative"]) {
    await assert.rejects(handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/home/dev/a", destinationPath: bad }), /ifs.copy refused/, bad);
  }
  await assert.rejects(handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/", destinationPath: "/home/dev/root" }), /root/);
  await assert.rejects(handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/home", destinationPath: "/home/dev/x", recursive: true }), /top-level/);
  await assert.rejects(handleTool(ctx, "ibmi.ifs.copy", { sourcePath: "/home/dev", destinationPath: "/home/dev/sub", recursive: true }), /inside sourcePath/);
});

test("ifs.move guards both paths", async () => {
  const { conn, calls } = ifsConn();
  const ctx = context(conn);
  for (const bad of ["/", "/home", "/QSYS.LIB/QGPL.LIB/X.FILE", "/QIBM/ProdData/OS"]) {
    await assert.rejects(handleTool(ctx, "ibmi.ifs.move", { sourcePath: bad, destinationPath: "/home/dev/x" }), /ifs.move refused/, bad);
    await assert.rejects(handleTool(ctx, "ibmi.ifs.move", { sourcePath: "/home/dev/x", destinationPath: bad }), /ifs.move refused/, bad);
  }
  await assert.rejects(handleTool(ctx, "ibmi.ifs.move", { sourcePath: "/home/dev/x", destinationPath: "/home/dev/x/" }), /same/);
  assert.equal(calls.commands.length, 0);
});

test("ifs copy/move refuse an existing destination unless overwrite=true", async () => {
  const { conn, calls } = ifsConn({ exists: true });
  const ctx = context(conn);
  const refused = await handleTool(ctx, "ibmi.ifs.move", { sourcePath: "/home/dev/a", destinationPath: "/home/dev/b" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /already exists/);
  assert.equal(calls.commands.length, 1);
  await handleTool(ctx, "ibmi.ifs.move", { sourcePath: "/home/dev/a", destinationPath: "/home/dev/b", overwrite: true });
  assert.equal(calls.commands.at(-1), "mv '/home/dev/a' '/home/dev/b'");
});

test("ifs copy/move report command failures and respect path policy and the write gate", async () => {
  const failing = ifsConn({ fail: true });
  const response = await handleTool(context(failing.conn), "ibmi.ifs.copy", { sourcePath: "/home/dev/a", destinationPath: "/home/dev/b" });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Permission denied/);

  const policyConn = ifsConn();
  const policy = { profile: "power-user", denyPaths: ["/home/prod"] };
  await assert.rejects(
    handleTool(context(policyConn.conn, policy), "ibmi.ifs.copy", { sourcePath: "/home/prod/a", destinationPath: "/home/dev/a" }),
    /denyPaths/
  );
  await assert.rejects(
    handleTool(context(policyConn.conn, policy), "ibmi.ifs.move", { sourcePath: "/home/dev/a", destinationPath: "/home/prod/a" }),
    /denyPaths/
  );
  const guarded = { profile: "guarded", requireApprovalFor: ["ifs.delete"] };
  await assert.rejects(
    handleTool(context(policyConn.conn, guarded), "ibmi.ifs.move", { sourcePath: "/home/dev/a", destinationPath: "/home/dev/b" }),
    /approve=true/
  );
  policyConn.conn.readOnlyMode = true;
  await assert.rejects(
    handleTool(context(policyConn.conn), "ibmi.ifs.copy", { sourcePath: "/home/dev/a", destinationPath: "/home/dev/b" }),
    /read-only/
  );
  assert.equal(policyConn.calls.commands.length, 0);
});

test("the shared IFS path guard names the operation", () => {
  assert.throws(() => assertSafeIfsTargetPath("/home", "ifs.move", "move"), /ifs.move refused: cannot move top-level directory/);
  assert.throws(() => assertSafeIfsDeletePath("/home"), /ifs.delete refused: cannot delete top-level directory/);
  assert.equal(assertSafeIfsTargetPath("/home/dev/x/", "ifs.copy"), "/home/dev/x");
});
