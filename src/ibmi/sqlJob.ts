import { EventEmitter } from "events";
import net from "net";
import tls from "tls";
import type { NodeSSH } from "node-ssh";
import { Tools } from "./Tools.js";
import { splitSqlStatements, isReadOnlySql } from "./sqlParse.js";
import { checkCertificate, certificateFingerprint } from "./knownHosts.js";
import {
  desiredLibraryList,
  existingLibrariesSql,
  invalidNamesWarning,
  libraryListCommand,
  libraryNamesFromRows,
  referencedLibraries,
  resolveAgainstExisting
} from "./libraryList.js";
import type { CommandData, CommandResult, ConnectionConfig } from "./types.js";

/**
 * Persistent SQL job for one connection, backed by Mapepire.
 *
 * Without it every SQL statement and every CL command run through SQL starts a
 * new QZDFMDB2 job over SSH, so library list changes, the current library,
 * QTEMP and the job log are lost between calls. With Mapepire installed on the
 * IBM i, one long-lived database job is opened lazily on the first SQL call and
 * reused until the connection closes. When Mapepire is not available the
 * client falls back to QZDFMDB2 (unless sqlTransport is "mapepire").
 *
 * Library list. Mapepire single mode (over SSH) starts with the in-process
 * CLI technique: the JDBC properties are ignored (so SQL naming) and each SQL
 * request runs on a new thread of the server job. On IBM i the library list
 * belongs to the thread, so a CHGLIBL run as `CALL QSYS2.QCMDEXC` in a SQL
 * request is gone when the request ends. The job is therefore switched to the
 * TCP technique right after it starts (a database host server job, as in
 * daemon mode), where the properties apply and the library list persists. If
 * that is not possible the CLI technique is kept, and CL still lasts there
 * when it is sent as a CL request (SQLJob.clcommand): those run on the
 * dispatcher thread, whose library list later SQL threads inherit. So every
 * CL command goes through clcommand, including `@` lines and literal
 * `CALL QCMDEXC('...')` statements, and the connection's configured library
 * list is applied that way before the first statement and again whenever the
 * setting changes.
 */

export type SqlTransportSetting = "auto" | "mapepire" | "qzdfmdb2";
export type MapepireModeSetting = "auto" | "daemon" | "ssh";

export const DEFAULT_MAPEPIRE_PORT = 8076;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;
const DEFAULT_CANCEL_GRACE_MS = 5000;
const DEFAULT_OPEN_WAIT_MS = 10000;
const FETCH_SIZE = 1000;

const MAPEPIRE_SERVER_PATHS = [
  "/QOpenSys/pkgs/lib/mapepire/mapepire-server.jar",
  "/opt/mapepire/lib/mapepire/mapepire-server.jar"
];
const JAVA_PATHS = [
  "/QOpenSys/QIBM/ProdData/JavaVM/jdk21/64bit/bin/java",
  "/QOpenSys/QIBM/ProdData/JavaVM/jdk17/64bit/bin/java",
  "/QOpenSys/QIBM/ProdData/JavaVM/jdk11/64bit/bin/java",
  "/QOpenSys/QIBM/ProdData/JavaVM/jdk80/64bit/bin/java"
];

/**
 * JDBC properties for the job. System naming makes unqualified names resolve
 * through the library list (like a 5250 session); commitment control is off so
 * writes to files that are not journaled behave as they do under QZDFMDB2.
 */
const JDBC_OPTIONS = {
  naming: "system",
  "transaction isolation": "none",
  "date format": "iso",
  "time format": "iso"
} as const;

const NUMERIC_TYPES = new Set(["DECIMAL", "NUMERIC", "INTEGER", "SMALLINT", "BIGINT", "DECFLOAT", "DOUBLE", "REAL", "FLOAT"]);

export interface SqlJobColumn {
  name: string;
  type?: string;
}

export interface SqlJobStatementResult {
  rows: Record<string, unknown>[];
  columns?: SqlJobColumn[];
  updateCount?: number;
}

/** One open database job. The real one wraps a Mapepire SQLJob; tests use fakes. */
export interface SqlJobHandle {
  /** Qualified IBM i job name (number/user/name), when the server reports it. */
  readonly jobName?: string;
  readonly mode: "daemon" | "ssh";
  /**
   * How the server reaches Db2: "tcp" is a database host server job
   * (QZDASOINIT) that honours the JDBC properties; "cli" is the in-process CLI
   * connection single mode starts with, which ignores them (SQL naming).
   */
  readonly technique?: "tcp" | "cli";
  isAlive(): boolean;
  /**
   * Runs one statement and fetches every row. When `signal` aborts, fetching
   * stops and the server-side cursor is closed.
   */
  run(sql: string, options: { parameters?: Array<string | number | null>; signal?: AbortSignal }): Promise<SqlJobStatementResult>;
  /**
   * Runs a CL command where its effect on the library list lasts (Mapepire's
   * CL request). Without it, CL runs as CALL QSYS2.QCMDEXC through run().
   */
  runCl?(command: string, options: { signal?: AbortSignal }): Promise<SqlJobClResult>;
  close(): Promise<void>;
}

