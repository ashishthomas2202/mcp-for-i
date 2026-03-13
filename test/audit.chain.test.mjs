import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAuditRecord, exportAuditRecords, listAuditRecords, purgeAuditRecords, verifyAuditChain } from "../dist/mcp/audit.js";

test("audit chain append/verify/export/purge lifecycle", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-audit-"));
  const logPath = path.join(tempDir, "audit.jsonl");
  const exportPath = path.join(tempDir, "audit.csv");
  const prevPath = process.env.MCP_FOR_I_AUDIT_LOG_PATH;
  process.env.MCP_FOR_I_AUDIT_LOG_PATH = logPath;

  try {
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
  } finally {
    if (prevPath === undefined) {
      delete process.env.MCP_FOR_I_AUDIT_LOG_PATH;
    } else {
      process.env.MCP_FOR_I_AUDIT_LOG_PATH = prevPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
