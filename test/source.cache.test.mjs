import test from "node:test";
import assert from "node:assert/strict";
import { handleTool } from "../dist/mcp/tools.js";
import { IBMiContent, normalizeMemberContent } from "../dist/ibmi/IBMiContent.js";

function memberRow(text, stamp, extra = {}) {
  return {
    SRCDAT: 260909, SRCSEQ: 1, SRCDTA: text, SYSTEM_TABLE_MEMBER: "ORDER", SOURCE_TYPE: "RPGLE",
    NUMBER_ROWS: 1, LAST_SOURCE_UPDATE_TIMESTAMP: stamp, ROW_LENGTH: 112, ...extra
  };
}

function fakeClient(state) {
  return {
    getConfig: () => ({ enableSourceDates: true }),
    upperCaseName: value => String(value).toUpperCase(),
    validQsysName: value => /^[A-Z][A-Z0-9]{0,9}$/.test(value),
    runSQL: async sql => {
      if (/create alias/i.test(sql)) {
        state.loads++;
        if (state.beforeLoad) await state.beforeLoad();
        return [memberRow(state.text, state.stamp)];
      }
      state.metadataChecks++;
      return [memberRow("", state.stamp)];
    }
  };
}

function lines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function snapshotOf(sourceLines, extra = {}) {
  const content = sourceLines.join("\n");
  return {
    identity: { library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER" },
    content,
    lines: sourceLines,
    metadata: { library: "MYLIB", file: "QRPGLESRC", name: "ORDER", extension: "RPGLE", rowCount: sourceLines.length, lastChanged: "2026-09-09-12.00.00" },
    sha256: "f".repeat(64),
    version: "2026-09-09-12.00.00:ffffffffffffffff",
    observedAt: "2026-09-09T12:00:00.000Z",
    complete: true,
    transport: "sql-member",
    warnings: [],
    cacheStatus: "miss",
    ...extra
  };
}

function context(content, config = {}) {
  const conn = {
    currentConnectionName: "DEV",
    remoteFeatures: {},
    getConfig: () => ({ readOnlyMode: false, ...config }),
    content
  };
  return { store: {}, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => ({ profile: "power-user" }) };
}

const MEMBER = { library: "MYLIB", sourceFile: "QRPGLESRC", member: "ORDER" };

test("a cache hit re-checks the change marker and reloads after an outside edit", async () => {
  const state = { loads: 0, metadataChecks: 0, text: "old", stamp: "2026-09-09-12.00.00" };
  const content = new IBMiContent(fakeClient(state));
  const first = await content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  const hit = await content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(hit.cacheStatus, "hit");
  assert.ok(hit.validatedAt);
  assert.equal(state.loads, 1);

  state.text = "new";
  state.stamp = "2026-09-09-12.00.05";
  const reloaded = await content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(reloaded.cacheStatus, "miss");
  assert.equal(reloaded.content, "new");
  assert.notEqual(reloaded.version, first.version);
  assert.equal(state.loads, 2);
});

test("a load in flight during an invalidation does not re-cache stale content", async () => {
  let release;
  const state = {
    loads: 0, metadataChecks: 0, text: "before write", stamp: "2026-09-09-12.00.00",
    beforeLoad: () => new Promise(resolve => { release = resolve; })
  };
  const content = new IBMiContent(fakeClient(state));
  const pending = content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  await new Promise(resolve => setImmediate(resolve));
  content.invalidateMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  release();
  await pending;

  state.beforeLoad = undefined;
  state.text = "after write";
  const next = await content.getMemberSnapshot("MYLIB", "QRPGLESRC", "ORDER");
  assert.equal(next.cacheStatus, "miss");
  assert.equal(next.content, "after write");
  assert.equal(state.loads, 2);
});

test("cache eviction also forgets the latest-version pointer", async () => {
  const state = { loads: 0, metadataChecks: 0, text: "x", stamp: "2026-09-09-12.00.00" };
  const content = new IBMiContent(fakeClient(state));
  for (let index = 0; index < 40; index++) {
    await content.getMemberSnapshot("MYLIB", "QRPGLESRC", `M${index}`);
  }
  assert.ok(content.snapshotCache.size <= 32);
  assert.equal(content.snapshotLatestKey.size, content.snapshotCache.size);
});

test("both read transports normalize to the same content and hash input", () => {
  const sql = normalizeMemberContent("     H DFTACTGRP(*NO)      \n     C                   RETURN    \n      ", "sql-member");
  const stmf = normalizeMemberContent("     H DFTACTGRP(*NO)\r\n     C                   RETURN\r\n\r\n", "cpytostmf");
  assert.equal(sql.content, stmf.content);
  assert.deepEqual(sql.lines, ["     H DFTACTGRP(*NO)", "     C                   RETURN", ""]);
  assert.deepEqual(normalizeMemberContent("", "cpytostmf").lines, []);
});

test("startLine without endLine reads to the end; ranges past the end are empty", async () => {
  const snap = snapshotOf(lines(10));
  const ctx = context({ getMemberSnapshot: async () => snap });
  const toEnd = (await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, startLine: 8 })).structuredContent.data;
  assert.deepEqual(toEnd.ranges[0].lines.map(line => line.number), [8, 9, 10]);

  const past = (await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, startLine: 20, endLine: 25 })).structuredContent.data;
  assert.deepEqual(past.ranges, []);
  assert.match(past.warnings.join(" "), /past the end/);

  const clamped = (await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, ranges: [{ start: 9, end: 50 }] })).structuredContent.data;
  assert.equal(clamped.ranges[0].start, 9);
  assert.equal(clamped.ranges[0].end, 10);
  assert.ok(clamped.ranges.every(range => range.end >= range.start));
});