export interface SqlJobClMessage {
  id?: string;
  type?: string;
  text: string;
}

export interface SqlJobClResult {
  success: boolean;
  /** Job log messages the command sent. */
  messages: SqlJobClMessage[];
}

/** A CL command failed; the message carries its diagnostic and escape messages. */
export class ClCommandError extends Tools.SqlError {
  constructor(readonly command: string, readonly messages: SqlJobClMessage[]) {
    super(clFailureText(command, messages));
    this.name = "ClCommandError";
    this.sqlstate = "38501";
  }
}

function clFailureText(command: string, messages: SqlJobClMessage[]) {
  const relevant = messages.filter(m => /^(ESC|DIAG)/i.test(m.type || ""));
  const detail = (relevant.length ? relevant : messages).map(m => (m.id ? `${m.id}: ${m.text}` : m.text)).join(" ");
  return `${command.trim().split(/\s+/)[0]} failed${detail ? `: ${detail}` : ""}`;
}

/** Messages from the server's own machinery that say nothing about the command. */
export function isNoiseMessage(message: SqlJobClMessage) {
  return message.id === "MCH3401" && /\bPPTT\b/.test(message.text);
}

const QCMDEXC_CALL = /^CALL\s+(?:(?:QSYS2|QSYS)\s*[./]\s*)?QCMDEXC\s*\(\s*'((?:[^']|'')*)'\s*(?:,\s*\d+(?:\.\d*)?\s*)?\)\s*$/i;

/** The CL command of `CALL QSYS2.QCMDEXC('...')` with a literal, else undefined. */
export function qcmdexcLiteral(statement: string): string | undefined {
  const match = statement.trim().match(QCMDEXC_CALL);
  return match ? match[1].replace(/''/g, "'") : undefined;
}

export interface SqlJobOpenRequest {
  host: string;
  username: string;
  password?: string;
  /** The connection's SSH client, used by the "ssh" mode (Mapepire single mode). */
  ssh?: NodeSSH;
  mode: MapepireModeSetting;
  port: number;
  serverPath?: string;
  javaPath?: string;
  probeTimeoutMs: number;
  sendCommand: (options: CommandData) => Promise<CommandResult>;
}

export type SqlJobFactory = (request: SqlJobOpenRequest) => Promise<SqlJobHandle>;

/** Mapepire is not installed, not running or not reachable: falling back is fine. */
export class SqlJobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlJobUnavailableError";
  }
}

export interface SqlJobStatus {
  transport: SqlTransportSetting;
  /** What SQL currently runs through. */
  active: "mapepire" | "qzdfmdb2" | "not-started";
  mode?: "daemon" | "ssh";
  technique?: "tcp" | "cli";
  jobName?: string;
  /** Why the persistent job is not used for this connection (cached until reconnect). */
  unavailableReason?: string;
  lastError?: string;
  libraryListWarning?: string;
  lastCancel?: string;
}

export interface PersistentSqlJobOptions {
  getConfig: () => ConnectionConfig;
  /** Undefined while the client is not connected: SQL then uses QZDFMDB2. */
  getOpenRequest: () => SqlJobOpenRequest | undefined;
  factory?: SqlJobFactory;
  /** Asks the IBM i to cancel the statement running in a job (QSYS2.CANCEL_SQL from another job). */
  cancelStatement?: (jobName: string) => Promise<void>;
  cancelGraceMs?: number;
  /** auto mode: how long a call waits for the job to open before using QZDFMDB2 for that call. */
  openWaitMs?: number;
  /** Library list warning from the QZDFMDB2 path, shown when that path is in use. */
  fallbackLibraryListWarning?: () => string | undefined;
}

export function normalizeSqlTransport(value: unknown): SqlTransportSetting {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "mapepire" || v === "qzdfmdb2" ? v : "auto";
}

export function normalizeMapepireMode(value: unknown): MapepireModeSetting {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "daemon" || v === "ssh" ? v : "auto";
}

