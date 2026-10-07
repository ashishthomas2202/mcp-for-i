import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IBMiClient } from "../dist/ibmi/client.js";
import {
  PersistentSqlJob,
  SqlJobUnavailableError,
  normalizeRow,
  toSqlError,
  chainHasFingerprint,
  derToPem,
  normalizeSqlTransport
} from "../dist/ibmi/sqlJob.js";
import { checkCertificate, certificateFingerprint, checkHostKey, CertificateMismatchError } from "../dist/ibmi/knownHosts.js";
import { handleTool } from "../dist/mcp/tools.js";

const JOB = "123456/QUSER/QZDASOINIT";

/** A fake Mapepire job: records statements and answers from `respond`. */
function fakeJob(respond = () => ({ rows: [] })) {
  const job = {
    jobName: JOB,
    mode: "daemon",
    alive: true,
    closed: false,
    statements: [],
    pending: new Set(),
    isAlive() { return this.alive && !this.closed; },
    run(sql, options) {
      job.statements.push({ sql, parameters: options.parameters });
      return new Promise((resolve, reject) => {
        const entry = { reject };
        job.pending.add(entry);
        Promise.resolve()
          .then(() => respond(sql, options, job))
          .then(resolve, reject)
          .finally(() => job.pending.delete(entry));
      });
    },
    async close() {
      job.closed = true;
      for (const entry of job.pending) entry.reject(new Error("SQL job closed"));
    }
  };
  return job;
}

function fakeSsh(calls) {
  return {
    async execCommand(command, options) {
      calls.push({ command, stdin: options?.stdin });
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
    dispose() {}
  };
}

/** An IBMiClient that looks connected, with an injected SQL job factory. */
function connectedClient(config, factory) {
  const sshCalls = [];
  const client = new IBMiClient({ name: "t", host: "h", port: 22, username: "u", ...config }, { sqlJobFactory: factory });
  client.client = fakeSsh(sshCalls);
  client.connection = { name: "t", host: "h", port: 22, username: "u", password: "pw" };
  return { client, sshCalls };
}

test("SQL and @ CL lines run in one persistent job; libl is applied when it opens", async () => {
  const opened = [];
  const job = fakeJob(sql => sql.startsWith("select")
    ? { rows: [{ NAME: "ABC   ", QTY: "12.50", N: 3, NOTE: null }], columns: [{ name: "NAME", type: "CHAR" }, { name: "QTY", type: "DECIMAL" }] }
    : { rows: [] });
  const { client, sshCalls } = connectedClient(
    { libraryList: ["MYLIB", "qgpl"], currentLibrary: "MYLIB" },
    async request => { opened.push(request); return job; }
  );

  const rows = await client.runSQL("@CHGJOB LOG(4 00 *SECLVL)\nselect name, qty from t1; -- trailing comment");
  assert.deepEqual(rows, [{ NAME: "ABC", QTY: 12.5, N: 3, NOTE: null }]);
  await client.runSQL("select 1 from sysibm.sysdummy1");

  assert.equal(opened.length, 1, "the job is opened once and reused");
  assert.equal(opened[0].host, "h");
  assert.equal(opened[0].username, "u");
  assert.equal(opened[0].password, "pw");
  assert.equal(opened[0].port, 8076);
  assert.deepEqual(job.statements.map(s => s.sql), [
    "CALL QSYS2.QCMDEXC(?)",
    "CALL QSYS2.QCMDEXC(?)",
    "select name, qty from t1",
    "select 1 from sysibm.sysdummy1"
  ]);
  assert.deepEqual(job.statements[0].parameters, ["CHGLIBL LIBL(MYLIB QGPL) CURLIB(MYLIB)"]);
  assert.deepEqual(job.statements[1].parameters, ["CHGJOB LOG(4 00 *SECLVL)"]);
  assert.equal(sshCalls.length, 0, "QZDFMDB2 is not used");
  assert.equal(client.sqlJob.status().active, "mapepire");
  assert.equal(client.sqlJob.status().jobName, JOB);
});

test("CL from ibmi.libl.* style calls runs in the same job as later SQL", async () => {
  const job = fakeJob();
  const { client } = connectedClient({}, async () => job);
  const result = await client.runCL("CHGCURLIB CURLIB(DEVLIB)");
  assert.equal(result.code, 0);
  await client.runSQL("select * from table(qsys2.joblog_info('*')) x");
  assert.deepEqual(job.statements.map(s => [s.sql, s.parameters]), [
    ["CALL QSYS2.QCMDEXC(?)", ["CHGCURLIB CURLIB(DEVLIB)"]],
    ["select * from table(qsys2.joblog_info('*')) x", undefined]
  ]);

  const failing = fakeJob(() => { throw new Error("Library NOPE not found., 38501, -443"); });
  const other = connectedClient({}, async () => failing).client;
  const bad = await other.runCL("CHGCURLIB CURLIB(NOPE)");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /NOPE not found/);
});

