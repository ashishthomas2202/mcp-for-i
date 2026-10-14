import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendAuditRecord, exportAuditRecords, listAuditRecords, purgeAuditRecords, verifyAuditChain } from "../dist/mcp/audit.js";

const distAudit = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/mcp/audit.js")).href;

async function withAuditLog(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-audit-"));
  const logPath = path.join(tempDir, "audit.jsonl");
  const prevPath = process.env.MCP_FOR_I_AUDIT_LOG_PATH;
  const prevKey = process.env.MCP_FOR_I_AUDIT_KEY_PATH;
  process.env.MCP_FOR_I_AUDIT_LOG_PATH = logPath;
  delete process.env.MCP_FOR_I_AUDIT_KEY_PATH;
  try {
    await fn({ tempDir, logPath });
  } finally {
    if (prevPath === undefined) delete process.env.MCP_FOR_I_AUDIT_LOG_PATH;
    else process.env.MCP_FOR_I_AUDIT_LOG_PATH = prevPath;
    if (prevKey === undefined) delete process.env.MCP_FOR_I_AUDIT_KEY_PATH;
    else process.env.MCP_FOR_I_AUDIT_KEY_PATH = prevKey;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function append(n, extra = {}) {
  return appendAuditRecord({
    tool: `ibmi.test.${n}`,
    status: "ok",
    args: { value: n },
    durationMs: n,
    correlationId: `c${n}`,
    ...extra
  });
}

async function readLines(logPath) {
  return (await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean);
}

async function writeLines(logPath, lines) {
  await fs.writeFile(logPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

test("audit chain append/verify/export/purge lifecycle", async () => {
  await withAuditLog(async ({ tempDir }) => {
    const exportPath = path.join(tempDir, "audit.csv");
    await appendAuditRecord({
      tool: "ibmi.test.one",
      status: "ok",
      args: { value: 1 },
      durationMs: 10,
      correlationId: "c1"
    });
    await appendAuditRecord({
      tool: "ibmi.test.two",
      status: "error",
      args: { value: 2 },
      durationMs: 20,
      correlationId: "c2",
      error: "boom"
    });

    const verify1 = await verifyAuditChain();
    assert.equal(verify1.ok, true);
    assert.equal(verify1.records, 2);
    assert.equal(verify1.keyedRecords, 2);

    const exported = await exportAuditRecords({
      outputPath: exportPath,
      format: "csv",
      filter: { limit: 10 }
    });
    assert.equal(exported.ok, true);
    assert.equal(exported.exported, 2);
    const csv = await fs.readFile(exportPath, "utf8");
    assert.ok(csv.includes("ibmi.test.one"));

    const dryRun = await purgeAuditRecords({
      before: "3000-01-01T00:00:00.000Z",
      dryRun: true
    });
    assert.equal(dryRun.purged, 2);

    const purge = await purgeAuditRecords({
      before: "3000-01-01T00:00:00.000Z",
      dryRun: false
    });
    assert.equal(purge.purged, 2);

    const list = await listAuditRecords({ limit: 10 });
    assert.equal(list.records.length, 0);

    const verify2 = await verifyAuditChain();
    assert.equal(verify2.ok, true);
    assert.equal(verify2.records, 0);

    // The chain continues after a full purge.
    await append(3);
    const verify3 = await verifyAuditChain();
    assert.equal(verify3.ok, true, JSON.stringify(verify3.details));
    assert.equal(verify3.records, 1);
  });
});

test("records are keyed with a per-install key file", async () => {
  await withAuditLog(async ({ tempDir }) => {
    const record = await append(1);
    assert.equal(record.version, 2);
    assert.equal(record.seq, 1);
    const key = (await fs.readFile(path.join(tempDir, "tool-audit.key"), "utf8")).trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(tempDir, "tool-audit.key"));
      assert.equal(stat.mode & 0o077, 0);
    }

    // Recomputing the hash without the key (as the old unkeyed scheme did) does not match.
    const { hash, ...base } = record;
    const unkeyed = crypto.createHash("sha256").update(`${record.prevHash}|${JSON.stringify(base)}`).digest("hex");
    assert.notEqual(unkeyed, hash);

    // Replacing the key makes every keyed record fail verification.
    await fs.writeFile(path.join(tempDir, "tool-audit.key"), crypto.randomBytes(32).toString("hex"), "utf8");
    const verify = await verifyAuditChain();
    assert.equal(verify.ok, false);
  });
});

test("an append failure does not stop later appends", async () => {
  await withAuditLog(async ({ tempDir, logPath }) => {
    await append(1);
    // Point the log at a path whose parent is a file, so the next append fails.
    const blocker = path.join(tempDir, "blocker");
    await fs.writeFile(blocker, "x", "utf8");
    process.env.MCP_FOR_I_AUDIT_LOG_PATH = path.join(blocker, "audit.jsonl");
    await assert.rejects(() => append(2));
    process.env.MCP_FOR_I_AUDIT_LOG_PATH = logPath;

    const third = await append(3);
    assert.equal(third.seq, 2);
    const verify = await verifyAuditChain();
    assert.equal(verify.ok, true, JSON.stringify(verify.details));
    assert.equal(verify.records, 2);
  });
});

test("unparseable lines are skipped by list/export and reported by verify", async () => {
  await withAuditLog(async ({ tempDir, logPath }) => {
    await append(1);
    await append(2);
    const lines = await readLines(logPath);
    await writeLines(logPath, [lines[0], "{not json", lines[1]]);

    const list = await listAuditRecords({});
    assert.equal(list.records.length, 2);
    assert.equal(list.skippedLines, 1);

    const exported = await exportAuditRecords({ outputPath: path.join(tempDir, "out.jsonl") });
    assert.equal(exported.exported, 2);
    assert.equal(exported.skippedLines, 1);

    const verify = await verifyAuditChain();
    assert.equal(verify.ok, false);
    assert.equal(verify.unparseableLines, 1);
    assert.ok(verify.details.some(d => d.reason === "unparseable line"));
    assert.equal(verify.records, 2);

    // A truncated final line (crash mid-write) does not corrupt the next record.
    await writeLines(logPath, lines);
    await fs.appendFile(logPath, '{"partial":', "utf8");
    await append(3);
    const after = await listAuditRecords({});
    assert.equal(after.records.length, 3);
    assert.equal(after.skippedLines, 1);
  });
});

test("verify detects removal of the oldest records, the newest records, and edits", async () => {
  await withAuditLog(async ({ logPath }) => {
    for (let i = 1; i <= 4; i++) await append(i);
    const original = await readLines(logPath);
    assert.equal((await verifyAuditChain()).ok, true);

    await writeLines(logPath, original.slice(1));
    const head = await verifyAuditChain();
    assert.equal(head.ok, false);
    assert.ok(head.details.some(d => /start of the log/.test(d.reason)), JSON.stringify(head.details));

    await writeLines(logPath, original.slice(0, 3));
    const tail = await verifyAuditChain();
    assert.equal(tail.ok, false);
    assert.ok(tail.details.some(d => /end of the log|record count/.test(d.reason)), JSON.stringify(tail.details));

    const edited = JSON.parse(original[2]);
    edited.status = "error";
    await writeLines(logPath, [original[0], original[1], JSON.stringify(edited), original[3]]);
    const tampered = await verifyAuditChain();
    assert.equal(tampered.ok, false);
    assert.ok(tampered.details.some(d => d.reason === "hash mismatch"));

    await writeLines(logPath, original);
    assert.equal((await verifyAuditChain()).ok, true);
  });
});

test("tail truncation followed by a new append is still detected", async () => {
  await withAuditLog(async ({ logPath }) => {
    for (let i = 1; i <= 3; i++) await append(i);
    const lines = await readLines(logPath);
    await writeLines(logPath, lines.slice(0, 2));
    await append(4);
    const verify = await verifyAuditChain();
    assert.equal(verify.ok, false);
    assert.ok(verify.details.some(d => /sequence gap|record count/.test(d.reason)), JSON.stringify(verify.details));
  });
});

test("partial purge keeps a verifiable chain and appends during a purge are kept", async () => {
  await withAuditLog(async () => {
    for (let i = 1; i <= 3; i++) await append(i);
    await new Promise(resolve => setTimeout(resolve, 5));
    const cutoff = new Date().toISOString();
    await new Promise(resolve => setTimeout(resolve, 5));
    await append(4);

    const [purge] = await Promise.all([purgeAuditRecords({ before: cutoff }), append(5), append(6)]);
    assert.equal(purge.purged, 3);
    const list = await listAuditRecords({});
    assert.deepEqual(list.records.map(r => r.tool).sort(), ["ibmi.test.4", "ibmi.test.5", "ibmi.test.6"]);
    const verify = await verifyAuditChain();
    assert.equal(verify.ok, true, JSON.stringify(verify.details));
    assert.equal(verify.anchor.lastPurge.purged, 3);
  });
});

function legacyStableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => legacyStableStringify(v)).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${legacyStableStringify(v)}`).join(",")}}`;
}