const JOB_NAME_RE = /^\d{6}\/[A-Z0-9#@$_.]{1,10}\/[A-Z0-9#@$_.]{1,10}$/i;

export function isQualifiedJobName(value: unknown): value is string {
  return typeof value === "string" && JOB_NAME_RE.test(value);
}

/** Rows plus the number of rows changed by INSERT/UPDATE/DELETE, when known. */
export type SqlRows = Tools.DB2Row[] & { updateCount?: number };

export class PersistentSqlJob {
  private handle?: SqlJobHandle;
  private opening?: Promise<SqlJobHandle | undefined>;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailableReason?: string;
  private lastError?: string;
  private libraryListWarning?: string;
  private lastCancel?: string;
  /** The configured library list last applied, and to which job. */
  private appliedLibraryList?: { handle: SqlJobHandle; signature: string };
  private closed = false;
  private readonly factory: SqlJobFactory;

  constructor(private readonly options: PersistentSqlJobOptions) {
    this.factory = options.factory || mapepireJobFactory;
  }

  private transport() {
    return normalizeSqlTransport(this.options.getConfig().sqlTransport);
  }

  status(): SqlJobStatus {
    const transport = this.transport();
    const live = this.handle && this.handle.isAlive() ? this.handle : undefined;
    let active: SqlJobStatus["active"] = "not-started";
    if (transport === "qzdfmdb2" || (transport === "auto" && this.unavailableReason)) active = "qzdfmdb2";
    else if (live) active = "mapepire";
    const libraryListWarning = active === "qzdfmdb2"
      ? this.options.fallbackLibraryListWarning?.()
      : this.libraryListWarning ?? this.options.fallbackLibraryListWarning?.();
    return {
      transport,
      active,
      ...(live ? { mode: live.mode, ...(live.technique ? { technique: live.technique } : {}), jobName: live.jobName } : {}),
      ...(this.unavailableReason ? { unavailableReason: this.unavailableReason } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(libraryListWarning ? { libraryListWarning } : {}),
      ...(this.lastCancel ? { lastCancel: this.lastCancel } : {})
    };
  }

  /** True when the persistent job is open and alive. */
  isOpen() {
    return Boolean(this.handle && this.handle.isAlive());
  }

  /**
   * Runs SQL (one or more statements, `@` lines run as CL) in the persistent
   * job. Returns undefined when the caller should use QZDFMDB2 instead.
   */
  async runSql(statements: string, options: { signal?: AbortSignal } = {}): Promise<SqlRows | undefined> {
    const handle = await this.acquire();
    if (!handle) return undefined;
    try {
      return await this.exclusive(options.signal, async () => {
        await this.ensureLibraryList(handle);
        return this.runAll(handle, statements, options.signal);
      });
    } catch (err) {
      // The job died under a read: nothing was changed, so reopen and retry once.
      if (!handle.isAlive() && !options.signal?.aborted && isReadOnlySql(statements)) {
        await this.discard(handle);
        const next = await this.acquire();
        if (!next) return undefined;
        return this.exclusive(options.signal, async () => {
          await this.ensureLibraryList(next);
          return this.runAll(next, statements, options.signal);
        });
      }
      if (!handle.isAlive()) await this.discard(handle);
      throw err;
    }
  }

  /**
   * Runs a CL command in the persistent job. Returns undefined when the job is
   * not used, otherwise the job log messages the command sent.
   */
  async runCl(command: string, options: { signal?: AbortSignal } = {}): Promise<SqlJobClMessage[] | undefined> {
    const handle = await this.acquire();
    if (!handle) return undefined;
    try {
      return await this.exclusive(options.signal, async () => {
        await this.ensureLibraryList(handle);
        return this.execCl(handle, command, options.signal);
      });
    } catch (err) {
      if (!handle.isAlive()) await this.discard(handle);
      throw err;
    }
  }

  async close() {
    this.closed = true;
    const opening = this.opening;
    if (opening) await opening.catch(() => undefined);
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.close().catch(() => undefined);
  }

  private async acquire(): Promise<SqlJobHandle | undefined> {
    if (this.closed) return undefined;
    const transport = this.transport();
    if (transport === "qzdfmdb2") {
      if (this.handle) await this.discard(this.handle);
      return undefined;
    }
    if (this.handle) {
      if (this.handle.isAlive()) return this.handle;
      this.lastError = "The persistent SQL job ended; a new job was opened.";
      await this.discard(this.handle);
    }
    if (transport === "auto" && this.unavailableReason) return undefined;
    if (!this.opening) {
      this.opening = this.open(transport).finally(() => {
        this.opening = undefined;
      });
    }
    if (transport === "mapepire") return this.opening;
    // In auto mode a slow start (single mode starts a JVM) must not eat the
    // caller's timeout: this call uses QZDFMDB2 and the job keeps opening.
    const waitMs = this.options.openWaitMs ?? DEFAULT_OPEN_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.opening,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async open(transport: SqlTransportSetting): Promise<SqlJobHandle | undefined> {
    const request = this.options.getOpenRequest();
    if (!request) {
      if (transport === "mapepire") throw new Error("Not connected");
      return undefined;
    }
    let handle: SqlJobHandle;
    try {
      handle = await this.factory(request);
    } catch (err: any) {
      const message = err?.message || String(err);
      this.lastError = message;
      if (transport === "mapepire") {
        throw new Error(`Mapepire SQL job could not be opened (sqlTransport is "mapepire"): ${message}`);
      }
      // Cached for this connection: later SQL goes straight to QZDFMDB2.
      this.unavailableReason = message;
      return undefined;
    }
    if (this.closed) {
      await handle.close().catch(() => undefined);
      return undefined;
    }
    this.handle = handle;
    this.unavailableReason = undefined;
    return handle;
  }

  /**
   * Applies the connection's configured library list again, even when it was
   * applied before. Returns undefined when the persistent job is not used.
   */
  async reapplyLibraryList(): Promise<{ warning?: string } | undefined> {
    const handle = await this.acquire();
    if (!handle) return undefined;
    return this.exclusive(undefined, async () => {
      this.appliedLibraryList = undefined;
      await this.ensureLibraryList(handle);
      return this.libraryListWarning ? { warning: this.libraryListWarning } : {};
    });
  }

  /**
   * Puts the connection's configured library list and current library in
   * effect in the job, unless that list was already applied to this job. Runs
   * inside the queue. A failure never fails the caller's statement: missing
   * libraries are left out and the reason is kept for the session status.
   */
  private async ensureLibraryList(handle: SqlJobHandle) {
    const desired = desiredLibraryList(this.options.getConfig());
    const applied = this.appliedLibraryList;
    if (applied && applied.handle === handle && applied.signature === desired.signature) return;
    // Recorded first, so a list that cannot be applied is not retried on every call.
    this.appliedLibraryList = { handle, signature: desired.signature };
    this.libraryListWarning = invalidNamesWarning(desired);
    const command = libraryListCommand(desired.libraries, desired.currentLibrary);
    if (!command) return;
    try {
      await this.execCl(handle, command);
      return;
    } catch (err: any) {
      if (!handle.isAlive()) throw err;
      const firstError = err?.message || String(err);
      try {
        const names = referencedLibraries(desired);
        const result = await this.runStatement(handle, existingLibrariesSql(names)).catch(err => {
          if (!handle.isAlive()) throw err;
          // Older releases do not know *ALLSIMPLE.
          return this.runStatement(handle, existingLibrariesSql(names, false));
        });
        const resolved = resolveAgainstExisting(desired, libraryNamesFromRows(result.rows));
        if (!resolved.warning) {
          this.libraryListWarning = `${command} failed in the SQL job: ${firstError}`;
          return;
        }
        if (resolved.command) await this.execCl(handle, resolved.command);
        this.libraryListWarning = resolved.warning;
      } catch (retryErr: any) {
        if (!handle.isAlive()) throw retryErr;
        this.libraryListWarning = `${command} failed in the SQL job: ${firstError}`;
      }
    }
  }

  /** Runs CL so that its library list changes last (see the note at the top). */
  private async execCl(handle: SqlJobHandle, command: string, signal?: AbortSignal): Promise<SqlJobClMessage[]> {
    if (!handle.runCl) {
      await this.runStatement(handle, "CALL QSYS2.QCMDEXC(?)", [command], signal);
      return [];
    }
    const result = await this.withCancel(handle, handle.runCl(command, { signal }), signal);
    const messages = (result.messages || []).filter(m => !isNoiseMessage(m));
    if (!result.success) throw new ClCommandError(command, messages);
    return messages;
  }

  private async discard(handle: SqlJobHandle) {
    if (this.handle === handle) this.handle = undefined;
    await handle.close().catch(() => undefined);
  }

  /** Statements share one job, so they run one at a time. */
  private exclusive<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (signal?.aborted) throw new Error("SQL statement cancelled before it started");
      return task();
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runAll(handle: SqlJobHandle, statements: string, signal?: AbortSignal): Promise<SqlRows> {
    const rows: SqlRows = [];
    let updateCount: number | undefined;
    for (const statement of splitSqlStatements(statements)) {
      if (signal?.aborted) throw new Error("SQL statement cancelled");
      const isCl = statement.tokens.length === 1 && statement.tokens[0].type === "cl";
      const clCommand = isCl ? statement.tokens[0].value : qcmdexcLiteral(statement.text);
      if (clCommand !== undefined) {
        await this.execCl(handle, clCommand, signal);
        continue;
      }
      const result = await this.runStatement(handle, statement.text, undefined, signal);
      rows.push(...result.rows);
      if (typeof result.updateCount === "number" && result.updateCount >= 0) {
        updateCount = (updateCount ?? 0) + result.updateCount;
      }
    }
    if (updateCount !== undefined) {
      Object.defineProperty(rows, "updateCount", { value: updateCount, enumerable: false });
    }
    return rows;
  }

  private async runStatement(handle: SqlJobHandle, sql: string, parameters?: Array<string | number | null>, signal?: AbortSignal) {
    const work = handle.run(sql, { parameters, signal }).then(
      result => ({ rows: result.rows.map(row => normalizeRow(row, result.columns)), updateCount: result.updateCount }),
      err => { throw toSqlError(err, sql); }
    );
    return this.withCancel(handle, work, signal);
  }

  /** When `signal` aborts while `work` runs, the statement is cancelled on the IBM i. */
  private async withCancel<T>(handle: SqlJobHandle, work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) {
      void this.cancelInFlight(handle, work);
      return work;
    }
    const onAbort = () => { void this.cancelInFlight(handle, work); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await work;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The caller timed out: ask the IBM i to cancel the statement (QSYS2.CANCEL_SQL
   * from a separate job). If it is still running after a grace period, end the
   * persistent job; the next call opens a new one and reapplies the library list.
   */
  private async cancelInFlight(handle: SqlJobHandle, work: Promise<unknown>) {
    let done = false;
    const settled = work.then(() => { done = true; }, () => { done = true; });
    const notes: string[] = [];
    if (handle.jobName && isQualifiedJobName(handle.jobName) && this.options.cancelStatement) {
      try {
        await this.options.cancelStatement(handle.jobName);
        notes.push(`CANCEL_SQL requested for ${handle.jobName}`);
      } catch (err: any) {
        notes.push(`CANCEL_SQL failed: ${err?.message || String(err)}`);
      }
    }
    if (!done) {
      const grace = this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, grace); })]);
      if (timer) clearTimeout(timer);
    }
    if (!done) {
      notes.push("statement still running; the SQL job was ended and will be reopened on the next call");
      await this.discard(handle);
    }
    this.lastCancel = `${new Date().toISOString()}: ${notes.join("; ") || "cancelled"}`;
  }
}