test("auto falls back to QZDFMDB2 when Mapepire is unavailable and caches that", async () => {
  let attempts = 0;
  const { client, sshCalls } = connectedClient({}, async () => {
    attempts += 1;
    throw new SqlJobUnavailableError("Mapepire server not reachable on h:8076 (ECONNREFUSED)");
  });
  await client.runSQL("select 1 from sysibm.sysdummy1");
  await client.runSQL("select 2 from sysibm.sysdummy1");
  assert.equal(attempts, 1, "the failed probe is cached per connection");
  assert.equal(sshCalls.length, 2);
  assert.match(sshCalls[0].command, /QZDFMDB2/);
  const status = client.sqlJob.status();
  assert.equal(status.active, "qzdfmdb2");
  assert.match(status.unavailableReason, /ECONNREFUSED/);

  // CL falls back to a qsh job, single-quoted so nothing is expanded.
  await client.runCL("CHGCURLIB CURLIB($LIB)");
  assert.match(sshCalls[2].stdin, /^system 'CHGCURLIB CURLIB\(\$LIB\)'$/);
});

test("sqlTransport mapepire fails instead of falling back; qzdfmdb2 never opens a job", async () => {
  const strict = connectedClient({ sqlTransport: "mapepire" }, async () => {
    throw new SqlJobUnavailableError("not reachable");
  });
  await assert.rejects(strict.client.runSQL("select 1 from sysibm.sysdummy1"), /sqlTransport is "mapepire".*not reachable/);
  assert.equal(strict.sshCalls.length, 0);

  let opened = 0;
  const legacy = connectedClient({ sqlTransport: "qzdfmdb2" }, async () => { opened += 1; return fakeJob(); });
  await legacy.client.runSQL("select 1 from sysibm.sysdummy1");
  assert.equal(opened, 0);
  assert.equal(legacy.sshCalls.length, 1);
  assert.equal(legacy.client.sqlJob.status().active, "qzdfmdb2");

  assert.equal(normalizeSqlTransport("MAPEPIRE"), "mapepire");
  assert.equal(normalizeSqlTransport(undefined), "auto");
  assert.equal(normalizeSqlTransport("bogus"), "auto");
});

test("a client that is not connected uses QZDFMDB2 (no job is opened)", async () => {
  let opened = 0;
  const client = new IBMiClient({ name: "t", host: "h", port: 22, username: "u" }, { sqlJobFactory: async () => { opened += 1; return fakeJob(); } });
  const calls = [];
  client.client = fakeSsh(calls);
  await client.runSQL("select 1 from sysibm.sysdummy1");
  assert.equal(opened, 0);
  assert.equal(calls.length, 1);
});

test("a dead job is reopened, the library list reapplied and a read retried", async () => {
  const jobs = [];
  const factory = async () => {
    const job = fakeJob((sql, _options, self) => {
      if (sql.startsWith("select") && self === jobs[0]) {
        self.alive = false;
        throw new Error("Connection failed with code 1006");
      }
      return { rows: sql.startsWith("select") ? [{ A: 1 }] : [] };
    });
    jobs.push(job);
    return job;
  };
  const { client } = connectedClient({ libraryList: ["MYLIB"] }, factory);
  const rows = await client.runSQL("select a from t");
  assert.deepEqual(rows, [{ A: 1 }]);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].closed, true);
  assert.deepEqual(jobs[1].statements[0].parameters, ["CHGLIBL LIBL(MYLIB)"]);

  // A write that hits a dead job is not retried (it may have run).
  const writeJobs = [];
  const writeFactory = async () => {
    const job = fakeJob((sql, _o, self) => {
      if (sql.startsWith("insert")) { self.alive = false; throw new Error("Connection failed with code 1006"); }
      return { rows: [] };
    });
    writeJobs.push(job);
    return job;
  };
  const w = connectedClient({}, writeFactory).client;
  await assert.rejects(w.runSQL("insert into t values(1)"), /Connection failed/);
  assert.equal(writeJobs.length, 1);
  await w.runSQL("select 1 from sysibm.sysdummy1");
  assert.equal(writeJobs.length, 2, "next call opens a new job");
});

