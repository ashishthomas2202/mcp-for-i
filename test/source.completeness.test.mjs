import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { IBMiContent } from "../dist/ibmi/IBMiContent.js";
import { PersistentSqlJob, wrapMapepireJob } from "../dist/ibmi/sqlJob.js";
import { handleTool } from "../dist/mcp/tools.js";

const member = { library: "RICHARD", sourceFile: "QRPGLESRC", member: "F.CARD" };
function sourceFixture(count, actual = count) {
  let fetches = 0;
  const metadata = { SYSTEM_TABLE_MEMBER: "F.CARD", SOURCE_TYPE: "RPGLE", NUMBER_ROWS: count,
    ROW_LENGTH: 112, LAST_SOURCE_UPDATE_TIMESTAMP: "2026-11-14-12.00.00" };
  const job = { getStatus: () => "ready", async close() {}, query(sql) {
    let offset = 0;
    const fetch = async (size) => {
      fetches++;
      const initial = offset === 0;
      const length = Math.min(size, actual - offset);
      const data = Array.from({ length }, (_, n) => ({ ...metadata,
        SRCDAT: 261114, SRCSEQ: offset + n + 1, SRCDTA: "source line " + (offset + n + 1) }));
      offset += length;
      return { success: true, sql_state: "00000", ...(initial ? { has_results: true } : {}), is_done: length < size, data };
    };
    return { execute: async (size) => /create or replace alias/i.test(sql)
      ? { success: true, has_results: false, is_done: true, data: [] }
      : /SRCDAT/i.test(sql) ? fetch(size)
      : { success: true, has_results: true, is_done: true, data: [metadata] },
      fetchMore: fetch, async close() {} };
  } };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  const persistent = new PersistentSqlJob({ getConfig: () => ({ sqlTransport: "mapepire" }),
    getOpenRequest: () => ({}), factory: async () => handle });
  const client = { getConfig: () => ({ enableSourceDates: true }),
    upperCaseName: (v) => v.toUpperCase(), validQsysName: () => true,
    runSQL: (sql) => persistent.runSql(sql) };
  const content = new IBMiContent(client);
  const context = { store: {}, activeName: "DEV", ensureActive: async () => ({ content, getConfig: () => ({}) }),
    getPolicy: () => ({ profile: "power-user" }) };
  return { content, context, persistent, get fetches() { return fetches; }, metadata };
}

for (const count of [2020, 2021]) {
  test("shared SQL adapter and full source tool return all " + count + " records", async () => {
    const fixture = sourceFixture(count);
    const result = await handleTool(fixture.context, "ibmi.qsys.members.read", { ...member, responseFormat: "structured" });
    const data = result.structuredContent.data;
    assert.equal(data.lineCount, count);
    assert.equal(data.metadata.rowCount, count);
    assert.equal(data.complete, true);
    assert.notEqual(data.truncated, true);
    const snapshot = await fixture.content.getMemberSnapshot("RICHARD", "QRPGLESRC", "F.CARD");
    assert.equal(snapshot.lines[count - 1], "source line " + count);
    assert.equal(snapshot.sha256, crypto.createHash("sha256").update(snapshot.content).digest("hex"));
    const tail = await handleTool(fixture.context, "ibmi.qsys.members.read", { ...member, startLine: 2001, responseFormat: "structured" });
    assert.equal(tail.structuredContent.data.ranges[0].lines.length, count - 2000);
    assert.equal(fixture.fetches, 3);
    await fixture.persistent.close();
  });
}

test("short SQL and short fallback fail before snapshot is cached", async () => {
  const fixture = sourceFixture(2020, 2000);
  fixture.content.downloadMemberContentViaStreamFile = async () => Array.from({ length: 2000 }, () => "x").join("\n") + "\n";
  await assert.rejects(fixture.content.getMemberSnapshot("RICHARD", "QRPGLESRC", "F.CARD"), /Incomplete source member stream read: expected 2020 records, received 2000/);
  assert.equal(fixture.content.snapshotCache.size, 0);
  await fixture.persistent.close();
});

test("short SQL can use a complete verified fallback with warning", async () => {
  const fixture = sourceFixture(2020, 2000);
  fixture.content.downloadMemberContentViaStreamFile = async () => Array.from({ length: 2020 }, (_, n) => "line " + (n + 1)).join("\n") + "\n";
  const snapshot = await fixture.content.getMemberSnapshot("RICHARD", "QRPGLESRC", "F.CARD");
  assert.equal(snapshot.lines.length, 2020);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.transport, "cpytostmf");
  assert.match(snapshot.warnings[0], /expected 2020 records, received 2000/);
  await fixture.persistent.close();
});


test("single blank source records remain a complete one-record snapshot", async () => {
  const fixture = sourceFixture(1, 0);
  fixture.content.downloadMemberContentViaStreamFile = async () => String.fromCharCode(10);
  const snapshot = await fixture.content.getMemberSnapshot("RICHARD", "QRPGLESRC", "F.CARD");
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0], "");
  assert.equal(snapshot.metadata.rowCount, 1);
  await fixture.persistent.close();
});


for (const invalid of [undefined, null, "", false, "bad", -1]) {
  test("invalid source record count fails clearly: " + String(invalid), async () => {
    const fixture = sourceFixture(0, 0);
    fixture.metadata.NUMBER_ROWS = invalid;
    fixture.content.downloadMemberContentViaStreamFile = async () => "";
    await assert.rejects(fixture.content.getMemberSnapshot("RICHARD", "QRPGLESRC", "F.CARD"), /completeness cannot be proven: invalid record count/);
    assert.equal(fixture.content.snapshotCache.size, 0);
    await fixture.persistent.close();
  });
}