/** Mapepire values to the row shape QZDFMDB2 parsing produces (trimmed strings, numbers, null). */
export function normalizeRow(row: Record<string, unknown>, columns?: SqlJobColumn[]): Tools.DB2Row {
  const types = new Map<string, string>();
  for (const column of columns || []) {
    if (column?.name) types.set(column.name, String(column.type || "").toUpperCase());
  }
  const out: Tools.DB2Row = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null) {
      out[key] = null;
    } else if (typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "string") {
      const type = types.get(key);
      if (type && NUMERIC_TYPES.has(type) && value.trim() !== "" && Number.isFinite(Number(value))) {
        out[key] = Number(value);
      } else {
        out[key] = value.trimEnd();
      }
    } else if (typeof value === "boolean") {
      out[key] = value ? "true" : "false";
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

/** Mapepire errors look like "<message>, <SQLSTATE>, <SQLCODE>". */
export function toSqlError(err: any, sql: string): Error {
  if (err instanceof Tools.SqlError) return err;
  const message = String(err?.message || err || "SQL error");
  const match = message.match(/^(.*), ([0-9A-Z]{5}), (-?\d+)$/s);
  if (!match) return err instanceof Error ? err : new Error(message);
  const sqlError = new Tools.SqlError(`${match[1]} (${match[2]})`);
  sqlError.sqlstate = match[2];
  sqlError.cause = sql;
  return sqlError;
}

// ---------------------------------------------------------------------------
// Mapepire-backed job factory
// ---------------------------------------------------------------------------

type MapepireModule = any;
let mapepireModule: Promise<MapepireModule> | undefined;

async function loadMapepire(): Promise<MapepireModule> {
  if (!mapepireModule) {
    mapepireModule = import("@ibm/mapepire-js").then((m: any) => m.default ?? m);
    mapepireModule.catch(() => { mapepireModule = undefined; });
  }
  try {
    return await mapepireModule;
  } catch (err: any) {
    throw new SqlJobUnavailableError(`The @ibm/mapepire-js package could not be loaded: ${err?.message || String(err)}`);
  }
}

/**
 * Opens a Mapepire job. "daemon" connects to the Mapepire server (port 8076,
 * TLS, user and password). "ssh" starts mapepire-server in single mode over the
 * connection's own SSH session, so it also works with key-based logins and
 * needs no open port, only the server JAR and Java on the IBM i. "auto" uses
 * the daemon when a password is available and falls back to ssh.
 */
export const mapepireJobFactory: SqlJobFactory = async (request) => {
  const mapepire = await loadMapepire();
  const mode = request.mode;
  if (mode === "daemon" || (mode === "auto" && request.password)) {
    try {
      return await openDaemonJob(mapepire, request);
    } catch (err) {
      if (mode === "daemon" || !(err instanceof SqlJobUnavailableError) || !request.ssh) throw err;
      try {
        return await openSshJob(mapepire, request);
      } catch (sshErr: any) {
        throw new SqlJobUnavailableError(`${(err as Error).message}; single mode over SSH: ${sshErr?.message || String(sshErr)}`);
      }
    }
  }
  return openSshJob(mapepire, request);
};

async function openDaemonJob(mapepire: MapepireModule, request: SqlJobOpenRequest): Promise<SqlJobHandle> {
  if (!request.password) {
    throw new SqlJobUnavailableError("The Mapepire server needs a password; this connection has none (use mapepireMode \"ssh\")");
  }
  const pin = await resolveCertificatePin(request.host, request.port, request.probeTimeoutMs);
  const transport = new PinnedWebSocketTransport(pin, request.probeTimeoutMs * 2);
  const job = new mapepire.SQLJob({ ...JDBC_OPTIONS }, transport);
  try {
    await job.connect({ host: request.host, port: request.port, user: request.username, password: request.password }, "mcp-for-i");
  } catch (err) {
    await Promise.resolve(job.close()).catch(() => undefined);
    throw err;
  }
  return wrapMapepireJob(job, "daemon", () => transport.isConnected());
}

async function openSshJob(mapepire: MapepireModule, request: SqlJobOpenRequest): Promise<SqlJobHandle> {
  if (!request.ssh) throw new SqlJobUnavailableError("No SSH session for Mapepire single mode");
  const serverPath = await findRemoteFile(request, request.serverPath ? [request.serverPath] : MAPEPIRE_SERVER_PATHS);
  if (!serverPath) {
    throw new SqlJobUnavailableError(
      `mapepire-server.jar not found (${(request.serverPath ? [request.serverPath] : MAPEPIRE_SERVER_PATHS).join(", ")}); install it with "yum install mapepire-server"`
    );
  }
  const javaPath = await findRemoteFile(request, request.javaPath ? [request.javaPath] : JAVA_PATHS);
  if (!javaPath) throw new SqlJobUnavailableError("No Java runtime found for Mapepire single mode (set mapepireJavaPath)");
  const start = async () => {
    const job = mapepire.SQLJob.withConfig({
      transport: "ssh-single",
      sshSingle: {
        exec: mapepire.createNodeSSHExec(request.ssh),
        serverPath,
        javaPath,
        startupTimeout: 60000
      }
    }, { ...JDBC_OPTIONS });
    try {
      await job.connect(undefined, "mcp-for-i");
    } catch (err) {
      await Promise.resolve(job.close()).catch(() => undefined);
      throw err;
    }
    return job;
  };
  const wrap = (job: any, technique: "tcp" | "cli") => wrapMapepireJob(job, "ssh", () => {
    try {
      return Boolean(job.getTransport()?.isConnected());
    } catch {
      return false;
    }
  }, technique);

  // Single mode connects with the in-process CLI technique, which ignores the
  // JDBC properties (so SQL naming, and unqualified names do not use the
  // library list) and runs each SQL request on its own thread, so library
  // list changes do not last. Switch the server to the TCP technique: a
  // database host server job on the same system, signed on as the same user,
  // with system naming and a library list that persists.
  const job = await start();
  try {
    const response: any = await job.send({
      id: mapepire.SQLJob.getNewUniqueId(),
      type: "connect",
      technique: "tcp",
      application: "mcp-for-i",
      props: jdbcPropertiesString(JDBC_OPTIONS)
    });
    if (response?.success === true) {
      if (typeof response.job === "string") job.id = response.job;
      return wrap(job, "tcp");
    }
    throw new Error(response?.error || "connect failed");
  } catch {
    // The failed reconnect may have dropped the CLI connection: start again.
    await Promise.resolve(job.close()).catch(() => undefined);
  }
  return wrap(await start(), "cli");
}

/** JDBC properties as Mapepire's connect request carries them. */
export function jdbcPropertiesString(options: Record<string, string | string[]>) {
  return Object.entries(options).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`).join(";");
}

/** Mapepire reports single-mode CLI jobs as number-user-name. */
export function normalizeJobName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const dashed = value.match(/^(\d{6})-([^-/]{1,10})-([^-/]{1,10})$/);
  return dashed ? `${dashed[1]}/${dashed[2]}/${dashed[3]}` : value;
}

async function findRemoteFile(request: SqlJobOpenRequest, candidates: string[]) {
  const script = candidates
    .map(p => `if [ -f ${Tools.shellQuote(p)} ]; then echo ${Tools.shellQuote(p)}; exit 0; fi`)
    .join("; ");
  try {
    const result = await request.sendCommand({ command: `${script}; exit 1` });
    const found = result.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    return found && candidates.includes(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

function wrapMapepireJob(job: any, mode: "daemon" | "ssh", connected: () => boolean, technique: "tcp" | "cli" = "tcp"): SqlJobHandle {
  // SQLJob.close() drops its response listeners, so requests still waiting on
  // the job would never settle. Track them and fail them on close.
  const pending = new Set<(err: Error) => void>();
  let closed = false;

  const runQuery = async (sql: string, options: { parameters?: Array<string | number | null>; signal?: AbortSignal }) => {
    const query = job.query(sql, options.parameters ? { parameters: options.parameters } : {});
    let result = await query.execute(FETCH_SIZE);
    const rows: Record<string, unknown>[] = Array.isArray(result.data) ? [...result.data] : [];
    const columns = (result.metadata?.columns || []).map((c: any) => ({ name: c.name || c.label, type: c.type }));
    while (result.has_results && !result.is_done) {
      if (options.signal?.aborted) {
        await Promise.resolve(query.close()).catch(() => undefined);
        throw new Error("SQL statement cancelled");
      }
      result = await query.fetchMore(FETCH_SIZE);
      if (Array.isArray(result.data)) rows.push(...result.data);
    }
    const updateCount = result.has_results ? undefined : result.update_count;
    return { rows, columns, updateCount: typeof updateCount === "number" ? updateCount : undefined };
  };

  // A CL request answers with the job log messages the command sent, and
  // success false when it failed; it does not reject.
  const runClCommand = async (command: string): Promise<SqlJobClResult> => {
    const query = job.clcommand(command);
    const result = await query.execute(FETCH_SIZE);
    if (result.has_results && !result.is_done) await Promise.resolve(query.close()).catch(() => undefined);
    const rows: any[] = Array.isArray(result.data) ? result.data : [];
    const messages: SqlJobClMessage[] = rows.map(row => ({
      id: row.MESSAGE_ID ? String(row.MESSAGE_ID).trim() : undefined,
      type: row.MESSAGE_TYPE ? String(row.MESSAGE_TYPE).trim() : undefined,
      text: String(row.MESSAGE_TEXT ?? row.SUMMARY ?? "").trim()
    }));
    if (result.success === false && messages.length === 0 && result.error) {
      messages.push({ type: "ESCAPE", text: String(result.error) });
    }
    return { success: result.success !== false, messages };
  };

  return {
    mode,
    technique,
    get jobName() {
      return normalizeJobName(job.id);
    },
    isAlive() {
      if (closed) return false;
      const status = String(job.getStatus?.() ?? "");
      return status !== "ended" && status !== "notStarted" && connected();
    },
    run(sql, options) {
      if (closed) return Promise.reject(new Error("SQL job closed"));
      return new Promise((resolve, reject) => {
        pending.add(reject);
        runQuery(sql, options).then(resolve, reject).finally(() => pending.delete(reject));
      });
    },
    runCl(command) {
      if (closed) return Promise.reject(new Error("SQL job closed"));
      return new Promise((resolve, reject) => {
        pending.add(reject);
        runClCommand(command).then(resolve, reject).finally(() => pending.delete(reject));
      });
    },
    async close() {
      closed = true;
      const error = new Error("SQL job closed");
      for (const reject of pending) reject(error);
      pending.clear();
      await job.close();
    }
  };
}

// ---------------------------------------------------------------------------
// TLS: trust on first use for the Mapepire server certificate
// ---------------------------------------------------------------------------

export interface CertificatePin {
  host: string;
  port: number;
  /** PEM of the pinned root certificate; undefined when the root is a public CA. */
  ca?: string;
  /** "SHA256:..." of the pinned certificate. */
  fingerprint?: string;
}

/**
 * Reads the server certificate chain (no credentials are sent on this
 * connection). A chain that ends in a publicly trusted CA is verified the
 * normal way. Otherwise (self-signed, as Mapepire generates by default, or a
 * private CA) the root is pinned on first use in known_hosts.json and must
 * match on every later connection.
 */
export async function resolveCertificatePin(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<CertificatePin> {
  const leaf = await fetchCertificateChain(host, port, timeoutMs);
  const root = findRootCertificate(leaf);
  const pem = derToPem(root.raw);
  const isPublic = tls.rootCertificates.some(ca => ca.replace(/\s+/g, "") === pem.replace(/\s+/g, ""));
  if (isPublic) return { host, port };
  const subject = root.subject ? Object.entries(root.subject).map(([k, v]) => `${k}=${v}`).join(", ") : undefined;
  const { fingerprint } = await checkCertificate({ host, port, der: root.raw, subject });
  return { host, port, ca: pem, fingerprint };
}

function fetchCertificateChain(host: string, port: number, timeoutMs: number): Promise<tls.DetailedPeerCertificate> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    // Chain verification happens later against the pinned certificate; this
    // connection only reads the certificate and sends nothing.
    const socket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false
    });
    const timer = setTimeout(() => {
      finish(() => reject(new SqlJobUnavailableError(`Mapepire server not reachable on ${host}:${port} (no answer in ${timeoutMs}ms)`)));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(true);
      finish(() => {
        if (!cert || !cert.raw) reject(new Error(`Mapepire server on ${host}:${port} presented no certificate`));
        else resolve(cert);
      });
    });
    socket.once("error", (err: any) => {
      finish(() => {
        const code = err?.code ? ` (${err.code})` : "";
        reject(new SqlJobUnavailableError(`Mapepire server not reachable on ${host}:${port}${code}: ${err?.message || String(err)}`));
      });
    });
  });
}

function findRootCertificate(leaf: tls.DetailedPeerCertificate): tls.DetailedPeerCertificate {
  let current = leaf;
  const seen = new Set<string>();
  while (current.issuerCertificate && current.issuerCertificate !== current) {
    const fp = current.fingerprint256;
    if (seen.has(fp)) break;
    seen.add(fp);
    if (!current.issuerCertificate.raw) break;
    current = current.issuerCertificate;
  }
  return current;
}

export function derToPem(der: Buffer) {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** True when the presented chain contains the pinned certificate. */
export function chainHasFingerprint(cert: tls.PeerCertificate | tls.DetailedPeerCertificate | undefined, fingerprint: string) {
  let current: any = cert;
  const seen = new Set<any>();
  while (current && current.raw && !seen.has(current)) {
    seen.add(current);
    if (certificateFingerprint(current.raw) === fingerprint) return true;
    current = current.issuerCertificate;
  }
  return false;
}

/**
 * WebSocket transport for Mapepire's SQLJob (same protocol as the library's
 * WebSocketTransport) that verifies the server against the pinned certificate.
 * The chain must validate against the pinned root and contain it; the host
 * name is not compared because Mapepire's self-signed certificate rarely
 * matches the name or address used to connect. Without a pin the normal CA and
 * host name checks apply. Certificate errors are never ignored.
 */
export class PinnedWebSocketTransport {
  private socket: any;
  private connected = false;
  private responseEmitter = new EventEmitter();

  constructor(private readonly pin: CertificatePin, private readonly timeoutMs = 8000) {}

  async connect(server: { host: string; port?: number; user?: string; password?: string }): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const host = server.host;
    const port = server.port || DEFAULT_MAPEPIRE_PORT;
    const urlHost = net.isIPv6(host) ? `[${host}]` : host;
    const fingerprint = this.pin.fingerprint;
    const options: Record<string, unknown> = {
      headers: {
        authorization: `Basic ${Buffer.from(`${server.user}:${server.password}`).toString("base64")}`
      },
      handshakeTimeout: this.timeoutMs,
      rejectUnauthorized: true
    };
    if (this.pin.ca && fingerprint) {
      options.ca = this.pin.ca;
      options.allowPartialTrustChain = true;
      options.checkServerIdentity = (_host: string, cert: tls.PeerCertificate) =>
        chainHasFingerprint(cert, fingerprint)
          ? undefined
          : new Error(`Mapepire server certificate does not match the pinned certificate ${fingerprint}`);
    }
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(`wss://${urlHost}:${port}/db/`, options as any);
      ws.on("error", (err: Error) => {
        if (!opened) reject(err);
      });
      ws.on("message", (data: Buffer) => {
        let response: any;
        try {
          response = JSON.parse(data.toString(), ((_key: string, value: unknown, context?: { source?: string }) => {
            // Keep the server's exact text for numbers JavaScript would round.
            if (context && typeof value === "number" && context.source !== undefined && String(value) !== context.source) {
              return context.source;
            }
            return value;
          }) as any);
        } catch {
          return;
        }
        if (response && typeof response.id === "string") this.responseEmitter.emit(response.id, response);
      });
      ws.on("close", (code: number, reason: Buffer) => {
        this.connected = false;
        this.notifyConnectionFailure(code, reason?.toString() || "");
        if (!opened) reject(new Error(`Mapepire connection closed (${code})`));
      });
      ws.once("open", () => {
        opened = true;
        this.socket = ws;
        this.connected = true;
        resolve();
      });
    });
  }

  async send(request: { id: string }): Promise<void> {
    if (!this.socket || !this.connected) {
      // Fail the waiting request instead of leaving it pending.
      setImmediate(() => this.responseEmitter.emit(`${request.id}_conn_fail`, new Error("Mapepire connection is not open")));
      return;
    }
    this.socket.send(JSON.stringify(request));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) socket.close();
    this.notifyConnectionFailure(1000, "closed");
  }

  getResponseEmitter() {
    return this.responseEmitter;
  }

  isConnected() {
    return this.connected;
  }

  enableTrace() {}

  disableTrace() {}

  private notifyConnectionFailure(code: number, reason: string) {
    const events = this.responseEmitter.eventNames().filter(e => typeof e === "string" && e.endsWith("_conn_fail"));
    for (const event of events) {
      this.responseEmitter.emit(event, new Error(`Connection failed with code ${code}${reason ? `: ${reason}` : ""}`));
    }
    this.responseEmitter.removeAllListeners();
  }
}
