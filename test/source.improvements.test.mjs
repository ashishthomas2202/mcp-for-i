import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { handleTool } from "../dist/mcp/tools.js";
import { IBMiContent } from "../dist/ibmi/IBMiContent.js";
import { Search } from "../dist/ibmi/Search.js";

function snapshot() {
  const content = [
    "**free",
    "/copy QRPGLESRC,COMMON",
    "dcl-proc CalculateTotal;",
    "  callp Helper();",
    "end-proc;"
  ].join("\n");
  return {
    identity: { library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER" },
    content,
    lines: content.split("\n"),
    metadata: { library: "MYLIB", file: "QRPGLESRC", name: "ORDER", extension: "RPGLE", rowCount: 5 },
    sha256: "abc123",
    version: "2026-09-09:abc123",
    observedAt: "2026-09-09T12:00:00.000Z",
    complete: true,
    transport: "sql-member",
    warnings: [],
    cacheStatus: "miss"
  };
}

function context(content) {
  const conn = {
    currentConnectionName: "DEV",
    currentHost: "dev.example.com",
    currentUser: "DEVUSER",
    defaultUserLibraries: ["MYLIB"],
    remoteFeatures: { grep: "/usr/bin/grep" },
    getConfig: () => ({ currentLibrary: "MYLIB", libraryList: ["MYLIB"], readOnlyMode: false }),
    content
  };
  return {
    store: {},
    activeName: "DEV",
    ensureActive: async () => conn,
    getPolicy: () => ({ profile: "power-user" })
  };
}

function data(result) {
  return result.structuredContent.data;
}

test("legacy member reads stay text while structured reads add ranges and versions", async () => {
  const snap = snapshot();
  const ctx = context({
    downloadMemberContent: async () => snap.content,
    getMemberSnapshot: async () => snap
  });

  const legacy = await handleTool(ctx, "ibmi.qsys.members.read", {
    library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER"
  });
  assert.equal(legacy.content[0].text, snap.content);

  const structured = await handleTool(ctx, "ibmi.qsys.members.read", {
    library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER",
    responseFormat: "structured", startLine: 3, endLine: 3, before: 1, after: 1
  });
  assert.equal(data(structured).version, snap.version);
  assert.deepEqual(data(structured).ranges[0].lines.map(line => line.number), [2, 3, 4]);
});

test("legacy member lists stay arrays while filters opt into bounded pages", async () => {
  let legacyCalls = 0;
  let pageCalls = 0;
  const ctx = context({
    getMemberList: async () => { legacyCalls++; return [{ name: "ORDER" }]; },
    getMemberListPage: async options => {
      pageCalls++;
      return { items: [{ name: options.member }], returned: 1, hasMore: false };
    }
  });
  const legacy = await handleTool(ctx, "ibmi.qsys.members.list", { library: "MYLIB", sourceFile: "QRPGLESRC" });
  const filtered = await handleTool(ctx, "ibmi.qsys.members.list", {
    library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER", responseFormat: "page"
  });
  assert.deepEqual(data(legacy), [{ name: "ORDER" }]);
  assert.equal(data(filtered).items[0].name, "ORDER");
  assert.equal(legacyCalls, 1);
  assert.equal(pageCalls, 1);
});

test("member write rejects a stale expected version before modifying source", async () => {
  let writes = 0;
  const ctx = context({
    getMemberSnapshot: async () => snapshot(),
    uploadMemberContent: async () => { writes++; }
  });
  const response = await handleTool(ctx, "ibmi.qsys.members.write", {
    connectionName: "DEV", library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER",
    content: "changed", expectedVersion: "stale"
  });
  assert.equal(data(response).status, "version-conflict");
  assert.equal(data(response).modified, false);
  assert.equal(writes, 0);
});

test("source inspect batches search, ranges, outline, and dependencies over one snapshot", async () => {
  let reads = 0;
  const ctx = context({
    getMemberSnapshot: async () => { reads++; return snapshot(); }
  });
  const response = await handleTool(ctx, "ibmi.source.inspect", {
    connectionName: "DEV", library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER",
    operations: [
      { operation: "search", terms: ["Helper"], before: 1 },
      { operation: "read_ranges", ranges: [{ start: 3, end: 4 }] },
      { operation: "outline" },
      { operation: "dependencies" }
    ]
  });
  const inspected = data(response);
  assert.equal(reads, 1);
  assert.equal(inspected.results[0].matches[0].line, 4);
  assert.equal(inspected.results[2].symbols[0].name, "CalculateTotal");
  assert.ok(inspected.results[3].dependencies.some(dep => dep.name.includes("COMMON")));
});

test("member read uses a complete CPYTOSTMF fallback when direct SQL fails", async () => {
  const fakeClient = {
    getConfig: () => ({ enableSourceDates: true, sourceFileCCSID: "*FILE" }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: value => /^[A-Z][A-Z0-9]{0,9}$/.test(value),
    runSQL: async () => { throw new Error("MCP_TEMP in ILEDITOR type *FILE not found. (42704)"); },
    getTempRemote: () => "/tmp/member_test",
    sendQsh: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    client: { getFile: async destination => fs.writeFile(destination, "line one\nCTDATA") }
  };
  const result = await new IBMiContent(fakeClient).downloadMemberContentDetailed("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(result.content, "line one\nCTDATA");
  assert.equal(result.transport, "cpytostmf");
  assert.match(result.warnings[0], /42704/);
});

test("source-date reads create and consume a QTEMP alias in one SQL job", async () => {
  const statements = [];
  const fakeClient = {
    getConfig: () => ({ enableSourceDates: true, sourceFileCCSID: "*FILE" }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: value => /^[A-Z][A-Z0-9]{0,9}$/.test(value),
    runSQL: async sql => {
      statements.push(sql);
      return [
        { SRCDAT: 260909, SRCSEQ: 1, SRCDTA: "first", SYSTEM_TABLE_MEMBER: "ORDER", SOURCE_TYPE: "RPGLE", ROW_LENGTH: 112 },
        { SRCDAT: 260909, SRCSEQ: 2, SRCDTA: "second", SYSTEM_TABLE_MEMBER: "ORDER", SOURCE_TYPE: "RPGLE", ROW_LENGTH: 112 }
      ];
    }
  };
  const result = await new IBMiContent(fakeClient).downloadMemberContentDetailed("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(result.content, "first\nsecond");
  assert.equal(result.transport, "sql-member");
  assert.equal(statements.length, 1);
  assert.match(statements[0], /create alias QTEMP\."MCP_/i);
  assert.match(statements[0], /from QTEMP\."MCP_.*" as M cross join/i);
  assert.match(statements[0], /order by rrn\(M\)/i);
  assert.equal(statements.some(sql => /ILEDITOR/i.test(sql)), false);
});

test("multi-term member search uses one command and parses requested context", async () => {
  let invocation;
  const client = {
    validQsysName: () => true,
    remoteFeatures: { grep: "/usr/bin/grep" },
    sendCommand: async options => {
      invocation = options;
      return {
        code: 0,
        stderr: "",
        stdout: "ORDER.MBR-2-before\nORDER.MBR:3:MATCH\nORDER.MBR-4-after\n"
      };
    }
  };
  const response = await Search.searchMembersTerms(
    client, "MYLIB", "QRPGLESRC", ["MATCH", "OTHER"], "ORDER", false,
    { caseSensitive: true, before: 1, after: 1 }
  );
  assert.equal(invocation.stdin, "MATCH\nOTHER");
  assert.match(invocation.command, /-nHR/);
  assert.match(invocation.command, /-B 1 -A 1/);
  assert.deepEqual(response.hits[0].lines.map(line => line.number), [2, 3, 4]);
});

test("identical snapshot reads are coalesced and then served from the bounded cache", async () => {
  let sqlCalls = 0;
  const fakeClient = {
    getConfig: () => ({ enableSourceDates: true }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: value => /^[A-Z][A-Z0-9]{0,9}$/.test(value),
    runSQL: async () => {
      sqlCalls++;
      await Promise.resolve();
      return [{
        SRCDAT: 260909, SRCSEQ: 1, SRCDTA: "source", SYSTEM_TABLE_MEMBER: "ORDER",
        SOURCE_TYPE: "RPGLE", NUMBER_ROWS: 1, LAST_SOURCE_UPDATE_TIMESTAMP: "2026-09-09-12.00.00", ROW_LENGTH: 112
      }];
    }
  };
  const content = new IBMiContent(fakeClient);
  const [first, second] = await Promise.all([
    content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER"),
    content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER")
  ]);
  const third = await content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(sqlCalls, 1);
  assert.equal(first.sha256, second.sha256);
  assert.equal(second.cacheStatus, "coalesced");
  assert.equal(third.cacheStatus, "hit");
});
