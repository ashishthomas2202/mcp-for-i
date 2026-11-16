import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { clampNumber, enforceWritable, getConnectionName, json, noteServerEndedJob, runClCommand } from "../tools.js";
import { Tools } from "../../ibmi/Tools.js";
import { checkClCommand, checkLibrary } from "../policy.js";
import { log } from "../logger.js";

/**
 * Test jobs that cannot be left behind, and jobs that wait on a message.
 *
 * A program run to try it out can ask a question (an inquiry message) nobody
 * is there to answer. Submitted with INQMSGRPY(*RQD) it waits for ever and
 * holds its job queue; with INQMSGRPY(*DFT) and a message that has no valid
 * default reply it can ask again and again and fill QSYSOPR. `ibmi.jobs.runTest`
 * submits the command as a batch job, watches it, and ends it at the first
 * question or when its time is up.
 *
 * `ibmi.jobs.waiting` lists the jobs working for the connection's user that
 * wait on a message; the same look is added to the result of tools that run
 * a program, because a job stuck that way cannot say so itself.
 *
 * What may be ended without asking is narrow, and every rule below serves it:
 * a job this server submitted in this call (found by name, user and the time
 * it entered the system, and only when exactly one job fits), and the
 * connection's own job when it is waiting on a question it asked. Nothing
 * here replies to a message.
 */

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TEST_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const DEFAULT_TEST_JOB_SECONDS = 120;
export const MAX_TEST_JOB_SECONDS = 3600;
/** One look at a job may take this long before it counts as failed. */
const LOOK_BUDGET_MS = 15000;
/** After this many looks in a row that failed, the watch is given up and the job is ended. */
const MAX_FAILED_LOOKS = 3;

