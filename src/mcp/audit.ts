import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getConfigDir } from "../config/store.js";

export type AuditStatus = "ok" | "error";

export type AppendAuditInput = {
  tool: string;
  status: AuditStatus;
  args: unknown;
  connectionName?: string;
  approve?: boolean;
  durationMs: number;
  correlationId: string;
  error?: string;
  resultSummary?: Record<string, unknown>;
};

export type AuditRecord = {
  version: 1;
  id: string;
  at: string;
  tool: string;
  status: AuditStatus;
  connectionName?: string;
  approve?: boolean;
  durationMs: number;
  correlationId: string;
  argsHash: string;
  args: unknown;
  error?: string;
  resultSummary?: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

type AuditPaths = {
  dir: string;
  logPath: string;
  headPath: string;
};

type ListAuditFilter = {
  limit?: number;
  tool?: string;
  status?: AuditStatus;
  connectionName?: string;
  correlationId?: string;
  since?: string;
};

export type AuditExportFormat = "jsonl" | "json" | "csv";

let appendQueue: Promise<void> = Promise.resolve();

export async function appendAuditRecord(input: AppendAuditInput): Promise<AuditRecord> {
  const paths = resolveAuditPaths();
  await fs.mkdir(paths.dir, { recursive: true });

  let created: AuditRecord | undefined;
  appendQueue = appendQueue.then(async () => {
    const prevHash = await readHeadHash(paths.headPath);
    const nowIso = new Date().toISOString();
    const redactedArgs = redactSensitive(input.args);
    const argsHash = sha256Hex(stableStringify(redactedArgs));
    const base = {
      version: 1 as const,
      id: crypto.randomUUID(),
      at: nowIso,
      tool: input.tool,
      status: input.status,
      connectionName: input.connectionName,
      approve: input.approve,
      durationMs: input.durationMs,
      correlationId: input.correlationId,
      argsHash,
      args: redactedArgs,
      error: input.error,
      resultSummary: input.resultSummary,
      prevHash
    };
    const hash = sha256Hex(`${prevHash}|${stableStringify(base)}`);
    const record: AuditRecord = { ...base, hash };
    await fs.appendFile(paths.logPath, `${JSON.stringify(record)}\n`, "utf8");
    await fs.writeFile(paths.headPath, hash, "utf8");
    created = record;
  });

  await appendQueue;
  return created!;
}

export async function listAuditRecords(filter: ListAuditFilter = {}) {
  const paths = resolveAuditPaths();
  const limit = clampNumber(filter.limit, 200, 1, 5000);
  const entries = await readAuditRecords(paths.logPath);
  const sinceMs = filter.since ? Date.parse(filter.since) : Number.NaN;
  const hasSince = Number.isFinite(sinceMs);

  const filtered = entries.filter(entry => {
    if (filter.tool && entry.tool !== filter.tool) return false;
    if (filter.status && entry.status !== filter.status) return false;
    if (filter.connectionName && (entry.connectionName || "") !== filter.connectionName) return false;
    if (filter.correlationId && entry.correlationId !== filter.correlationId) return false;
    if (hasSince && Date.parse(entry.at) < sinceMs) return false;
    return true;
  });

  const newestFirst = filtered.reverse().slice(0, limit);
  return {
    records: newestFirst,
    total: filtered.length,
    limit
  };
}

export async function verifyAuditChain() {
  const paths = resolveAuditPaths();
  const records = await readAuditRecords(paths.logPath);
  let previous = "";
  let failures = 0;
  const failureDetails: Array<{ id: string; reason: string }> = [];

  for (const record of records) {
    if (record.prevHash !== previous) {
      failures += 1;
      failureDetails.push({ id: record.id, reason: "prevHash mismatch" });
      previous = record.hash;
      continue;
    }

    const base = {
      version: record.version,
      id: record.id,
      at: record.at,
      tool: record.tool,
      status: record.status,
      connectionName: record.connectionName,
      approve: record.approve,
      durationMs: record.durationMs,
      correlationId: record.correlationId,
      argsHash: record.argsHash,
      args: record.args,
      error: record.error,
      resultSummary: record.resultSummary,
      prevHash: record.prevHash
    };
    const expected = sha256Hex(`${record.prevHash}|${stableStringify(base)}`);
    if (expected !== record.hash) {
      failures += 1;
      failureDetails.push({ id: record.id, reason: "hash mismatch" });
    }
    previous = record.hash;
  }

  const headHash = await readHeadHash(paths.headPath);
  const headMatches = records.length === 0 ? headHash === "" : headHash === records[records.length - 1].hash;
  if (!headMatches) {
    failures += 1;
    failureDetails.push({ id: "HEAD", reason: "head hash mismatch" });
  }

  return {
    ok: failures === 0,
    records: records.length,
    failures,
    details: failureDetails.slice(0, 50),
    headHash
  };
}

export async function exportAuditRecords(options: {
  outputPath: string;
  format?: AuditExportFormat;
  filter?: ListAuditFilter;
}) {
  const paths = resolveAuditPaths();
  const format = normalizeExportFormat(options.format);
  const outputPath = path.resolve(String(options.outputPath));
  const filter = options.filter || {};
  const listing = await listAuditRecords({
    ...filter,
    limit: filter.limit ?? 5000
  });
  const records = [...listing.records].reverse();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (format === "json") {
    await fs.writeFile(outputPath, JSON.stringify(records, null, 2), "utf8");
  } else if (format === "csv") {
    const header = [
      "id",
      "at",
      "tool",
      "status",
      "connectionName",
      "approve",
      "durationMs",
      "correlationId",
      "argsHash",
      "prevHash",
      "hash",
      "error"
    ];
    const lines = [header.join(",")];
    for (const row of records) {
      const values = [
        row.id,
        row.at,
        row.tool,
        row.status,
        row.connectionName || "",
        String(Boolean(row.approve)),
        String(row.durationMs),
        row.correlationId,
        row.argsHash,
        row.prevHash,
        row.hash,
        row.error || ""
      ];
      lines.push(values.map(csvEscape).join(","));
    }
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  } else {
    const payload = records.map(row => JSON.stringify(row)).join("\n");
    await fs.writeFile(outputPath, payload.length > 0 ? `${payload}\n` : "", "utf8");
  }

  return {
    ok: true,
    outputPath,
    format,
    exported: records.length,
    sourcePath: paths.logPath
  };
}

export async function purgeAuditRecords(options: { before: string; dryRun?: boolean }) {
  const beforeIso = String(options.before || "").trim();
  const cutoff = Date.parse(beforeIso);
  if (!Number.isFinite(cutoff)) {
    throw new Error(`Invalid before timestamp: ${options.before}`);
  }

  const paths = resolveAuditPaths();
  await fs.mkdir(paths.dir, { recursive: true });
  const records = await readAuditRecords(paths.logPath);
  const keep = records.filter(record => Date.parse(record.at) >= cutoff);
  const purgeCount = records.length - keep.length;
  const dryRun = Boolean(options.dryRun);

  if (dryRun || purgeCount === 0) {
    return {
      ok: true,
      dryRun,
      before: new Date(cutoff).toISOString(),
      total: records.length,
      purged: purgeCount,
      remaining: keep.length
    };
  }

  await queueWrite(async () => {
    const rebuilt = rebuildAuditChain(keep);
    const payload = rebuilt.map(row => JSON.stringify(row)).join("\n");
    await fs.writeFile(paths.logPath, payload.length > 0 ? `${payload}\n` : "", "utf8");
    const headHash = rebuilt.length > 0 ? rebuilt[rebuilt.length - 1].hash : "";
    await fs.writeFile(paths.headPath, headHash, "utf8");
  });

  return {
    ok: true,
    dryRun: false,
    before: new Date(cutoff).toISOString(),
    total: records.length,
    purged: purgeCount,
    remaining: keep.length
  };
}

function resolveAuditPaths(): AuditPaths {
  const explicit = process.env.MCP_FOR_I_AUDIT_LOG_PATH;
  const logPath = explicit && explicit.trim().length > 0
    ? path.resolve(explicit)
    : path.join(getConfigDir(), "audit", "tool-audit.jsonl");
  const dir = path.dirname(logPath);
  return {
    dir,
    logPath,
    headPath: path.join(dir, "tool-audit.head")
  };
}

async function readAuditRecords(logPath: string): Promise<AuditRecord[]> {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as AuditRecord);
  } catch {
    return [];
  }
}

