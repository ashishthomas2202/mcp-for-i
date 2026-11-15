import test from "node:test";
import assert from "node:assert/strict";
import sdk from "@ibm/mapepire-js";
import { wrapMapepireJob, PersistentSqlJob } from "../dist/ibmi/sqlJob.js";
import { IBMiClient } from "../dist/ibmi/client.js";
import { Tools } from "../dist/ibmi/Tools.js";
import { McpContext } from "../dist/mcp/context.js";
import { handleTool } from "../dist/mcp/tools.js";

function fixture(count, mutate = (page) => page) {
  let offset = 0;
  let calls = 0;
  let closes = 0;
  const sizes = [];
  const fetch = async (size) => {
    sizes.push(size);
    const initial = calls++ === 0;
    const length = Math.min(size, count - offset);
    const data = Array.from({ length }, (_, n) => ({ N: offset + n }));
    offset += length;
    return mutate({ success: true, sql_state: "00000", sql_rc: 0,
      ...(initial ? { has_results: true, metadata: { columns: [{ name: "N", type: "INTEGER" }] } } : {}),
      // Full last batches intentionally require an empty terminal fetch.
      is_done: length < size, data }, calls);
  };
  const job = { query() { return { execute: fetch, fetchMore: fetch,
    async close() { closes++; } }; }, getStatus() { return "ready"; } };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  return { handle, sizes, get closes() { return closes; }, get offset() { return offset; } };
}

for (const count of [0, 1999, 2000, 2001, 3847, 5000, 5001, 20000, 20001, 22000]) {
  test("actual adapter fetches bounded complete protocol: " + count, async () => {
    const f = fixture(count);
    const result = await f.handle.runBounded("select N from T", { rowLimit: 20001 });
    assert.equal(result.rows.length, Math.min(count, 20001));
    assert.deepEqual(result.rows.map((row) => row.N), Array.from({ length: Math.min(count, 20001) }, (_, n) => n));
    assert.equal(result.exhausted, count < 20001);
    assert.equal(result.knownRemaining, count >= 20001);
    assert.equal(f.offset, Math.min(count, 20001));
    assert.equal(f.closes, 1);
    assert.ok(f.sizes.every((size) => size <= 1000));
  });
}

for (const [label, mutate] of [
  ["unknown completion", (p) => { delete p.is_done; return p; }],
  ["later failure", (p, n) => n === 3 ? { ...p, success: false } : p],
  ["warning", (p) => ({ ...p, sql_state: "01004" })],
  ["malformed data", (p) => ({ ...p, data: null })],
  ["oversized page", (p) => ({ ...p, data: [...p.data, { N: -1 }] })],
  ["empty continuation", (p) => ({ ...p, data: [], is_done: false })],
]) {
  test("rejects " + label + " and closes", async () => {
    const f = fixture(5001, mutate);
    await assert.rejects(f.handle.runBounded("select N from T", { rowLimit: 5001 }));
    assert.equal(f.closes, 1);
  });
}

test("abort waits for actual SDK execute then closes the late cursor", async () => {
  const job = new sdk.SQLJob();
  const sent = [];
  let complete;
  job.send = async (request) => {
    sent.push(request);
    if (request.type === "sql") return new Promise((resolve) => { complete = resolve; });
    return { success: true };
  };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  const controller = new AbortController();
  let settled = false;
  const result = handle.runBounded("select N from T", { rowLimit: 5001, signal: controller.signal });
  result.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(sent.map((request) => request.type), ["sql"]);
  complete({ success: true, id: "late-cursor", has_results: true, is_done: false, data: [{ N: 1 }] });
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(sent.map((request) => request.type), ["sql", "sqlclose"]);
  assert.equal(sent[1].cont_id, "late-cursor");
});

test("actual SDK resolved sqlclose failure rejects instead of returning rows", async () => {
  const job = new sdk.SQLJob();
  const sent = [];
  job.send = async (request) => {
    sent.push(request.type);
    if (request.type === "sql") return { success: true, id: "cursor", has_results: true, is_done: false, data: [{ N: 1 }] };
    return { success: false, sql_state: "HY000", sql_rc: -1, error: "close failed" };
  };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  await assert.rejects(handle.runBounded("select N from T", { rowLimit: 1 }), /cleanup failed/);
  assert.deepEqual(sent, ["sql", "sqlclose"]);
});