test("SQL errors from the job become SqlError with SQLSTATE", async () => {
  const err = toSqlError(new Error("[SQL0204] T1 in MYLIB type *FILE not found., 42704, -204"), "select * from t1");
  assert.equal(err.sqlstate, "42704");
  assert.match(err.message, /T1 in MYLIB.*\(42704\)/);
  const plain = toSqlError(new Error("socket hang up"), "x");
  assert.equal(plain.message, "socket hang up");

  const job = fakeJob(() => { throw new Error("Token X was not valid., 42601, -104"); });
  const { client } = connectedClient({}, async () => job);
  await assert.rejects(client.runSQL("selec 1"), err => err.sqlstate === "42601");
});

test("update counts are reported; rows are normalized like QZDFMDB2 output", async () => {
  const job = fakeJob(sql => sql.startsWith("update") ? { rows: [], updateCount: 4 } : { rows: [] });
  const { client } = connectedClient({}, async () => job);
  const rows = await client.runSQL("update t set a = 1");
  assert.equal(rows.length, 0);
  assert.equal(rows.updateCount, 4);
  assert.deepEqual(Object.keys(rows), [], "updateCount is not enumerable");

  assert.deepEqual(
    normalizeRow({ A: "x  ", B: "001.50", C: true, D: undefined, E: "  lead" }, [{ name: "B", type: "NUMERIC" }]),
    { A: "x", B: 1.5, C: "true", D: null, E: "  lead" }
  );
});