function legacyRecord(prevHash, n) {
  const args = { value: n };
  const base = {
    version: 1,
    id: `legacy-${n}`,
    at: new Date(Date.now() - 60_000 + n).toISOString(),
    tool: `ibmi.legacy.${n}`,
    status: "ok",
    connectionName: undefined,
    approve: undefined,
    durationMs: n,
    correlationId: `l${n}`,
    argsHash: crypto.createHash("sha256").update(legacyStableStringify(args)).digest("hex"),
    args,
    error: undefined,
    resultSummary: undefined,
    prevHash
  };
  const hash = crypto.createHash("sha256").update(`${prevHash}|${legacyStableStringify(base)}`).digest("hex");
  return { ...base, hash };
}

test("legacy unkeyed records verify as a legacy segment and the keyed chain continues from them", async () => {
  await withAuditLog(async ({ tempDir, logPath }) => {
    const first = legacyRecord("", 1);
    const second = legacyRecord(first.hash, 2);
    await writeLines(logPath, [JSON.stringify(first), JSON.stringify(second)]);
    await fs.writeFile(path.join(tempDir, "tool-audit.head"), second.hash, "utf8");

    const legacyOnly = await verifyAuditChain();
    assert.equal(legacyOnly.ok, true, JSON.stringify(legacyOnly.details));
    assert.equal(legacyOnly.legacyRecords, 2);

    const keyed = await append(3);
    assert.equal(keyed.prevHash, second.hash);
    const mixed = await verifyAuditChain();
    assert.equal(mixed.ok, true, JSON.stringify(mixed.details));
    assert.deepEqual(mixed.segments.map(s => [s.type, s.records]), [["legacy", 2], ["keyed", 1]]);

    // An unkeyed record appended after keyed records is rejected (downgrade).
    const forged = legacyRecord(keyed.hash, 4);
    await fs.appendFile(logPath, `${JSON.stringify(forged)}\n`, "utf8");
    const downgraded = await verifyAuditChain();
    assert.equal(downgraded.ok, false);
    assert.ok(downgraded.details.some(d => /legacy \(unkeyed\) record after keyed/.test(d.reason)));
  });
});

test("several processes appending at once extend one chain", async () => {
  await withAuditLog(async ({ logPath }) => {
    const script = `
      const { appendAuditRecord } = await import(${JSON.stringify(distAudit)});
      const worker = process.argv[1];
      for (let i = 0; i < 10; i++) {
        await appendAuditRecord({ tool: "ibmi.mp." + worker, status: "ok", args: { i }, durationMs: i, correlationId: worker + "-" + i });
      }
    `;
    await Promise.all(
      [0, 1, 2, 3].map(
        worker =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(worker)], {
              env: { ...process.env, MCP_FOR_I_AUDIT_LOG_PATH: logPath },
              stdio: ["ignore", "ignore", "pipe"]
            });
            let stderr = "";
            child.stderr.on("data", chunk => (stderr += chunk));
            child.on("error", reject);
            child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`))));
          })
      )
    );
    const verify = await verifyAuditChain();
    assert.equal(verify.ok, true, JSON.stringify(verify.details));
    assert.equal(verify.records, 40);
    assert.equal(verify.anchor.lastSeq, 40);
  });
});