test("QZDFMDB2 proves completion through bounded footer adapter", async () => {
  const client = new IBMiClient({ name: "test", host: "test", username: "test", sqlTransport: "qzdfmdb2" });
  let calls = 0;
  client.resolveFallbackLibraryList = async () => undefined;
  client.sendCommand = async (options) => {
    calls++;
    assert.match(options.stdin, /FETCH FIRST 5001 ROWS ONLY/i);
    return { code: 0, signal: null, stdout: "N\n---\n  1\n\n  1 RECORD(S) SELECTED.", stderr: "" };
  };
  const result = await client.querySQL("select N from T", { rowLimit: 5001 });
  assert.equal(result.completenessProof.reportedRowCount, 1);
  assert.equal(calls, 1);
});

test("MCP pages preserve completeness totals without duplicate or missing rows", async () => {
  const f = fixture(5001);
  const context = Object.create(McpContext.prototype);
  context.cursors = new Map();
  context.cursorTtlMs = 60000;
  context.ensureActive = async () => ({ querySQL: (sql, options) => f.handle.runBounded(sql, options) });
  const parse = (response) => JSON.parse(response.content[0].text);
  let response = parse(await handleTool(context, "ibmi.sql.query", { sql: "select N from T", pageSize: 700, maxRows: 5000 }));
  const all = [...response.rows];
  assert.equal(response.totalRows, 5000);
  assert.equal(response.truncated, true);
  while (response.cursor) {
    response = parse(await handleTool(context, "ibmi.sql.query", { cursor: response.cursor, pageSize: 700 }));
    assert.equal(response.totalRows, 5000);
    assert.equal(response.truncated, true);
    assert.ok(response.truncationNote);
    all.push(...response.rows);
  }
  assert.deepEqual(all.map((row) => row.N), Array.from({ length: 5000 }, (_, n) => n));
});


for (const sql of ["select N from T fetch first 100000 rows only", "select N from T with ur"]) {
  test("transport bounds query when SQL rewrite is skipped: " + sql, async () => {
    const f = fixture(22000);
    const context = Object.create(McpContext.prototype);
    context.cursors = new Map();
    context.cursorTtlMs = 60000;
    context.ensureActive = async () => ({ querySQL: (text, options) => f.handle.runBounded(text, options) });
    const result = await handleTool(context, "ibmi.sql.query", {
      sql, maxRows: 5000, pageSize: 5000, includeMetadata: true,
    });
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.metadata.rowCapAppliedInSql, false);
    assert.equal(response.rows.length, 5000);
    assert.equal(response.truncated, true);
    assert.equal(f.offset, 5001);
    assert.equal(f.closes, 1);
  });
}

test("MCP rejects unknown completion instead of returning successful partial rows", async () => {
  const f = fixture(3847, (page, n) => {
    if (n === 3) delete page.is_done;
    return page;
  });
  const context = { ensureActive: async () => ({ querySQL: (sql, options) => f.handle.runBounded(sql, options) }) };
  await assert.rejects(handleTool(context, "ibmi.sql.query", { sql: "select N from T", maxRows: 5000 }), /completeness/);
  assert.equal(f.closes, 1);
});


test("a statement the database rejects comes back in its own words, with its SQLSTATE", async () => {
  let closes = 0;
  const job = { query() { return {
    async execute() { throw new Error("[SQL0206] Column or global variable NOPE not found., 42703, -206"); },
    async close() { closes++; },
  }; } };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  await assert.rejects(handle.runBounded("select NOPE from T", { rowLimit: 5001 }), (error) => {
    assert.ok(error instanceof Tools.SqlError);
    assert.equal(error.sqlstate, "42703");
    assert.equal(error.message, "[SQL0206] Column or global variable NOPE not found. (42703)");
    return true;
  });
  assert.equal(closes, 1);
});

test("a transport failure says what failed and is not taken for an SQL error", async () => {
  let closes = 0;
  const job = { query() { return {
    async execute() { throw new Error("socket hang up"); },
    async close() { closes++; },
  }; } };
  const handle = wrapMapepireJob(job, "daemon", () => true);
  await assert.rejects(handle.runBounded("select 1 from T", { rowLimit: 5001 }), (error) => {
    assert.equal(error instanceof Tools.SqlError, false);
    assert.match(error.message, /failed before result completeness was proven: socket hang up/);
    return true;
  });
  assert.equal(closes, 1);
});