test("range responses are capped at 2,000 lines with a continuation line", async () => {
  const ctx = context({ getMemberSnapshot: async () => snapshotOf(lines(2_500)) });
  const response = (await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, startLine: 1 })).structuredContent.data;
  assert.equal(response.ranges[0].end, 2_000);
  assert.equal(response.truncated, true);
  assert.equal(response.nextLine, 2_001);
});

test("full reads above the configured size fail with SOURCE_TOO_LARGE", async () => {
  let snapshotReads = 0;
  const big = snapshotOf(lines(30));
  const ctx = context({
    getMemberMetadata: async () => big.metadata,
    getMemberSnapshot: async () => { snapshotReads++; return big; },
    downloadMemberContent: async () => big.content
  }, { sourceReadMaxLines: 20 });

  const structured = await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, responseFormat: "structured" });
  assert.equal(structured.isError, true);
  assert.equal(structured.structuredContent.error.code, "SOURCE_TOO_LARGE");
  assert.match(structured.content[0].text, /startLine\/endLine/);
  assert.equal(snapshotReads, 0, "the row count rejects the read before any download");

  const legacy = await handleTool(ctx, "ibmi.qsys.members.read", MEMBER);
  assert.equal(legacy.isError, true);

  const ranged = await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, startLine: 1, endLine: 5 });
  assert.equal(ranged.isError, undefined);

  const byBytes = context({ getMemberSnapshot: async () => big }, { sourceReadMaxBytes: 50 });
  const bytesResponse = await handleTool(byBytes, "ibmi.qsys.members.read", { ...MEMBER, responseFormat: "structured" });
  assert.equal(bytesResponse.structuredContent.error.code, "SOURCE_TOO_LARGE");
  assert.equal(bytesResponse.structuredContent.error.version, big.version);
});

test("metadataOnly reads do not download member content", async () => {
  let snapshotReads = 0;
  const ctx = context({
    getMemberSnapshot: async () => { snapshotReads++; return snapshotOf(lines(3)); },
    getMemberVersionInfo: async () => ({ metadata: { rowCount: 3, lastChanged: "2026-09-09-12.00.00" }, observedAt: "now" })
  });
  const response = (await handleTool(ctx, "ibmi.qsys.members.read", { ...MEMBER, metadataOnly: true })).structuredContent.data;
  assert.equal(snapshotReads, 0);
  assert.equal(response.contentLoaded, false);
  assert.equal(response.changeMarker, "2026-09-09-12.00.00");
  assert.equal(response.sha256, undefined);
});

test("successful writes return the new version so edits can be chained", async () => {
  let current = snapshotOf(["old"]);
  const ctx = context({
    getMemberSnapshot: async () => current,
    uploadMemberContent: async (_lib, _file, _mbr, text) => {
      current = snapshotOf([text], { sha256: "a".repeat(64), version: "2026-09-09-12.00.09:aaaaaaaaaaaaaaaa" });
    }
  });
  const checked = await handleTool(ctx, "ibmi.qsys.members.write", {
    ...MEMBER, content: "new", expectedVersion: current.version
  });
  assert.equal(checked.isError, undefined);
  const body = checked.structuredContent.data;
  assert.equal(body.status, "written");
  assert.equal(body.version, "2026-09-09-12.00.09:aaaaaaaaaaaaaaaa");
  assert.equal(body.previousVersion, "2026-09-09-12.00.00:ffffffffffffffff");

  const legacy = await handleTool(ctx, "ibmi.qsys.members.write", { ...MEMBER, content: "again" });
  assert.equal(legacy.content[0].text, "OK");
  assert.equal(legacy.structuredContent.data.sha256, "a".repeat(64));

  const conflict = await handleTool(ctx, "ibmi.qsys.members.write", { ...MEMBER, content: "x", expectedSha256: "stale" });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, "VERSION_CONFLICT");
  assert.equal(conflict.structuredContent.error.currentSha256, "a".repeat(64));
});