test("timeout: the running statement is cancelled with CANCEL_SQL, then the job is ended", async () => {
  const cancels = [];
  let config = {};
  const jobs = [];
  const sqlJob = new PersistentSqlJob({
    getConfig: () => config,
    getOpenRequest: () => ({}),
    factory: async () => {
      const job = fakeJob(sql => sql.includes("slow") ? new Promise(() => {}) : { rows: [{ A: 1 }] });
      jobs.push(job);
      return job;
    },
    cancelStatement: async jobName => { cancels.push(jobName); },
    cancelGraceMs: 30
  });

  const controller = new AbortController();
  const running = sqlJob.runSql("select * from slow", { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running, /closed|cancel/i);
  assert.deepEqual(cancels, [JOB]);
  assert.equal(jobs[0].closed, true, "job ended because the statement did not stop");
  assert.match(sqlJob.status().lastCancel, /CANCEL_SQL requested.*job was ended/);

  const rows = await sqlJob.runSql("select a from t");
  assert.deepEqual(rows, [{ A: 1 }]);
  assert.equal(jobs.length, 2, "a new job is opened after the cancel");
});

test("timeout: when CANCEL_SQL stops the statement the job is kept", async () => {
  let release;
  const job = fakeJob(sql => sql.includes("slow")
    ? new Promise((_, reject) => { release = () => reject(new Error("Statement cancelled., 57014, -952")); })
    : { rows: [] });
  const sqlJob = new PersistentSqlJob({
    getConfig: () => ({}),
    getOpenRequest: () => ({}),
    factory: async () => job,
    cancelStatement: async () => { release(); },
    cancelGraceMs: 1000
  });
  const controller = new AbortController();
  const running = sqlJob.runSql("select * from slow", { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running, err => err.sqlstate === "57014");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(job.closed, false);
  assert.equal(sqlJob.isOpen(), true);
});

test("ibmi.sql.query passes an abort signal that fires on timeout", async () => {
  let seenSignal;
  const conn = {
    currentConnectionName: "DEV",
    getConfig: () => ({}),
    async runSQL(_sql, options) {
      seenSignal = options?.signal;
      return new Promise(() => {});
    }
  };
  const ctx = { store: {}, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => ({ profile: "power-user" }) };
  await assert.rejects(
    handleTool(ctx, "ibmi.sql.query", { sql: "select * from big", timeoutMs: 1000 }),
    /timed out after 1000ms/
  );
  assert.ok(seenSignal, "runSQL received a signal");
  assert.equal(seenSignal.aborted, true);

  await assert.rejects(
    handleTool(ctx, "ibmi.sql.query", { sql: "@DLTLIB LIB(X)" }),
    /read-only/,
    "read-only check still applies before the job is used"
  );
});

test("sql.execute reports the job's update count as affectedRows", async () => {
  const rows = [];
  Object.defineProperty(rows, "updateCount", { value: 7, enumerable: false });
  const conn = {
    currentConnectionName: "DEV",
    getConfig: () => ({ readOnlyMode: false }),
    async runSQL() { return rows; }
  };
  const ctx = { store: {}, activeName: "DEV", ensureActive: async () => conn, getPolicy: () => ({ profile: "power-user" }) };
  const response = await handleTool(ctx, "ibmi.sql.execute", { sql: "delete from t where a = 1" });
  assert.equal(response.structuredContent.data.affectedRows, 7);
});

test("disconnect closes the persistent job", async () => {
  const job = fakeJob();
  const { client } = connectedClient({}, async () => job);
  await client.runSQL("select 1 from sysibm.sysdummy1");
  await client.disconnect();
  assert.equal(job.closed, true);
  assert.equal(client.sqlJob.isOpen(), false);
});

test("TLS certificates are pinned on first use next to SSH host keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfori-cert-"));
  const filePath = path.join(dir, "known_hosts.json");
  const certA = Buffer.from("certificate-a");
  const certB = Buffer.from("certificate-b");

  await checkHostKey({ host: "ibmi", port: 22, key: Buffer.from("hostkey"), filePath, acceptNew: "" });
  const first = await checkCertificate({ host: "ibmi", port: 8076, der: certA, subject: "CN=ibmi", filePath, acceptNew: "" });
  assert.equal(first.status, "added");
  assert.equal((await checkCertificate({ host: "IBMI", port: 8076, der: certA, filePath, acceptNew: "" })).status, "trusted");
  await assert.rejects(checkCertificate({ host: "ibmi", port: 8076, der: certB, filePath, acceptNew: "" }), CertificateMismatchError);
  const replaced = await checkCertificate({ host: "ibmi", port: 8076, der: certB, subject: "CN=ibmi", filePath, acceptNew: "ibmi:8076" });
  assert.equal(replaced.status, "replaced");

  const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.ok(stored.hosts["ibmi:22"], "SSH host keys are kept");
  assert.equal(stored.certificates["ibmi:8076"].fingerprint, certificateFingerprint(certB));
  assert.equal(stored.certificates["ibmi:8076"].subject, "CN=ibmi");
  // Writing a host key keeps the certificates.
  await checkHostKey({ host: "other", port: 22, key: Buffer.from("k2"), filePath, acceptNew: "" });
  assert.ok(JSON.parse(await fs.readFile(filePath, "utf8")).certificates["ibmi:8076"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("pinned chain check and PEM encoding", () => {
  const root = { raw: Buffer.from("root") };
  root.issuerCertificate = root;
  const leaf = { raw: Buffer.from("leaf"), issuerCertificate: root };
  assert.equal(chainHasFingerprint(leaf, certificateFingerprint(Buffer.from("root"))), true);
  assert.equal(chainHasFingerprint(leaf, certificateFingerprint(Buffer.from("other"))), false);
  const pem = derToPem(Buffer.alloc(100, 1));
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/);
});

test("auto mode does not let a slow job start eat the caller's time", async () => {
  const job = fakeJob(() => ({ rows: [{ A: 1 }] }));
  const sqlJob = new PersistentSqlJob({
    getConfig: () => ({}),
    getOpenRequest: () => ({}),
    factory: () => new Promise(resolve => setTimeout(() => resolve(job), 60)),
    openWaitMs: 20
  });
  assert.equal(await sqlJob.runSql("select a from t"), undefined, "first call falls back while the job starts");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(await sqlJob.runSql("select a from t"), [{ A: 1 }]);
  assert.equal(sqlJob.status().active, "mapepire");
});