test("a rejected statement keeps the SQL job; a transport failure or a cancel discards it", async () => {
  let opens = 0;
  const events = [];
  const persistent = new PersistentSqlJob({
    getConfig: () => ({ sqlTransport: "mapepire" }), getOpenRequest: () => ({}),
    cancelStatement: async () => { events.push("cancel"); },
    factory: async () => {
      const id = ++opens;
      return {
        mode: "daemon", jobName: "123456/QUSER/QZDASOINIT", alive: true,
        isAlive() { return this.alive; },
        async close() { events.push("discard " + id); this.alive = false; },
        async runBounded(sql) {
          events.push(id + ": " + sql);
          if (sql.includes("NOPE")) {
            const error = new Tools.SqlError("[SQL0206] Column or global variable NOPE not found. (42703)");
            error.sqlstate = "42703";
            throw error;
          }
          if (sql.includes("BROKEN")) throw new Error("SQL transport failed before result completeness was proven: socket hang up");
          return { rows: [{ N: 1 }], exhausted: true, knownRemaining: false, effectiveLimit: 1, transport: "mapepire" };
        },
      };
    },
  });
  await persistent.query("select 1 from T", { rowLimit: 1 });
  await assert.rejects(persistent.query("select NOPE from T", { rowLimit: 1 }), /SQL0206/);
  await persistent.query("select 2 from T", { rowLimit: 1 });
  // The typo did not cost the job: QTEMP and session settings are still there.
  assert.equal(opens, 1);
  assert.equal(events.some((event) => event.startsWith("discard")), false);

  await assert.rejects(persistent.query("select BROKEN from T", { rowLimit: 1 }), /socket hang up/);
  assert.deepEqual(events.filter((event) => event.startsWith("discard")), ["discard 1"]);
  await persistent.query("select 3 from T", { rowLimit: 1 });
  assert.equal(opens, 2);

  // An SQL error that arrives because the statement was cancelled still discards the job.
  const controller = new AbortController();
  controller.abort();
  const cancelled = persistent.query("select NOPE from T", { rowLimit: 1, signal: controller.signal });
  await assert.rejects(cancelled);
  await persistent.close();
});


test("strict query holds its queue until delayed CANCEL_SQL settles", async () => {
  let settleFirst;
  let finishCancel;
  const events = [];
  const handle = {
    mode: "daemon", jobName: "123456/QUSER/QZDASOINIT", alive: true,
    isAlive() { return this.alive; },
    async close() { events.push("discard"); this.alive = false; },
    runBounded(sql) {
      events.push(sql);
      if (sql.includes("FIRST")) return new Promise((resolve) => { settleFirst = resolve; });
      return Promise.resolve({ rows: [], exhausted: true, knownRemaining: false, effectiveLimit: 1, transport: "mapepire" });
    },
  };
  const persistent = new PersistentSqlJob({
    getConfig: () => ({ sqlTransport: "mapepire" }), getOpenRequest: () => ({}),
    factory: async () => { handle.alive = true; return handle; },
    cancelStatement: async () => { events.push("cancel-start"); await new Promise((resolve) => { finishCancel = resolve; }); events.push("cancel-end"); },
  });
  const controller = new AbortController();
  const first = persistent.query("select FIRST from T", { rowLimit: 1, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const second = persistent.query("select SECOND from T", { rowLimit: 1 });
  settleFirst({ rows: [], exhausted: true, knownRemaining: false, effectiveLimit: 1, transport: "mapepire" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("select SECOND from T"), false);
  finishCancel();
  await assert.rejects(first, /cancelled/);
  await second;
  assert.ok(events.indexOf("cancel-end") < events.indexOf("select SECOND from T"));
  await persistent.close();
});


test("strict query failed CANCEL_SQL escalates to discard then reopens", async () => {
  let opens = 0;
  let closes = 0;
  const persistent = new PersistentSqlJob({
    getConfig: () => ({ sqlTransport: "mapepire" }), getOpenRequest: () => ({}),
    cancelGraceMs: 1,
    cancelStatement: async () => { throw new Error("cancel unavailable"); },
    factory: async () => {
      const first = opens++ === 0;
      const job = { id: "123456/QUSER/QZDASOINIT", getStatus: () => "ready",
        async close() { closes++; },
        query() { return {
          execute: async () => first ? new Promise(() => {})
            : { success: true, has_results: true, is_done: true, data: [] },
          async close() {},
        }; },
      };
      return wrapMapepireJob(job, "daemon", () => true);
    },
  });
  const controller = new AbortController();
  const first = persistent.query("select N from T", { rowLimit: 1, signal: controller.signal });
  const rejected = assert.rejects(first, /SQL job closed/);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(closes, 1);
  await persistent.query("select N from T", { rowLimit: 1 });
  assert.equal(opens, 2);
  await persistent.close();
});


test("shared generic adapter rejects malformed continuation and closes", async () => {
  const f = fixture(2020, (page, n) => {
    if (n === 3) delete page.is_done;
    return page;
  });
  await assert.rejects(f.handle.run("select N from T", {}), /completeness/);
  assert.equal(f.closes, 1);
});