const NAME = /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/;
const QUALIFIED_JOB = /^(\d{6})\/([A-Z#@$][A-Z0-9#@$_.]{0,9})\/([A-Z#@$][A-Z0-9#@$_.]{0,9})$/;
const DB_TIME = /^\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.\d{2}$/;

// ---------------------------------------------------------------------------
// Jobs this server submitted
// ---------------------------------------------------------------------------

const ownJobs = new Map<string, Set<string>>();

function key(connectionName: string | undefined) {
  return String(connectionName || "").trim().toLowerCase();
}

function qualified(value: unknown): string | undefined {
  const job = String(value ?? "").trim().toUpperCase();
  return QUALIFIED_JOB.test(job) ? job : undefined;
}

/** Record a job this server submitted on a connection, so ending it later is routine in host mode. */
export function rememberOwnJob(connectionName: string | undefined, jobName: string) {
  const job = qualified(jobName);
  if (!job) return;
  const k = key(connectionName);
  if (!ownJobs.has(k)) ownJobs.set(k, new Set());
  const set = ownJobs.get(k)!;
  set.add(job);
  // Job numbers wrap and are used again: only the most recent submits are kept.
  while (set.size > 200) set.delete(set.values().next().value as string);
}

export function isOwnJob(connectionName: string | undefined, jobName: string) {
  const job = qualified(jobName);
  return !!job && ownJobs.get(key(connectionName))?.has(job) === true;
}

export function ownJobList(connectionName: string | undefined) {
  return [...(ownJobs.get(key(connectionName)) ?? [])];
}

/** After a disconnect the name may come to mean another system or user: what was submitted before is forgotten. */
export function forgetOwnJobs(connectionName?: string) {
  if (connectionName === undefined) ownJobs.clear();
  else ownJobs.delete(key(connectionName));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "Job 123456/USER/NAME submitted to job queue ..." (CPC1221) → "123456/USER/NAME". */
export function parseSubmittedJob(text: unknown): string | undefined {
  const m = /\bJob\s+(\d{6}\/[A-Z#@$][A-Z0-9#@$_.]{0,9}\/[A-Z#@$][A-Z0-9#@$_.]{0,9})\s+submitted/i.exec(String(text ?? ""));
  return m ? m[1].toUpperCase() : undefined;
}

/** A job name nothing else is likely to have: "T", four characters of the time and three random ones. */
export function testJobName(now = Date.now(), random = Math.random()) {
  const time = Math.floor(now / 1000).toString(36).toUpperCase().slice(-4).padStart(4, "0");
  const salt = Math.floor(random * 46656).toString(36).toUpperCase().padStart(3, "0").slice(-3);
  return `T${time}${salt}`;
}

/**
 * The name a test job is submitted under: the caller's name (its first six
 * characters) or "T" and the time, always followed by random characters, so
 * no other job of the user is likely to share it.
 */
export function uniqueJobName(prefix?: string, now = Date.now(), random = Math.random()) {
  if (!prefix) return testJobName(now, random);
  const head = requireName(prefix, "jobName").slice(0, 6).replace(/\.+$/, "") || "T";
  const salt = Math.floor(random * 1679616).toString(36).toUpperCase().padStart(4, "0").slice(-4);
  return `${head}${salt}`;
}

function requireName(value: unknown, label: string) {
  const name = String(value ?? "").trim().toUpperCase();
  if (!NAME.test(name)) throw new Error(`Invalid ${label}: ${String(value)}`);
  return name;
}

function requireQualified(value: unknown, label: string) {
  const parts = String(value ?? "").trim().toUpperCase().split("/");
  if (parts.length === 1) return requireName(parts[0], label);
  if (parts.length !== 2) throw new Error(`Invalid ${label}: expected NAME or LIBRARY/NAME`);
  const library = parts[0] === "*LIBL" || parts[0] === "*CURLIB" ? parts[0] : requireName(parts[0], `${label} library`);
  return `${library}/${requireName(parts[1], label)}`;
}

/** Problems with CL text that is to go inside SBMJOB CMD(...), or undefined. */
export function clTextProblem(command: string): string | undefined {
  const text = String(command ?? "").trim();
  if (!text) return "command is required";
  if (/[\r\n]/.test(text)) return "command must be one CL command on one line";
  // A comment can hide a quote or a parenthesis from the check below and so close CMD( early,
  // which would let the text add its own SBMJOB parameters (USER, JOBQ, ...).
  if (text.includes("/*") || text.includes("*/")) return "command must not contain a CL comment (/* */)";
  // A quoted name can carry a parenthesis the same way.
  if (text.includes('"')) return 'command must not contain a double quote (")';
  if (/^\s*(?:[A-Z#@$][A-Z0-9#@$_]{0,9}\/)?SBMJOB\b/i.test(text)) return "command is what the job runs (for example CALL PGM(LIB/PGM)), not an SBMJOB";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      if (quoted && text[i + 1] === "'") i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) return "command has an unmatched )";
    }
  }
  if (quoted) return "command has an unmatched quote";
  if (depth !== 0) return "command has an unmatched (";
  return undefined;
}

/** True when CL text calls a program or submits a job: the commands after which a waiting job is looked for. */
export function runsProgram(command: string) {
  return /^\s*(?:[A-Z#@$][A-Z0-9#@$_]{0,9}\/)?(?:CALL|CALLPRC|SBMJOB)\b/i.test(String(command || ""));
}

/** True when a CL command gave up waiting, as opposed to failing. */
export function clTimedOut(result: { code: number | null; stderr?: string } | undefined) {
  return !!result && result.code !== 0 && /timed out/i.test(String(result.stderr || ""));
}

/** Whether a connection's policy lets this server end a job on its own. */
export function mayEndJobs(policy: { profile?: string } | undefined) {
  if (!policy) return true;
  if (policy.profile === "read-only") return false;
  try {
    return !checkClCommand(policy as any, "ENDJOB JOB(000000/A/B) OPTION(*IMMED)");
  } catch {
    return false;
  }
}

export type TestJobRequest = {
  command: string;
  jobName?: string;
  jobQueue?: string;
  jobDescription?: string;
  libraryList?: string[];
  currentLibrary?: string;
};

/** The SBMJOB for a test job. INQMSGRPY(*DFT): it never waits for a person; the watcher ends it if it asks at all. */
export function buildSubmitCommand(request: TestJobRequest, now = Date.now()) {
  const problem = clTextProblem(request.command);
  if (problem) throw new Error(problem);
  const jobName = request.jobName ? requireName(request.jobName, "jobName") : testJobName(now);
  const parts = [`SBMJOB CMD(${request.command.trim()})`, `JOB(${jobName})`];
  if (request.jobDescription) parts.push(`JOBD(${requireQualified(request.jobDescription, "jobDescription")})`);
  if (request.jobQueue) parts.push(`JOBQ(${requireQualified(request.jobQueue, "jobQueue")})`);
  if (Array.isArray(request.libraryList) && request.libraryList.length > 0) {
    if (request.libraryList.length > 250) throw new Error("libraryList has too many libraries");
    parts.push(`INLLIBL(${request.libraryList.map(lib => requireName(lib, "library")).join(" ")})`);
  }
  if (request.currentLibrary) parts.push(`CURLIB(${requireName(request.currentLibrary, "currentLibrary")})`);
  parts.push("INQMSGRPY(*DFT)", "LOG(4 00 *SECLVL)");
  return { jobName, command: parts.join(" ") };
}

export type Inquiry = { id: string; text: string; count: number };

export type JobSnapshot = {
  /** JOBQ, ACTIVE, OUTQ, or GONE when the system no longer knows the job. */
  state: "JOBQ" | "ACTIVE" | "OUTQ" | "GONE";
  /** The active job's status (RUN, MSGW, ...), when active. */
  activeStatus?: string;
  /** The newest question the job asked, when one was found. */
  inquiry?: Inquiry;
};

export type WatchAction = "wait" | "done" | "end-inquiry" | "report-inquiry" | "end-timeout" | "report-timeout";

/**
 * What the watcher does next, from what it sees. A question is what ends a
 * job early; MSGW alone does not, because a job that waits for work on a
 * message queue shows the same status.
 */
export function nextAction(snapshot: JobSnapshot, elapsedMs: number, options: { timeoutMs: number; onInquiry: "end" | "report"; onTimeout: "end" | "report" }): WatchAction {
  if (snapshot.state === "OUTQ" || snapshot.state === "GONE") return "done";
  if (snapshot.state === "ACTIVE" && snapshot.inquiry) return options.onInquiry === "end" ? "end-inquiry" : "report-inquiry";
  if (elapsedMs >= options.timeoutMs) return options.onTimeout === "end" ? "end-timeout" : "report-timeout";
  return "wait";
}

/** How long to wait before the next look at a job, by how many looks it has been active: quick while it is new. */
export function pollDelayMs(activeLooks: number) {
  return activeLooks < 5 ? 1000 : activeLooks < 15 ? 2000 : 5000;
}

// ---------------------------------------------------------------------------
// The IBM i side
// ---------------------------------------------------------------------------

type Conn = {
  runSQL: (sql: string) => Promise<any[]>;
  getConfig?: () => any;
  /** Runs SQL in a new job of its own (IBMiClient): the way to look at the connection's job when that job is stuck. */
  runSqlQzdfmdb2?: (sql: string) => Promise<any[]>;
  sqlJob?: { status?: () => { jobName?: string } };
};

/**
 * The same connection, with every statement in a new job. The connection's
 * long-lived job cannot be asked about itself while it waits on a message.
 */
export function sideChannel(conn: Conn): Conn {
  if (typeof conn.runSqlQzdfmdb2 !== "function") return conn;
  return { runSQL: sql => conn.runSqlQzdfmdb2!(sql), getConfig: () => conn.getConfig?.() };
}

/** The connection's long-lived SQL job, when it has one open: "123456/QUSER/QZDASOINIT". */
export function connectionJobName(conn: Conn): string | undefined {
  try {
    return qualified(conn.sqlJob?.status?.().jobName);
  } catch {
    return undefined;
  }
}

function field(row: any, name: string) {
  if (!row) return undefined;
  const value = row[name] ?? row[name.toLowerCase()];
  return value === null || value === undefined ? undefined : String(value).trim();
}

/** Rejects when `work` takes longer than `ms`. The work itself is not stopped; callers must not act on it late. */
async function budget<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Mark = { user: string; at: string };

/** Who the connection is and what time the system says it is, as "YYYY-MM-DD-HH.MM.SS": the mark a submit is found by. */
export async function mark(conn: Conn): Promise<Mark> {
  const rows = await conn.runSQL(
    "select current user as CURRENT_USER_NAME, varchar_format(current timestamp, 'YYYY-MM-DD-HH24.MI.SS') as NOW_AT from sysibm.sysdummy1"
  );
  const user = field(rows?.[0], "CURRENT_USER_NAME")?.toUpperCase();
  const at = field(rows?.[0], "NOW_AT");
  if (!user || !NAME.test(user)) throw new Error("The connection's user could not be read.");
  if (!at || !DB_TIME.test(at)) throw new Error("The system's time could not be read.");
  return { user, at };
}

export async function currentUser(conn: Conn): Promise<string> {
  const rows = await conn.runSQL("select current user as CURRENT_USER_NAME from sysibm.sysdummy1");
  const user = field(rows?.[0], "CURRENT_USER_NAME")?.toUpperCase();
  if (!user) throw new Error("The connection's user could not be read.");
  return user;
}

function splitJob(jobName: string) {
  const m = QUALIFIED_JOB.exec(String(jobName).toUpperCase());
  if (!m) throw new Error(`Invalid job name: ${jobName}`);
  return { number: m[1], user: m[2], name: m[3] };
}

/**
 * The jobs of that user and name that entered the system at or after the
 * mark. A job is adopted only when exactly one fits: an older job of the same
 * name is never taken for the one just submitted.
 */
export async function submittedJobs(conn: Conn, since: Mark, shortName: string, submitter?: string): Promise<string[]> {
  const by = qualified(submitter);
  const rows = await conn.runSQL(
    `select JOB_NAME from table(qsys2.job_info(JOB_USER_FILTER => ${Tools.sqlString(since.user)})) x ` +
    `where JOB_NAME_SHORT = ${Tools.sqlString(shortName)} and JOB_ENTERED_SYSTEM_TIME >= timestamp(${Tools.sqlString(since.at)}) ` +
    // When the submitting job is known, only a job it submitted counts.
    (by ? `and SUBMITTER_JOB_NAME = ${Tools.sqlString(by)} ` : "") +
    `order by JOB_ENTERED_SYSTEM_TIME desc fetch first 3 rows only`
  );
  return (rows ?? []).map(row => qualified(field(row, "JOB_NAME"))).filter((job): job is string => !!job);
}

/**
 * The job an SBMJOB through the connection's job just made, or undefined.
 * Read from that job's own log, and believed only when the message is the
 * system's completion message, no older than the mark, names a job of this
 * user, and that job did enter the system at or after the mark.
 */
export async function submittedByThisCall(conn: Conn, since: Mark): Promise<string | undefined> {
  try {
    const rows = await conn.runSQL(
      `select MESSAGE_TEXT from table(qsys2.joblog_info('*')) x where MESSAGE_ID = 'CPC1221' and MESSAGE_TYPE = 'COMPLETION' ` +
      `and MESSAGE_TIMESTAMP >= timestamp(${Tools.sqlString(since.at)}) order by ORDINAL_POSITION desc fetch first 1 rows only`
    );
    const job = parseSubmittedJob(field(rows?.[0], "MESSAGE_TEXT"));
    if (!job) return undefined;
    const parts = splitJob(job);
    if (parts.user !== since.user) return undefined;
    return (await submittedJobs(conn, since, parts.name, connectionJobName(conn))).includes(job) ? job : undefined;
  } catch {
    return undefined;
  }
}

function inquiryOf(row: any): Inquiry | undefined {
  if (!row) return undefined;
  return { id: field(row, "MESSAGE_ID") ?? "", text: field(row, "MESSAGE_TEXT") ?? "", count: Number(field(row, "INQUIRIES") ?? 1) || 1 };
}

export type InquiryFilter = {
  /** Only a question asked within this many seconds. */
  withinSeconds?: number;
  /** Only a question that has no reply yet. */
  unanswered?: boolean;
  /** The message queues to read besides the job's log. Default: the operator's and the job user's own. */
  queues?: string[];
  /** Filled with the queues that could be read. */
  read?: string[];
};

function recent(filter: InquiryFilter | undefined, column: string) {
  const seconds = Number(filter?.withinSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? ` and ${column} >= current timestamp - ${Math.ceil(seconds)} seconds` : "";
}

/**
 * The newest question a job asked. Looked for in the job's log and on the
 * message queues a job's questions land on, the system operator's and the job
 * user's own (SNDUSRMSG to a message queue is not in the sender's job log).
 * A log or queue that cannot be read is simply not looked at.
 */
export async function newestInquiry(conn: Conn, jobName: string, filter?: InquiryFilter): Promise<Inquiry | undefined> {
  try {
    const job = Tools.sqlString(jobName);
    const rows = await conn.runSQL(
      `select MESSAGE_ID, MESSAGE_TEXT, count(*) over () as INQUIRIES from table(qsys2.joblog_info(${job})) x ` +
      `where MESSAGE_TYPE in ('INQUIRY', 'SENDER')${recent(filter, "MESSAGE_TIMESTAMP")}` +
      (filter?.unanswered ? ` and not exists (select 1 from table(qsys2.joblog_info(${job})) r where r.MESSAGE_TYPE = 'REPLY' and r.ORDINAL_POSITION > x.ORDINAL_POSITION)` : "") +
      ` order by ORDINAL_POSITION desc fetch first 1 rows only`
    );
    const found = inquiryOf(rows?.[0]);
    if (found) return found;
  } catch {
    // The job ended between two looks, or its log cannot be read.
  }
  return queuedInquiry(conn, jobName, filter);
}

/** A question from the job on the operator's queue or the job user's own. Works after the job has ended too. */
export async function queuedInquiry(conn: Conn, jobName: string, filter?: InquiryFilter): Promise<Inquiry | undefined> {
  let user: string;
  try {
    user = splitJob(jobName).user;
  } catch {
    return undefined;
  }
  let found: Inquiry | undefined;
  for (const queue of filter?.queues ?? ["QSYSOPR", user]) {
    if (!NAME.test(queue)) continue;
    try {
      const rows = await conn.runSQL(
        `select MESSAGE_ID, MESSAGE_TEXT, count(*) over () as INQUIRIES from qsys2.message_queue_info q ` +
        `where MESSAGE_QUEUE_NAME = ${Tools.sqlString(queue)} and FROM_JOB = ${Tools.sqlString(jobName.toUpperCase())} and MESSAGE_TYPE = 'INQUIRY'` +
        recent(filter, "MESSAGE_TIMESTAMP") +
        (filter?.unanswered ? ` and not exists (select 1 from qsys2.message_queue_info r where r.MESSAGE_QUEUE_NAME = q.MESSAGE_QUEUE_NAME and r.MESSAGE_TYPE = 'REPLY' and r.ASSOCIATED_MESSAGE_KEY = q.MESSAGE_KEY)` : "") +
        ` order by MESSAGE_TIMESTAMP desc fetch first 1 rows only`
      );
      filter?.read?.push(queue);
      found ??= inquiryOf(rows?.[0]);
      if (found && !filter?.read) return found;
    } catch {
      // not readable: try the next queue
    }
  }
  return found;
}

/** Where the job is now. Throws when the system cannot be asked. */
export async function jobSnapshot(conn: Conn, jobName: string): Promise<JobSnapshot & { row?: any }> {
  const job = splitJob(jobName);
  const rows = await conn.runSQL(
    `select JOB_NAME, JOB_STATUS, JOB_QUEUE_LIBRARY, JOB_QUEUE_NAME, JOB_QUEUE_STATUS, COMPLETION_STATUS, JOB_END_REASON ` +
    `from table(qsys2.job_info(JOB_USER_FILTER => ${Tools.sqlString(job.user)})) x where JOB_NAME = ${Tools.sqlString(jobName.toUpperCase())} fetch first 1 rows only`
  );
  const row = rows?.[0];
  const status = (field(row, "JOB_STATUS") ?? "").replace(/^\*/, "").toUpperCase();
  if (!row || !status) return { state: "GONE" };
  if (status === "JOBQ") return { state: "JOBQ", row };
  if (status === "OUTQ") return { state: "OUTQ", row };
  let activeStatus: string | undefined;
  try {
    const active = await conn.runSQL(
      `select JOB_STATUS from table(qsys2.active_job_info(JOB_NAME_FILTER => ${Tools.sqlString(job.name)}, DETAILED_INFO => 'NONE')) x ` +
      `where JOB_NAME = ${Tools.sqlString(jobName.toUpperCase())} fetch first 1 rows only`
    );
    activeStatus = field(active?.[0], "JOB_STATUS")?.toUpperCase();
  } catch {
    activeStatus = undefined;
  }
  return { state: "ACTIVE", activeStatus, inquiry: await newestInquiry(conn, jobName), row };
}

async function jobLogTail(conn: Conn, jobName: string, limit = 15) {
  try {
    const rows = await conn.runSQL(
      `select MESSAGE_ID, MESSAGE_TYPE, SEVERITY, MESSAGE_TEXT from table(qsys2.joblog_info(${Tools.sqlString(jobName)})) x ` +
      `order by ORDINAL_POSITION desc fetch first ${limit} rows only`
    );
    return (rows ?? []).reverse().map(row => ({
      id: field(row, "MESSAGE_ID") ?? "",
      type: field(row, "MESSAGE_TYPE") ?? "",
      severity: Number(field(row, "SEVERITY") ?? 0) || 0,
      text: field(row, "MESSAGE_TEXT") ?? ""
    }));
  } catch {
    return undefined;
  }
}

export type WaitingJob = {
  jobName: string;
  type?: string;
  subsystem?: string;
  function?: string;
  /** True when this server submitted the job. */
  submittedHere: boolean;
  message?: { id: string; text: string };
};

/**
 * Jobs working for the user that wait on a message. A database server job
 * (QZDASOINIT under QUSER) counts: the system records whom it is working for.
 * Interactive jobs are left out: a person's own screen waiting on a message
 * is theirs to see.
 */
export async function waitingJobs(conn: Conn, user: string, connectionName?: string, limit = 20, recentSeconds?: number): Promise<WaitingJob[]> {
  const rows = await conn.runSQL(
    `select JOB_NAME, JOB_TYPE, SUBSYSTEM, FUNCTION from table(qsys2.active_job_info(CURRENT_USER_LIST_FILTER => ${Tools.sqlString(user)}, DETAILED_INFO => 'NONE')) x ` +
    `where JOB_STATUS = 'MSGW' and JOB_TYPE <> 'INT' fetch first ${Math.max(1, Math.min(limit, 100))} rows only`
  );
  const jobs: WaitingJob[] = [];
  for (const row of rows ?? []) {
    const jobName = qualified(field(row, "JOB_NAME"));
    if (!jobName) continue;
    const own = isOwnJob(connectionName, jobName);
    const inquiry = jobs.length < 3 ? await newestInquiry(conn, jobName, recentSeconds ? { withinSeconds: recentSeconds, queues: ["QSYSOPR", user] } : { queues: ["QSYSOPR", user] }) : undefined;
    // After a call: only what the call could have caused. A job that has been waiting for hours
    // (a monitor on a message queue, another session's job) is not this call's news.
    if (recentSeconds && !own && !inquiry) continue;
    jobs.push({
      jobName,
      type: field(row, "JOB_TYPE"),
      subsystem: field(row, "SUBSYSTEM"),
      function: field(row, "FUNCTION"),
      submittedHere: own,
      ...(inquiry ? { message: { id: inquiry.id, text: inquiry.text } } : {})
    });
  }
  return jobs;
}

function setting(conn: Conn, name: string) {
  try {
    return conn.getConfig?.()?.[name];
  } catch {
    return undefined;
  }
}

/** False when the connection switched the look off (`watchWaitingJobs: false`). */
export function watchEnabled(conn: Conn) {
  return setting(conn, "watchWaitingJobs") !== false;
}

export function waitingNote(jobs: WaitingJob[]) {
  const names = jobs.map(job => job.jobName).join(", ");
  const own = jobs.some(job => job.submittedHere);
  return (
    `${jobs.length === 1 ? "A job" : `${jobs.length} jobs`} working for this user ${jobs.length === 1 ? "is" : "are"} waiting on a message: ${names}. ` +
    `If this call caused it, stop and tell the person which job and which message. ` +
    (own ? "A job submitted here may be ended with ibmi.jobs.end. " : "") +
    `Do not reply to the message, and do not end a job that was not submitted here.`
  );
}

// ---------------------------------------------------------------------------
// The connection's own job, stuck
// ---------------------------------------------------------------------------

export type StuckJob = {
  jobName: string;
  message?: { id: string; text: string };
  /** True when the job was ended here. */
  ended: boolean;
  /** Why it was not ended, when it was not. */
  reason?: string;
};

/** The statement the connection's job is running now, when it started at or after `callStartMs`: the caller's own. */
export function runningConnectionJob(conn: Conn, callStartMs: number): string | undefined {
  try {
    const running = (conn.sqlJob?.status?.() as any)?.running;
    if (!running || !(Number(running.since) >= callStartMs - 50)) return undefined;
    return qualified(running.jobName);
  } catch {
    return undefined;
  }
}

export type StuckOptions = {
  mayEnd: boolean;
  /** How long ago the call started, in seconds: only a question asked since then counts. */
  withinSeconds?: number;
};

async function stillStuck(side: Conn, name: string, user: string) {
  const rows = await side.runSQL(
    `select JOB_STATUS, AUTHORIZATION_NAME from table(qsys2.active_job_info(JOB_NAME_FILTER => ${Tools.sqlString(splitJob(name).name)}, DETAILED_INFO => 'NONE')) x ` +
    `where JOB_NAME = ${Tools.sqlString(name)} fetch first 1 rows only`
  );
  const row = rows?.[0];
  // A pooled server job is handed from user to user: only one that is still ours is ours to end.
  return (field(row, "JOB_STATUS") ?? "").toUpperCase() === "MSGW" && (field(row, "AUTHORIZATION_NAME") ?? "").toUpperCase() === user;
}

/**
 * The call that just timed out ran in the connection's own job. Is that job
 * now waiting on a question it asked during the call, with no reply yet, and
 * still working for this user? Looked at from a new job. Returns what was
 * found and whether it should be ended; ends nothing itself.
 *
 * It is to be ended only when the connection asks for that
 * (`stuckConnectionJob: "end"`; the default reports) and the policy lets
 * jobs be ended. A job in MSGW with no such question is reported and left
 * alone: a program waiting for work on a message queue looks the same.
 */
export async function assessStuckJob(conn: Conn, jobName: string | undefined, options: StuckOptions): Promise<{ stuck: StuckJob; end: boolean; user: string } | undefined> {
  const name = qualified(jobName);
  if (!name) return undefined;
  const side = sideChannel(conn);
  if (side === conn) return undefined; // no second job to look from
  const user = await currentUser(side);
  if (!(await stillStuck(side, name, user))) return undefined;
  const inquiry = await newestInquiry(side, name, { withinSeconds: options.withinSeconds, unanswered: true, queues: ["QSYSOPR", user] });
  const stuck: StuckJob = { jobName: name, ended: false, ...(inquiry ? { message: { id: inquiry.id, text: inquiry.text } } : {}) };
  if (!inquiry) return { stuck: { ...stuck, reason: "it waits on a message queue, but no unanswered question it asked during this call was found" }, end: false, user };
  if (String(setting(conn, "stuckConnectionJob") ?? "report").trim().toLowerCase() !== "end") {
    return { stuck: { ...stuck, reason: "stuckConnectionJob is not \"end\"" }, end: false, user };
  }
  if (!options.mayEnd) return { stuck: { ...stuck, reason: "the connection's policy does not let jobs be ended from here" }, end: false, user };
  return { stuck, end: true, user };
}

/** End the job `assessStuckJob` said to end, after one more look that it is still so. Never replies. */
export async function endStuckJob(conn: Conn, stuck: StuckJob, user: string): Promise<StuckJob | undefined> {
  const side = sideChannel(conn);
  if (!(await stillStuck(side, stuck.jobName, user))) return undefined;
  try {
    await side.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(`ENDJOB JOB(${stuck.jobName}) OPTION(*IMMED)`)})`);
    log("info", "audit.jobs.endStuckConnectionJob", { jobName: stuck.jobName, messageId: stuck.message?.id });
    noteServerEndedJob({ jobName: stuck.jobName, why: "connection job stuck on a question", messageId: stuck.message?.id });
    return { ...stuck, ended: true, reason: undefined };
  } catch (err: any) {
    return { ...stuck, ended: false, reason: String(err?.message || err).slice(0, 300) };
  }
}

/** Assess and, when it should be, end. */
export async function stuckConnectionJob(conn: Conn, jobName: string | undefined, options: StuckOptions): Promise<StuckJob | undefined> {
  const found = await assessStuckJob(conn, jobName, options);
  if (!found) return undefined;
  return found.end ? endStuckJob(conn, found.stuck, found.user) : found.stuck;
}

export function stuckNote(stuck: StuckJob) {
  const asked = stuck.message ? `${stuck.message.id} ${stuck.message.text}`.trim() : undefined;
  if (stuck.ended) {
    return (
      `The call did not time out by being slow: the connection's job ${stuck.jobName} was waiting on a question it asked (${asked}). The job was ended and nobody was asked to reply; the next call opens a new one. ` +
      `The message stays listed on the operator's queue but needs no answer. Find why it was asked before trying again, and run a program that has not run before with ibmi.jobs.runTest, not in the connection's job.`
    );
  }
  if (!asked) {
    return (
      `The connection's job ${stuck.jobName} is waiting on a message queue, but no unanswered question it asked during this call was found, so it was left alone. ` +
      `If the call was meant to wait for a message this is expected; otherwise tell the person, who can end it with ENDJOB JOB(${stuck.jobName}) OPTION(*IMMED).`
    );
  }
  return (
    `The connection's job ${stuck.jobName} is waiting on a question it asked (${asked}) and was not ended (${stuck.reason ?? "no reason given"}). ` +
    `Tell the person now: it holds a shared server job until it is ended (ENDJOB JOB(${stuck.jobName}) OPTION(*IMMED)) or the message is answered.`
  );
}

type Notice = { waitingJobs?: WaitingJob[]; waitingJobsNote?: string; stuckJob?: StuckJob; stuckJobNote?: string };

export type TimedOut = {
  /** The connection job the timed-out statement was running in. Undefined when the statement never started there. */
  connectionJob?: string;
  mayEnd: boolean;
  /** How long ago the call started, in seconds. */
  withinSeconds?: number;
};

/**
 * After a tool ran a program: the jobs working for this user that now wait on
 * a message because of it, as fields to add to the tool's result. Never
 * throws: the tool's own answer matters more than this look.
 *
 * `timedOut` is given when the call timed out. When its statement was running
 * in the connection's own job, that job may be the one waiting, so everything
 * is looked at from a new job. The looking is limited to `budgetMs`; a job is
 * only ended when the looking finished in time, and an end that was started is
 * always waited for and reported, so nothing is ended after the call answered.
 */
export async function waitingJobsNotice(conn: Conn, connectionName?: string, timedOut?: TimedOut, budgetMs = 30000): Promise<Notice> {
  if (!watchEnabled(conn)) return {};
  const out: Notice = {};
  const recentSeconds = timedOut?.withinSeconds ?? 600;
  const list = async (from: Conn, skip?: string) => {
    const found = (await waitingJobs(from, await currentUser(from), connectionName, 20, recentSeconds)).filter(job => job.jobName !== skip);
    return found;
  };
  const show = (found: WaitingJob[]) => {
    if (found.length === 0) return;
    out.waitingJobs = found;
    out.waitingJobsNote = waitingNote(found);
  };
  try {
    if (!timedOut) {
      show(await budget(list(conn), Math.min(budgetMs, 6000), "the look for waiting jobs"));
      return { ...out };
    }
    const side = sideChannel(conn);
    const assessed = await budget(
      assessStuckJob(conn, timedOut.connectionJob, { mayEnd: timedOut.mayEnd, withinSeconds: timedOut.withinSeconds }).catch(() => undefined),
      budgetMs,
      "the look at the connection's job"
    );
    if (assessed) {
      out.stuckJob = assessed.stuck;
      out.stuckJobNote = stuckNote(assessed.stuck);
      if (assessed.end) {
        // Said before it is done, and waited for: the result never misses an end that happened.
        out.stuckJob = { ...assessed.stuck, reason: "an end was issued; its result is not known" };
        out.stuckJobNote = stuckNote(out.stuckJob);
        const done = await budget(endStuckJob(conn, assessed.stuck, assessed.user), 60000, "ENDJOB").catch((err: any) => ({ ...assessed.stuck, reason: String(err?.message || err) }));
        if (done) {
          out.stuckJob = done;
          out.stuckJobNote = stuckNote(done);
        } else {
          delete out.stuckJob;
          delete out.stuckJobNote;
        }
      }
    }
    if (side !== conn) show(await budget(list(side, out.stuckJob?.ended ? out.stuckJob.jobName : undefined), Math.min(budgetMs, 12000), "the look for waiting jobs"));
  } catch {
    // Out of time or not readable: what is in `out` already stands.
  }
  return { ...out };
}

// ---------------------------------------------------------------------------
// The test job
// ---------------------------------------------------------------------------

export type TestJobOptions = TestJobRequest & {
  timeoutSeconds?: number;
  onInquiry?: "end" | "report";
  onTimeout?: "end" | "report";
};

export type TestJobDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  runCl: (command: string) => Promise<{ code: number | null; stderr?: string }>;
  /** False when the connection's policy does not let this server end a job: the job is then reported, never ended. */
  mayEnd?: boolean;
  /** For tests: how long one look may take. */
  lookBudgetMs?: number;
};

export type TestJobOutcome =
  | "completed"
  | "completed-after-inquiry"
  | "failed"
  | "ended-on-inquiry"
  | "waiting-on-inquiry"
  | "ended-on-timeout"
  | "still-running"
  | "not-started"
  | "not-found"
  | "not-available"
  | "submit-timed-out"
  | "watch-lost"
  | "unknown";

export type TestJobResult = {
  ok: boolean;
  outcome: TestJobOutcome;
  jobName?: string;
  submitted: string;
  seconds: number;
  note: string;
  inquiry?: Inquiry;
  ended?: { byWatcher: boolean; verified?: boolean; completionStatus?: string; endReason?: string };
  jobQueue?: string;
  jobLog?: Array<{ id: string; type: string; severity: number; text: string }>;
};

function choice(value: unknown, fallback: "end" | "report"): "end" | "report" {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "end" || text === "report" ? text : fallback;
}

function sayInquiry(inquiry: Inquiry | undefined) {
  return inquiry ? `${inquiry.id} ${inquiry.text}`.trim() : "an inquiry message";
}

/**
 * Submit a command as a batch job, watch it to its end, and end it if it asks
 * a question or runs out of time. Whatever goes wrong after the submit, the
 * job is not left running unwatched without an attempt to end it, and the
 * result says what is known and what is not.
 */
export async function runTestJob(conn: Conn, connectionName: string | undefined, options: TestJobOptions, deps: TestJobDeps): Promise<TestJobResult> {
  const timeoutSeconds = clampNumber(options.timeoutSeconds ?? setting(conn, "testJobTimeoutSeconds"), DEFAULT_TEST_JOB_SECONDS, 5, MAX_TEST_JOB_SECONDS);
  const mayEnd = deps.mayEnd !== false;
  const onInquiry = mayEnd ? choice(options.onInquiry ?? setting(conn, "testJobOnInquiry"), "end") : "report";
  const onTimeout = mayEnd ? choice(options.onTimeout ?? setting(conn, "testJobOnTimeout"), "end") : "report";
  const lookBudget = deps.lookBudgetMs ?? LOOK_BUDGET_MS;
  const { jobName: shortName, command } = buildSubmitCommand(options, deps.now());
  const started = deps.now();
  const seconds = () => Math.round((deps.now() - started) / 100) / 10;
  const side = sideChannel(conn);
  // The job that submits: when it is known, only a job it submitted is taken for the new one.
  const submitter = connectionJobName(conn);

  // Before anything is submitted: the services the watch depends on must answer, and no job that
  // could be taken for the new one may exist. Otherwise nothing is submitted at all.
  let since: Mark;
  try {
    since = await budget(mark(conn), lookBudget, "the system");
    const already = await budget(submittedJobs(conn, since, shortName), lookBudget, "the system");
    if (already.length > 0) {
      return { ok: false, outcome: "not-started", submitted: command, seconds: seconds(), note: `A job named ${shortName} of ${since.user} entered the system just now (${already.join(", ")}): nothing was submitted, so it cannot be mistaken for the new one. Use another jobName.` };
    }
  } catch (err: any) {
    return { ok: false, outcome: "not-available", submitted: command, seconds: seconds(), note: `Nothing was submitted: a job cannot be watched on this system or with this user (${String(err?.message || err).slice(0, 240)}).` };
  }

  /** ENDJOB through the connection, then from a new job when that fails. */
  const end = async (jobName: string): Promise<{ ok: boolean; reason?: string }> => {
    const text = `ENDJOB JOB(${jobName}) OPTION(*IMMED)`;
    let reason: string | undefined;
    const ended = () => {
      noteServerEndedJob({ jobName, why: "test job" });
      return { ok: true };
    };
    try {
      const ran = await budget(deps.runCl(text), 45000, "ENDJOB");
      if (ran.code === 0) return ended();
      reason = String(ran.stderr || "ENDJOB failed").trim();
    } catch (err: any) {
      reason = String(err?.message || err);
    }
    // "Already ending" and "not found" mean the job is stopping or gone: the end is not what failed.
    if (/\bCPF13(?:62|21)\b/i.test(reason)) return { ok: true };
    if (side !== conn) {
      try {
        await budget(side.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(text)})`), 45000, "ENDJOB");
        return ended();
      } catch (err: any) {
        const second = String(err?.message || err);
        if (/\bCPF13(?:62|21)\b/i.test(second)) return { ok: true };
        reason = second;
      }
    }
    return { ok: false, reason: reason?.slice(0, 300) };
  };
  /** After an ENDJOB was accepted: has the job really stopped? Undefined when that cannot be seen. */
  const stopped = async (jobName: string): Promise<boolean | undefined> => {
    for (let i = 0; i < 3; i++) {
      for (const from of side === conn ? [conn] : [conn, side]) {
        try {
          const now = await budget(jobSnapshot(from, jobName), lookBudget, "the system");
          // Only a job that has left the system's active jobs counts: "ending" is not "ended".
          if (now.state === "OUTQ" || now.state === "GONE") return true;
          break;
        } catch {
          // try the other way of asking
        }
      }
      await deps.sleep(700);
    }
    return undefined;
  };

  const submit = await deps.runCl(command);
  let jobName: string | undefined;
  const find = (from: Conn) => budget(submittedJobs(from, since, shortName, submitter), lookBudget, "the system");

  if (submit.code !== 0) {
    const said = String(submit.stderr || "SBMJOB failed").trim();
    // Only the system saying so (a CPF or CPD message from SBMJOB) means nothing was submitted. A
    // timeout or a dropped connection says nothing about what the system did.
    if (/\bCP[FD][0-9A-F]{4}\b/i.test(said) && !clTimedOut(submit)) {
      return { ok: false, outcome: "not-started", submitted: command, seconds: seconds(), note: `The job was not submitted: ${said}` };
    }
    const how = clTimedOut(submit) ? "The submit did not answer in time" : `The submit did not come back (${said.slice(0, 160)})`;
    // The job may exist all the same: look for it from a new job.
    let found: string[] = [];
    try {
      found = await find(side);
    } catch {
      found = [];
    }
    if (found.length !== 1) {
      return {
        ok: false, outcome: "submit-timed-out", submitted: command, seconds: seconds(),
        note: `${how}, and ${found.length === 0 ? `no job named ${shortName} was found` : `more than one job named ${shortName} was found`}. ` +
          `Whether a job was submitted is not known: look with ibmi.jobs.list before running anything else.`
      };
    }
    jobName = found[0];
    // Without knowing which job submitted it, a job found by name alone is not ended: it is named for the person.
    if (!submitter) {
      return {
        ok: false, outcome: "submit-timed-out", jobName, submitted: command, seconds: seconds(),
        note: `${how}. A job named ${shortName} entered the system at that time (${jobName}), but it cannot be confirmed that it was submitted from here, so it was left alone. Tell the person now.`
      };
    }
    rememberOwnJob(connectionName, jobName);
    const ended = mayEnd ? await end(jobName) : { ok: false, reason: "the connection's policy does not let jobs be ended from here" };
    return {
      ok: false, outcome: "submit-timed-out", jobName, submitted: command, seconds: seconds(),
      ended: ended.ok ? { byWatcher: true, verified: await stopped(jobName) } : undefined,
      note: `${how}, but the job was submitted as ${jobName}. ` +
        (ended.ok ? "It was ended, because it could not be watched from the start." : `It could not be ended (${ended.reason}): it is running unwatched; tell the person now.`)
    };
  }

  let candidates: string[] = [];
  for (let attempt = 0; attempt < 5 && candidates.length === 0; attempt++) {
    try {
      candidates = await find(conn);
    } catch {
      try { candidates = await find(side); } catch { candidates = []; }
    }
    if (candidates.length === 0) await deps.sleep(500);
  }
  if (candidates.length !== 1) {
    return {
      ok: false, outcome: "not-found", submitted: command, seconds: seconds(),
      note: candidates.length === 0
        ? `Job ${shortName} was submitted but could not be found for ${since.user}, so it is not being watched. Look for it with ibmi.jobs.list before running anything else.`
        : `More than one job named ${shortName} of ${since.user} entered the system at the same time (${candidates.join(", ")}), so none was taken for the new one and none is being watched. Tell the person.`
    };
  }
  jobName = candidates[0];
  rememberOwnJob(connectionName, jobName);

  const base = { jobName, submitted: command };
  const endedInfo = (snapshot: JobSnapshot & { row?: any }) => ({
    byWatcher: false,
    completionStatus: field(snapshot.row, "COMPLETION_STATUS"),
    endReason: field(snapshot.row, "JOB_END_REASON")
  });

  let lastLog: TestJobResult["jobLog"];
  let seen: Inquiry | undefined;
  let failedLooks = 0;
  let activeLooks = 0;
  for (;;) {
    let snapshot: JobSnapshot & { row?: any };
    try {
      snapshot = await budget(jobSnapshot(conn, jobName), lookBudget, "the system");
      failedLooks = 0;
    } catch (err: any) {
      // The connection's job is busy, gone or the service failed. A few misses are waited out; after
      // that, or once the time is up, the job is not left unwatched: it is ended.
      // A look that is only slow is not a failed look: a busy system must not get a healthy job ended early.
      const slow = /did not answer in \d+ ms/.test(String(err?.message || ""));
      if (!slow) failedLooks++;
      const late = deps.now() - started >= timeoutSeconds * 1000;
      if (failedLooks < MAX_FAILED_LOOKS && !late) {
        await deps.sleep(1000);
        continue;
      }
      const ended = mayEnd ? await end(jobName) : { ok: false, reason: "the connection's policy does not let jobs be ended from here" };
      log("info", "audit.jobs.testWatchLost", { jobName, ended: ended.ok });
      return {
        ok: false, outcome: "watch-lost", ...base, seconds: seconds(), inquiry: seen, jobLog: lastLog,
        ended: ended.ok ? { byWatcher: true, verified: await stopped(jobName) } : undefined,
        note: `The job could no longer be watched (${String(err?.message || err).slice(0, 200)}). ` +
          (ended.ok ? "It was ended so that it is not left running unwatched; how far it got is not known." : `It could not be ended (${ended.reason}): it may still be running as ${jobName}; tell the person now.`)
      };
    }
    if (snapshot.inquiry) seen = snapshot.inquiry;
    const action = nextAction(snapshot, deps.now() - started, { timeoutMs: timeoutSeconds * 1000, onInquiry, onTimeout });
    const queue = snapshot.row && field(snapshot.row, "JOB_QUEUE_NAME") ? `${field(snapshot.row, "JOB_QUEUE_LIBRARY") ?? ""}/${field(snapshot.row, "JOB_QUEUE_NAME")}` : undefined;

    if (action === "done") {
      if (snapshot.state === "GONE") {
        return { ok: false, outcome: "unknown", ...base, seconds: seconds(), inquiry: seen, jobLog: lastLog, note: `The system no longer knows job ${jobName}, so how it ended is not known. Its job log, if it kept one, is a spooled file QPJOBLOG of this job.` };
      }
      // A job can ask, be answered by default, and finish between two looks: its question is still on a queue.
      const read: string[] = [];
      const asked = seen ?? (await budget(queuedInquiry(conn, jobName, { read }), lookBudget, "the system").catch(() => undefined));
      const unseen = seen || read.includes("QSYSOPR") ? "" : " The operator's message queue could not be read, so a question that got a default reply would not have been seen.";
      const info = endedInfo(snapshot);
      const normal = (info.completionStatus ?? "").replace(/^\*/, "").toUpperCase() === "NORMAL";
      if (asked) {
        return {
          ok: false, outcome: "completed-after-inquiry", ...base, seconds: seconds(), inquiry: asked, ended: info, jobLog: lastLog,
          note: `The job ended ${normal ? "normally" : "abnormally"}, but it asked a question (${sayInquiry(asked)}) that nobody answered: the system gave the default reply. ` +
            `Treat its result as unreliable and find why it asked. Its job log is a spooled file QPJOBLOG of this job.`
        };
      }
      return {
        ok: normal, outcome: normal ? "completed" : "failed", ...base, seconds: seconds(), ended: info, jobLog: lastLog,
        note: normal
          ? `The job ended normally, and no question from it was found.${unseen} Its job log is a spooled file QPJOBLOG of this job.`
          : `The job ended abnormally (${info.endReason || "no reason given"}).${unseen} Read its job log (spooled file QPJOBLOG of this job) for the cause.`
      };
    }

    if (action === "wait") {
      if (snapshot.state === "ACTIVE") {
        lastLog = (await budget(jobLogTail(conn, jobName), lookBudget, "the system").catch(() => undefined)) ?? lastLog;
        await deps.sleep(pollDelayMs(activeLooks++));
      } else {
        await deps.sleep(2000);
      }
      continue;
    }

    const jobLog = snapshot.state === "ACTIVE" ? (await budget(jobLogTail(conn, jobName), lookBudget, "the system").catch(() => undefined)) ?? lastLog : lastLog;

    if (action === "end-inquiry" || action === "report-inquiry") {
      const tried = action === "end-inquiry" ? await end(jobName) : undefined;
      log("info", "audit.jobs.testInquiry", { jobName, messageId: snapshot.inquiry?.id, ended: tried?.ok === true });
      if (tried?.ok) {
        return {
          ok: false, outcome: "ended-on-inquiry", ...base, seconds: seconds(), inquiry: snapshot.inquiry, ended: { byWatcher: true, verified: await stopped(jobName) }, jobLog,
          note: `The job asked a question (${sayInquiry(snapshot.inquiry)}) and was ended; nobody was asked to reply. Find why the program asks before running it again: do not resubmit it unchanged.`
        };
      }
      if (tried) {
        // The end was refused. Perhaps the job finished by itself in the meantime.
        const now = await budget(jobSnapshot(conn, jobName), lookBudget, "the system").catch(() => undefined);
        if (now && (now.state === "OUTQ" || now.state === "GONE")) {
          return {
            ok: false, outcome: "completed-after-inquiry", ...base, seconds: seconds(), inquiry: snapshot.inquiry, ended: endedInfo(now), jobLog,
            note: `The job asked a question (${sayInquiry(snapshot.inquiry)}) and then ended by itself before it could be ended here. Treat its result as unreliable and find why it asked.`
          };
        }
      }
      return {
        ok: false, outcome: "waiting-on-inquiry", ...base, seconds: seconds(), inquiry: snapshot.inquiry, jobLog,
        note: `The job asked a question (${sayInquiry(snapshot.inquiry)}) and ` +
          (tried ? `could not be ended (${tried.reason})` : mayEnd ? "was left as it is" : "was left as it is: the connection's policy does not let jobs be ended from here") +
          `. It is ${jobName}: tell the person now${mayEnd ? ", and end it with ibmi.jobs.end unless they want to answer it" : ""}.`
      };
    }

    // Out of time.
    const waiting = snapshot.state === "JOBQ";
    const tried = action === "end-timeout" ? await end(jobName) : undefined;
    if (tried && !tried.ok) {
      // The end was refused. Perhaps the job finished by itself in the meantime: then say that.
      const now = await budget(jobSnapshot(conn, jobName), lookBudget, "the system").catch(() => undefined);
      if (now && (now.state === "OUTQ" || now.state === "GONE")) continue;
    }
    const waitsOnQueue = snapshot.activeStatus === "MSGW" ? " It was waiting on a message queue, with no question from it found." : "";
    if (waiting) {
      return {
        ok: false, outcome: "not-started", ...base, seconds: seconds(), jobQueue: queue, jobLog,
        ended: tried?.ok ? { byWatcher: true, verified: await stopped(jobName) } : undefined,
        note: `After ${timeoutSeconds} s the job had not started: it was still on job queue ${queue ?? "(unknown)"}${field(snapshot.row, "JOB_QUEUE_STATUS") ? `, which is ${field(snapshot.row, "JOB_QUEUE_STATUS")?.toLowerCase()}` : ""}. ` +
          (tried?.ok ? "It was taken off the queue. " : tried ? `It could not be taken off the queue (${tried.reason}): it is still there as ${jobName}. ` : `It is still there as ${jobName}. `) +
          "Something ahead of it is holding the queue: look at what is active there before submitting again."
      };
    }
    if (tried?.ok) {
      return {
        ok: false, outcome: "ended-on-timeout", ...base, seconds: seconds(), jobQueue: queue, ended: { byWatcher: true, verified: await stopped(jobName) }, jobLog,
        note: `The job was still running after ${timeoutSeconds} s and was ended.${waitsOnQueue} If it needs longer, run it again with a larger timeoutSeconds.`
      };
    }
    return {
      ok: false, outcome: "still-running", ...base, seconds: seconds(), jobQueue: queue, jobLog,
      note: `The job is still running after ${timeoutSeconds} s as ${jobName}.${waitsOnQueue} ` +
        (tried ? `An end was tried and failed (${tried.reason}): tell the person now.` : mayEnd ? "Watch it with ibmi.jobs.list, or end it with ibmi.jobs.end." : "The connection's policy does not let jobs be ended from here: tell the person.")
    };
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function policyOf(ctx: McpContext, args: any) {
  try {
    return ctx.getPolicy(args?.connectionName);
  } catch {
    return undefined;
  }
}

async function handle(ctx: McpContext, name: string, args: any) {
  const connectionName = getConnectionName(ctx, args);
  const conn = await ctx.ensureActive(args?.connectionName);

  if (name === "ibmi.jobs.waiting") {
    try {
      const user = await currentUser(conn);
      const jobs = await waitingJobs(conn, user, connectionName, clampNumber(args?.limit, 20, 1, 100));
      return json({ available: true, user, count: jobs.length, jobs, submittedHere: ownJobList(connectionName), ...(jobs.length ? { note: waitingNote(jobs) } : {}) });
    } catch (err: any) {
      // A release without the job services, or a user who may not use them.
      return json({ available: false, count: 0, jobs: [], reason: `Waiting jobs cannot be read on this system: ${err?.message || String(err)}` });
    }
  }

  if (name === "ibmi.jobs.runTest") {
    const options: TestJobOptions = {
      command: String(args?.command ?? ""),
      // Always unique: a caller's name is kept as the start of it, so no other job of the user shares it.
      jobName: uniqueJobName(args?.jobName ? String(args.jobName) : undefined),
      jobQueue: args?.jobQueue ? String(args.jobQueue) : undefined,
      jobDescription: args?.jobDescription ? String(args.jobDescription) : undefined,
      libraryList: Array.isArray(args?.libraryList) ? args.libraryList.map((lib: unknown) => String(lib)) : undefined,
      currentLibrary: args?.currentLibrary ? String(args.currentLibrary) : undefined,
      timeoutSeconds: args?.timeoutSeconds,
      onInquiry: args?.onInquiry,
      onTimeout: args?.onTimeout
    };
    const { command } = buildSubmitCommand(options);
    const policy = policyOf(ctx, args);
    // The command the job runs is held to the policy as if it were run directly: a denied command
    // does not become allowed by being submitted.
    const denied = policy ? checkClCommand(policy, options.command.trim()) : undefined;
    if (denied) throw new Error(`Blocked by policy: cl.run (${denied})`);
    for (const value of [options.jobQueue, options.jobDescription]) {
      const library = value && value.includes("/") ? value.split("/")[0].trim().toUpperCase() : undefined;
      const reason = policy && library && !library.startsWith("*") ? checkLibrary(policy, library) : undefined;
      if (reason) throw new Error(`Blocked by policy: cl.run (${reason})`);
    }
    // The approval is for the SBMJOB as it will run, so the policy and the person see the text that runs.
    await enforceWritable(ctx, conn, "cl.run", { ...args, command });

    // SBMJOB checks the command it is given in the submitting job, which is the connection's own: a
    // validity checker that asks a question there leaves that job waiting, and the submit times out.
    let stuckSubmit: { connectionJob?: string; withinSeconds: number } | undefined;
    const mayEnd = mayEndJobs(policy);
    const result = await runTestJob(conn, connectionName, options, {
      now: () => Date.now(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      mayEnd,
      runCl: async text => {
        const submitting = /^SBMJOB\b/i.test(text);
        const began = Date.now();
        const ran = await runClCommand(conn, text, "ile", undefined, 30000);
        // Only when it was this submit that is still running in the connection's job.
        if (submitting && clTimedOut(ran)) stuckSubmit = { connectionJob: runningConnectionJob(conn, began), withinSeconds: Math.ceil((Date.now() - began) / 1000) + 10 };
        return ran;
      }
    });
    log("info", "audit.jobs.runTest", { connectionName, jobName: result.jobName, outcome: result.outcome, seconds: result.seconds });
    const notice = await waitingJobsNotice(conn, connectionName, stuckSubmit ? { ...stuckSubmit, mayEnd } : undefined);
    return json({ ...result, ...notice });
  }

  throw new Error(`Unknown tool: ${name}`);
}

export const jobWatchModule: ToolModule = {
  tools: [
    {
      name: "ibmi.jobs.runTest",
      description:
        "Run a CL command as a watched batch job, to try a program out. Submits it (SBMJOB), waits for it to end, and returns how it ended. " +
        "If the job asks a question (an inquiry message) or is still running when its time is up, the job is ended and the result says so; it is not left waiting on a message or asking in a loop. " +
        "The job runs with INQMSGRPY(*DFT): the system gives a question its default reply, and the job is ended at the next look (within a few seconds); this tool itself never replies to a message. " +
        "Use this, not ibmi.cl.run or SQL CALL, for a program that has not run before: a program called in the connection's own job can leave that shared job stuck.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "What the job runs: one CL command without comments, for example CALL PGM(MYLIB/MYPGM) PARM('A')." },
          jobName: { type: "string", description: "Start of the job name (its first six characters are kept; random characters are added so the job cannot be confused with another). Left out, a name is made up." },
          libraryList: { type: "array", items: { type: "string" }, description: "The job's library list (INLLIBL). Left out, the job description decides." },
          currentLibrary: { type: "string", description: "The job's current library (CURLIB)." },
          jobQueue: { type: "string", description: "Job queue, NAME or LIBRARY/NAME. Left out, the job description decides." },
          jobDescription: { type: "string", description: "Job description, NAME or LIBRARY/NAME. Left out, the user profile's." },
          timeoutSeconds: { type: "number", description: `How long the job may take before it is ended (default ${DEFAULT_TEST_JOB_SECONDS}, at most ${MAX_TEST_JOB_SECONDS}). Includes time spent on the job queue. Keep it under the client's own time limit for a tool call.` },
          onInquiry: { type: "string", enum: ["end", "report"], description: "When the job asks a question: end it (default) or leave it and report." },
          onTimeout: { type: "string", enum: ["end", "report"], description: "When time is up: end it (default) or leave it and report." },
          connectionName: { type: "string" },
          approve: { type: "boolean" }
        },
        required: ["command"]
      },
      annotations: TEST_ANNOTATIONS
    },
    {
      name: "ibmi.jobs.waiting",
      description:
        "List the jobs working for the connection's user that are waiting on a message (status MSGW), with the message when it can be read. " +
        "Includes database server jobs running under another user on this user's behalf; leaves out interactive sessions. Says which of them were submitted from here.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" }, connectionName: { type: "string" } }
      },
      annotations: READ_ANNOTATIONS
    }
  ],
  handle,
  onDisconnect: connectionName => forgetOwnJobs(connectionName)
};
