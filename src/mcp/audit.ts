import crypto from "crypto";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import { getConfigDir } from "../config/store.js";
import { isTransientFsError, readFileWithRetry, sleep, writeFileAtomic } from "../util/atomicWrite.js";
import { redactSecrets } from "../security/redact.js";
import { withFileLock } from "../util/fileLock.js";

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

/**
 * One line of the audit log.
 *
 * - version 1 (legacy): `hash = sha256(prevHash | record)`, no key, no sequence.
 * - version 2 (keyed): `hash = HMAC-SHA256(installKey, prevHash | record)`, with a
 *   key id and a sequence number that increases by one per record.
 */
export type AuditRecord = {
  version: 1 | 2;
  seq?: number;
  keyId?: string;
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

/**
 * Checkpoint kept next to the log and updated on every append and purge, so that
 * removing records from the start or the end of the log is detectable.
 */
type AuditAnchor = {
  version: 1;
  keyId: string;
  records: number;
  firstHash: string;
  firstPrevHash: string;
  firstSeq: number | null;
  lastSeq: number;
  lastHash: string;
  updatedAt: string;
  lastPurge?: { at: string; before: string; purged: number };
  resets: Array<{ at: string; reason: string }>;
  mac: string;
};

type AuditPaths = {
  dir: string;
  logPath: string;
  headPath: string;
  anchorPath: string;
  keyPath: string;
  lockPath: string;
};

type ListAuditFilter = {
  limit?: number;
  tool?: string;
  status?: AuditStatus;
  connectionName?: string;
  correlationId?: string;
  since?: string;
};

type ParsedLog = {
  records: AuditRecord[];
  /** 1-based line numbers of lines that are not valid audit records. */
  unparseableLines: number[];
  /** Non-empty lines in file order, with the parsed record when the line is valid. */
  lines: Array<{ raw: string; lineNumber: number; record?: AuditRecord }>;
};

export type AuditExportFormat = "jsonl" | "json" | "csv";

const LOCK_OPTIONS = { staleMs: 30_000, timeoutMs: 20_000 };
const MAX_ANCHOR_RESETS = 20;

// In-process chain of audit writes (appends and purges). Each link swallows its
// own failure, so one failed write never stops later ones; the caller still
// receives the error.
let appendQueue: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = appendQueue.then(work);
  appendQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function appendAuditRecord(input: AppendAuditInput): Promise<AuditRecord> {
  const paths = resolveAuditPaths();
  const redactedArgs = redactSecrets(input.args);
  const argsHash = sha256Hex(stableStringify(redactedArgs));

  return enqueue(() =>
    withAuditLock(paths, async () => {
      // Everything below reads the current state from disk under the cross-process
      // lock, so several MCP processes extend one chain instead of forking it.
      const key = await loadOrCreateKey(paths);
      const anchor = await ensureAnchor(paths, key);
      const tail = await readTail(paths.logPath);

      const prevHash = tail.last ? tail.last.hash : anchor.records === 0 ? anchor.lastHash : "";
      const seq = Math.max(anchor.lastSeq, tail.last?.seq ?? 0) + 1;
      const base = toJsonValue({
        version: 2 as const,
        seq,
        keyId: key.id,
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
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
      });
      const record = { ...base, hash: keyedHash(key.secret, prevHash, base) } as AuditRecord;

      const prefix = tail.size > 0 && !tail.endsWithNewline ? "\n" : "";
      await appendWithRetry(paths.logPath, `${prefix}${JSON.stringify(record)}\n`);

      const next: Omit<AuditAnchor, "mac"> = {
        ...stripMac(anchor),
        records: anchor.records + 1,
        lastSeq: seq,
        lastHash: record.hash,
        updatedAt: record.at
      };
      if (anchor.records === 0) {
        next.firstHash = record.hash;
        next.firstPrevHash = prevHash;
        next.firstSeq = seq;
      }
      await writeAnchor(paths, key, next);
      await writeHead(paths, record.hash);
      return record;
    })
  );
}

export async function listAuditRecords(filter: ListAuditFilter = {}) {
  const paths = resolveAuditPaths();
  const limit = clampNumber(filter.limit, 200, 1, 5000);
  const parsed = await readAuditLog(paths.logPath);
  const sinceMs = filter.since ? Date.parse(filter.since) : Number.NaN;
  const hasSince = Number.isFinite(sinceMs);

  const filtered = parsed.records.filter(entry => {
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
    limit,
    skippedLines: parsed.unparseableLines.length
  };
}

export async function verifyAuditChain() {
  const paths = resolveAuditPaths();
  // Taken under the lock so the log and the anchor are read as one consistent snapshot.
  return withAuditLock(paths, async () => {
    const parsed = await readAuditLog(paths.logPath);
    const records = parsed.records;
    const key = await readKey(paths);
    const anchorRead = await readAnchor(paths, key);
    const anchor = anchorRead.anchor;
    const failureDetails: Array<{ id: string; reason: string }> = [];
    const fail = (id: string, reason: string) => {
      failureDetails.push({ id, reason });
    };

    for (const lineNumber of parsed.unparseableLines) {
      fail(`line ${lineNumber}`, "unparseable line");
    }
    if (anchorRead.problem) fail("ANCHOR", anchorRead.problem);
    for (const reset of anchor?.resets || []) {
      fail("ANCHOR", `anchor was rebuilt at ${reset.at}: ${reset.reason}`);
    }

    let previous = anchor ? anchor.firstPrevHash : "";
    let lastSeq: number | undefined;
    let seenKeyed = false;
    let legacyCount = 0;
    let keyedCount = 0;
    const segments: Array<{ type: "legacy" | "keyed"; firstId: string; lastId: string; records: number; failures: number }> = [];

    records.forEach((record, index) => {
      const before = failureDetails.length;
      if (index === 0 && anchor && record.hash !== anchor.firstHash) {
        fail(record.id, "first record does not match the anchor (records were removed from the start of the log)");
      }
      if (record.prevHash !== previous) {
        fail(record.id, "prevHash mismatch");
      }

      let type: "legacy" | "keyed";
      if (record.version === 2) {
        type = "keyed";
        seenKeyed = true;
        keyedCount += 1;
        if (!key) {
          fail(record.id, "audit key file is missing; keyed record cannot be verified");
        } else if (record.keyId !== key.id) {
          fail(record.id, "record was signed with a different audit key");
        } else {
          const { hash: _hash, ...base } = record;
          if (!timingSafeEqualHex(keyedHash(key.secret, record.prevHash, base), record.hash)) {
            fail(record.id, "hash mismatch");
          }
        }
        if (typeof record.seq !== "number") {
          fail(record.id, "missing sequence number");
        } else {
          if (lastSeq !== undefined && record.seq !== lastSeq + 1) {
            fail(record.id, `sequence gap (expected ${lastSeq + 1}, found ${record.seq})`);
          }
          lastSeq = record.seq;
        }
      } else {
        type = "legacy";
        legacyCount += 1;
        if (seenKeyed) {
          fail(record.id, "legacy (unkeyed) record after keyed records");
        }
        if (legacyHash(record) !== record.hash) {
          fail(record.id, "hash mismatch");
        }
      }

      const failed = failureDetails.length - before;
      const current = segments[segments.length - 1];
      if (current && current.type === type) {
        current.lastId = record.id;
        current.records += 1;
        current.failures += failed;
      } else {
        segments.push({ type, firstId: record.id, lastId: record.id, records: 1, failures: failed });
      }
      previous = record.hash;
    });

    const headHash = await readHeadHash(paths.headPath);
    const last = records[records.length - 1];
    if (anchor) {
      if (anchor.records !== records.length) {
        fail("ANCHOR", `record count does not match the anchor (expected ${anchor.records}, found ${records.length})`);
      }
      if (last && last.hash !== anchor.lastHash) {
        fail("ANCHOR", "last record does not match the anchor (records were removed from or added to the end of the log)");
      }
      if (last && last.version === 2 && last.seq !== anchor.lastSeq) {
        fail("ANCHOR", `last sequence number does not match the anchor (expected ${anchor.lastSeq}, found ${last.seq})`);
      }
    } else if (!anchorRead.problem) {
      if (keyedCount > 0) {
        fail("ANCHOR", "anchor file is missing");
      }
      // Log written only by older versions: fall back to the legacy head check.
      const headMatches = records.length === 0 ? headHash === "" : headHash === last.hash;
      if (!headMatches) {
        fail("HEAD", "head hash mismatch");
      }
    }

    return {
      ok: failureDetails.length === 0,
      records: records.length,
      failures: failureDetails.length,
      details: failureDetails.slice(0, 50),
      headHash,
      keyedRecords: keyedCount,
      legacyRecords: legacyCount,
      unparseableLines: parsed.unparseableLines.length,
      segments,
      anchor: anchor
        ? {
            records: anchor.records,
            firstSeq: anchor.firstSeq,
            lastSeq: anchor.lastSeq,
            lastHash: anchor.lastHash,
            updatedAt: anchor.updatedAt,
            lastPurge: anchor.lastPurge
          }
        : null
    };
  });
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
      lines.push(values.map(value => csvEscape(String(value ?? ""))).join(","));
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
    skippedLines: listing.skippedLines,
    sourcePath: paths.logPath
  };
}

export async function purgeAuditRecords(options: { before: string; dryRun?: boolean }) {
  const beforeIso = String(options.before || "").trim();
  const cutoff = Date.parse(beforeIso);
  if (!Number.isFinite(cutoff)) {
    throw new Error(`Invalid before timestamp: ${options.before}`);
  }
  const dryRun = Boolean(options.dryRun);
  const paths = resolveAuditPaths();

  // Read and rewrite inside the write queue and the cross-process lock, so records
  // appended while the purge runs are never dropped.
  return enqueue(() =>
    withAuditLock(paths, async () => {
      const parsed = await readAuditLog(paths.logPath);
      // Unparseable lines are kept: they are evidence for verify, not ours to discard.
      const keepLines = parsed.lines.filter(line => !line.record || !(Date.parse(line.record.at) < cutoff));
      const keepRecords = keepLines.map(line => line.record).filter((r): r is AuditRecord => Boolean(r));
      const total = parsed.records.length;
      const purgeCount = total - keepRecords.length;
      const summary = {
        ok: true,
        dryRun,
        before: new Date(cutoff).toISOString(),
        total,
        purged: purgeCount,
        remaining: keepRecords.length,
        skippedLines: parsed.unparseableLines.length
      };
      if (dryRun || purgeCount === 0) return summary;

      const key = await loadOrCreateKey(paths);
      const anchor = await ensureAnchor(paths, key);
      // Kept records are not re-hashed: the anchor records where the chain now starts.
      const payload = keepLines.map(line => line.raw).join("\n");
      await writeFileAtomic(paths.logPath, payload.length > 0 ? `${payload}\n` : "");

      const first = keepRecords[0];
      const lastKept = keepRecords[keepRecords.length - 1];
      const now = new Date().toISOString();
      await writeAnchor(paths, key, {
        ...stripMac(anchor),
        records: keepRecords.length,
        firstHash: first ? first.hash : "",
        firstPrevHash: first ? first.prevHash : anchor.lastHash,
        firstSeq: first && typeof first.seq === "number" ? first.seq : null,
        updatedAt: now,
        lastPurge: { at: now, before: summary.before, purged: purgeCount }
      });
      await writeHead(paths, lastKept ? lastKept.hash : "");
      return summary;
    })
  );
}

function resolveAuditPaths(): AuditPaths {
  const explicit = process.env.MCP_FOR_I_AUDIT_LOG_PATH;
  const logPath = explicit && explicit.trim().length > 0
    ? path.resolve(explicit)
    : path.join(getConfigDir(), "audit", "tool-audit.jsonl");
  const dir = path.dirname(logPath);
  const explicitKey = process.env.MCP_FOR_I_AUDIT_KEY_PATH;
  return {
    dir,
    logPath,
    headPath: path.join(dir, "tool-audit.head"),
    anchorPath: path.join(dir, "tool-audit.anchor.json"),
    keyPath: explicitKey && explicitKey.trim().length > 0 ? path.resolve(explicitKey) : path.join(dir, "tool-audit.key"),
    lockPath: path.join(dir, "tool-audit.lock")
  };
}

async function withAuditLock<T>(paths: AuditPaths, work: () => Promise<T>): Promise<T> {
  await fs.mkdir(paths.dir, { recursive: true });
  return withFileLock(paths.lockPath, work, LOCK_OPTIONS);
}

// ---------------------------------------------------------------------------
// Reading the log

async function readAuditLog(logPath: string): Promise<ParsedLog> {
  let raw = "";
  try {
    raw = await readFileWithRetry(logPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const result: ParsedLog = { records: [], unparseableLines: [], lines: [] };
  raw.split(/\r?\n/).forEach((text, index) => {
    const line = text.trim();
    if (!line) return;
    const record = parseRecordLine(line);
    result.lines.push({ raw: line, lineNumber: index + 1, record });
    if (record) result.records.push(record);
    else result.unparseableLines.push(index + 1);
  });
  return result;
}

function parseRecordLine(line: string): AuditRecord | undefined {
  if (!line) return undefined;
  try {
    const value = JSON.parse(line);
    if (
      value &&
      typeof value === "object" &&
      typeof value.hash === "string" &&
      typeof value.prevHash === "string" &&
      typeof value.at === "string"
    ) {
      return value as AuditRecord;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Reads backwards from the end of the log to find the last valid record without loading the whole file. */
async function readTail(logPath: string): Promise<{ last?: AuditRecord; size: number; endsWithNewline: boolean }> {
  let handle: FileHandle;
  try {
    handle = await fs.open(logPath, "r");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { size: 0, endsWithNewline: true };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { size, endsWithNewline: true };
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, size - 1);
    const endsWithNewline = lastByte[0] === 0x0a;

    const chunkSize = 64 * 1024;
    let position = size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const chunk = Buffer.alloc(position - start);
      await handle.read(chunk, 0, chunk.length, start);
      position = start;
      const buffer = Buffer.concat([chunk, carry]);
      // Every byte range after a newline in the buffer is a complete line.
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue;
        const record = parseRecordLine(buffer.subarray(i + 1, end).toString("utf8").trim());
        if (record) return { last: record, size, endsWithNewline };
        end = i;
      }
      carry = buffer.subarray(0, end);
    }
    const record = parseRecordLine(carry.toString("utf8").trim());
    return { last: record, size, endsWithNewline };
  } finally {
    await handle.close();
  }
}

async function appendWithRetry(filePath: string, content: string, retries = 8) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.appendFile(filePath, content, "utf8");
      return;
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= retries) throw err;
      await sleep(20 * (attempt + 1));
    }
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

async function writeHead(paths: AuditPaths, hash: string) {
  await writeFileAtomic(paths.headPath, hash, { fsync: false });
}

// ---------------------------------------------------------------------------
// Install key (HMAC secret)

type AuditKey = { secret: Buffer; id: string };

async function readKey(paths: AuditPaths): Promise<AuditKey | undefined> {
  try {
    const raw = (await readFileWithRetry(paths.keyPath)).trim();
    if (!/^[0-9a-f]{64}$/i.test(raw)) return undefined;
    const secret = Buffer.from(raw, "hex");
    return { secret, id: sha256Hex(secret).slice(0, 16) };
  } catch {
    return undefined;
  }
}

/** Must be called while holding the audit lock, so only one process creates the key. */
async function loadOrCreateKey(paths: AuditPaths): Promise<AuditKey> {
  const existing = await readKey(paths);
  if (existing) return existing;
  let exists = true;
  try {
    await fs.access(paths.keyPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    exists = false;
  }
  if (exists) {
    throw new Error(`Audit key file ${paths.keyPath} does not contain a valid key; refusing to replace it.`);
  }
  const secret = crypto.randomBytes(32);
  await fs.mkdir(path.dirname(paths.keyPath), { recursive: true });
  await writeFileAtomic(paths.keyPath, secret.toString("hex"), { mode: 0o600 });
  return { secret, id: sha256Hex(secret).slice(0, 16) };
}

// ---------------------------------------------------------------------------
// Anchor

async function readAnchor(
  paths: AuditPaths,
  key: AuditKey | undefined
): Promise<{ anchor?: AuditAnchor; problem?: string; exists: boolean }> {
  let raw: string;
  try {
    raw = await readFileWithRetry(paths.anchorPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { exists: false };
    return { exists: true, problem: `anchor file could not be read (${err?.code || err?.message})` };
  }
  let anchor: AuditAnchor;
  try {
    anchor = JSON.parse(raw);
  } catch {
    return { exists: true, problem: "anchor file is not valid JSON" };
  }
  if (!anchor || typeof anchor !== "object" || typeof anchor.mac !== "string") {
    return { exists: true, problem: "anchor file has an unexpected format" };
  }
  if (!Array.isArray(anchor.resets)) anchor.resets = [];
  if (!key) return { exists: true, anchor, problem: "audit key file is missing; the anchor cannot be verified" };
  if (anchor.keyId !== key.id) return { exists: true, anchor, problem: "anchor was signed with a different audit key" };
  if (!timingSafeEqualHex(anchorMac(key.secret, stripMac(anchor)), anchor.mac)) {
    return { exists: true, anchor, problem: "anchor signature mismatch (the anchor file was modified)" };
  }
  return { exists: true, anchor };
}

/**
 * Returns a trusted anchor, creating it the first time (from the existing log) or
 * rebuilding it when it is missing or invalid. A rebuild after keyed records were
 * written is recorded in `resets`, which verify keeps reporting as a failure.
 */
async function ensureAnchor(paths: AuditPaths, key: AuditKey): Promise<AuditAnchor> {
  const current = await readAnchor(paths, key);
  if (current.anchor && !current.problem) return current.anchor;

  const parsed = await readAuditLog(paths.logPath);
  const records = parsed.records;
  const first = records[0];
  const last = records[records.length - 1];
  const lastSeq = records.reduce((max, r) => (typeof r.seq === "number" && r.seq > max ? r.seq : max), 0);
  const hasKeyed = records.some(r => r.version === 2);

  const resets = current.anchor?.resets ? [...current.anchor.resets] : [];
  let reason: string | undefined;
  if (current.problem) reason = current.problem;
  else if (!current.exists && hasKeyed) reason = "anchor file was missing";
  if (reason) {
    resets.push({ at: new Date().toISOString(), reason });
    while (resets.length > MAX_ANCHOR_RESETS) resets.shift();
  }

  return writeAnchor(paths, key, {
    version: 1,
    keyId: key.id,
    records: records.length,
    firstHash: first ? first.hash : "",
    firstPrevHash: first ? first.prevHash : "",
    firstSeq: first && typeof first.seq === "number" ? first.seq : null,
    lastSeq,
    lastHash: last ? last.hash : "",
    updatedAt: new Date().toISOString(),
    resets
  });
}

async function writeAnchor(paths: AuditPaths, key: AuditKey, anchor: Omit<AuditAnchor, "mac">): Promise<AuditAnchor> {
  const unsigned = toJsonValue({ ...anchor, keyId: key.id });
  const signed: AuditAnchor = { ...unsigned, mac: anchorMac(key.secret, unsigned) };
  await writeFileAtomic(paths.anchorPath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  return signed;
}

function stripMac(anchor: AuditAnchor): Omit<AuditAnchor, "mac"> {
  const { mac: _mac, ...rest } = anchor;
  return rest;
}

function anchorMac(secret: Buffer, anchor: Omit<AuditAnchor, "mac">) {
  return crypto.createHmac("sha256", secret).update(`anchor|${canonicalJson(anchor)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Hashing

function keyedHash(secret: Buffer, prevHash: string, base: unknown) {
  return crypto.createHmac("sha256", secret).update(`${prevHash}|${canonicalJson(base)}`).digest("hex");
}

function legacyHash(record: AuditRecord) {
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
  return sha256Hex(`${record.prevHash}|${stableStringify(base)}`);
}

function timingSafeEqualHex(a: string, b: string) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Round-trips through JSON so the hashed value is exactly what is stored and read back. */
function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeExportFormat(format: string | undefined): AuditExportFormat {
  const normalized = String(format || "jsonl").trim().toLowerCase();
  if (normalized === "json" || normalized === "csv" || normalized === "jsonl") {
    return normalized;
  }
  throw new Error(`Unsupported export format: ${format}`);
}

export function csvEscape(input: string) {
  let value = String(input ?? "");
  // Spreadsheet apps run cells that start with these characters as formulas.
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  if (value.includes(",") || value.includes("\"") || value.includes("\n") || value.includes("\r")) {
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

function sha256Hex(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Legacy canonical form (version 1 records and argsHash). Do not change: stored hashes depend on it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const props = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${props.join(",")}}`;
}

/** Canonical form for keyed records: keys sorted by code unit, undefined members omitted. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
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