async function readHeadHash(headPath: string) {
  try {
    const raw = await fs.readFile(headPath, "utf8");
    return raw.trim();
  } catch {
    return "";
  }
}

async function queueWrite(work: () => Promise<void>) {
  appendQueue = appendQueue.then(async () => {
    await work();
  });
  await appendQueue;
}

function rebuildAuditChain(records: AuditRecord[]) {
  let previous = "";
  const rebuilt: AuditRecord[] = [];
  for (const record of records) {
    const base = {
      version: record.version,
      id: record.id,
      at: record.at,
      tool: record.tool,
      status: record.status,
      connectionName: record.connectionName,
      approve: record.approve,
      durationMs: record.durationMs,
      correlationId: record.correlationId,
      argsHash: record.argsHash,
      args: record.args,
      error: record.error,
      resultSummary: record.resultSummary,
      prevHash: previous
    };
    const hash = sha256Hex(`${previous}|${stableStringify(base)}`);
    const next: AuditRecord = { ...base, hash };
    rebuilt.push(next);
    previous = hash;
  }
  return rebuilt;
}

function normalizeExportFormat(format: string | undefined): AuditExportFormat {
  const normalized = String(format || "jsonl").trim().toLowerCase();
  if (normalized === "json" || normalized === "csv" || normalized === "jsonl") {
    return normalized;
  }
  throw new Error(`Unsupported export format: ${format}`);
}

function csvEscape(value: string) {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const props = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${props.join(",")}}`;
}

function redactSensitive(input: unknown): unknown {
  const secrets = ["password", "passphrase", "secret", "token", "apikey", "apiKey", "authorization"];
  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }
  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (secrets.some(secret => lower.includes(secret.toLowerCase()))) {
        out[key] = "***REDACTED***";
      } else {
        out[key] = redactSensitive(value);
      }
    }
    return out;
  }
  if (typeof input === "string" && input.length > 1000) {
    return `${input.substring(0, 1000)}...(truncated)`;
  }
  return input;
}
