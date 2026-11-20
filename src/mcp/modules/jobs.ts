import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { clampInteger, isMissingRoutineError, json, readSpooledFileData, requireQsysName } from "../tools.js";
import { Tools } from "../../ibmi/Tools.js";
import { makeAliasName } from "../../ibmi/sourceDates.js";
import { currentUser } from "./jobWatch.js";
import { diagnoseJobLog, isOwnProgram, messageFromRow, parseJobLogText, type JobLogMessage, type ProgramPoint } from "../../ibmi/jobLog.js";

/**
 * Jobs and their logs, to find out why something failed.
 *
 * - ibmi.jobs.find: jobs in any state (active, on a job queue, ended with output), not only active ones.
 * - ibmi.jobs.log: the job log of any job, every column, filtered and paged; a log that has already
 *   been printed is read from its QPJOBLOG spooled file and comes back in the same shape.
 * - ibmi.jobs.diagnose: the reading of a log a person does first, done once and the same for every
 *   client: how the job ended, the message that ended it, what led to it, whose program and where.
 * - ibmi.jobs.stack: the call stack of a job (what it is doing now, or where it is stuck).
 * - ibmi.joblog.parse: the same reading for job log text that was saved or pasted.
 * - ibmi.source.locateStatement: from a program and a statement number to the source line.
 *
 * All of it only reads. The functions are exported so the local workbench page shows exactly what
 * the tools return.
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
type Conn = any;

const QUALIFIED_JOB = /^(\d{6})\/([A-Z#@$][A-Z0-9#@$_.]{0,9})\/([A-Z#@$][A-Z0-9#@$_.]{0,9})$/;
const NAME = /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/;
const GENERIC = /^[A-Z#@$*][A-Z0-9#@$_.*]{0,9}$/;
const MESSAGE_TYPES = ["COMMAND", "COMPLETION", "DIAGNOSTIC", "ESCAPE", "INFORMATIONAL", "INQUIRY", "NOTIFY", "REPLY", "REQUEST", "SCOPE", "SENDER"];
const JOB_STATES = ["*ALL", "*ACTIVE", "*JOBQ", "*OUTQ"];

export const DEFAULT_LOG_MESSAGES = 200;
export const MAX_LOG_MESSAGES = 5000;
/** How much of a job log a diagnosis reads: the end of it, where the failure is. */
const DIAGNOSE_MESSAGES = 3000;
/** The longest printed job log read from spool, in lines. */
const MAX_SPOOLED_LINES = 60000;
const HELP_IN_DIAGNOSIS = 1500;

/** A job name as number/user/name, or "*" for the connection's own job. */
export function requireJob(value: unknown, allowCurrent = true): string {
  const raw = String(value ?? "").trim().toUpperCase();
  if (allowCurrent && (raw === "" || raw === "*")) return "*";
  if (!QUALIFIED_JOB.test(raw)) throw new Error(`jobName must be number/user/name (for example 123456/QPGMR/NIGHTLY)${allowCurrent ? ', or "*" for the connection\'s own job' : ""}.`);
  return raw;
}

function splitJob(job: string) {
  const match = job.match(QUALIFIED_JOB);
  return match ? { number: match[1], user: match[2], name: match[3] } : undefined;
}

function text(value: unknown) {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str === "" ? undefined : str;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) if (obj[key] === undefined || obj[key] === null) delete obj[key];
  return obj;
}

function likePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "%");
}

// ---------------------------------------------------------------------------
// ibmi.jobs.find
// ---------------------------------------------------------------------------

export type FoundJob = {
  jobName: string;
  state: string;
  /** For an active job: what it is doing now (RUN, MSGW, DEQW, ...). */
  activeStatus?: string;
  function?: string;
  type?: string;
  subsystem?: string;
  entered?: string;
  started?: string;
  ended?: string;
  completion?: string;
  endReason?: string;
  jobQueue?: string;
  submittedBy?: string;
  jobLogPending?: boolean;
};

export async function findJobs(conn: Conn, args: any): Promise<{ user: string; state: string; jobs: FoundJob[]; truncated: boolean; warnings?: string[] }> {
  const asked = String(args?.userName ?? "").trim().toUpperCase();
  const user = asked === "" ? (await currentUser(conn)).toUpperCase() : asked;
  if (user !== "*ALL" && !NAME.test(user)) throw new Error(`Invalid userName: ${args?.userName}`);
  const state = String(args?.state ?? "*ALL").trim().toUpperCase();
  if (!JOB_STATES.includes(state)) throw new Error(`state must be one of ${JOB_STATES.join(", ")}`);
  const name = String(args?.name ?? "").trim().toUpperCase();
  if (name && !GENERIC.test(name)) throw new Error(`Invalid name: ${args?.name}`);
  if (user === "*ALL" && !name) throw new Error("Give a job name (it may end in *) when looking across all users.");
  const limit = clampInteger(args?.limit, 1, 1000, 100);
  const sinceHours = args?.sinceHours === undefined || args?.sinceHours === null ? undefined : clampInteger(args.sinceHours, 1, 24 * 90, 24);

  const params = [`JOB_STATUS_FILTER => ${Tools.sqlString(state)}`, user === "*ALL" ? "JOB_USER_FILTER => '*ALL'" : `JOB_USER_FILTER => ${Tools.sqlString(user)}`];
  const where: string[] = [];
  if (name) where.push(name.includes("*") ? `JOB_NAME_SHORT like ${Tools.sqlString(likePattern(name))} escape '\\'` : `JOB_NAME_SHORT = ${Tools.sqlString(name)}`);
  if (sinceHours) where.push(`JOB_ENTERED_SYSTEM_TIME >= current timestamp - ${sinceHours} hours`);
  const rows: Record<string, unknown>[] = await conn.runSQL(
    "select JOB_NAME, JOB_STATUS, JOB_TYPE_ENHANCED, JOB_SUBSYSTEM, SUBMITTER_JOB_NAME, JOB_ENTERED_SYSTEM_TIME, JOB_ACTIVE_TIME, JOB_END_TIME, " +
    "COMPLETION_STATUS, JOB_END_REASON, JOB_QUEUE_LIBRARY, JOB_QUEUE_NAME, JOB_LOG_PENDING " +
    `from table(qsys2.job_info(${params.join(", ")})) x${where.length ? ` where ${where.join(" and ")}` : ""} ` +
    `order by JOB_ENTERED_SYSTEM_TIME desc fetch first ${limit + 1} rows only`
  );
  const truncated = rows.length > limit;
  const jobs = rows.slice(0, limit).map((row): FoundJob => compact({
    jobName: String(row.JOB_NAME ?? "").trim(),
    state: String(row.JOB_STATUS ?? "").trim(),
    type: text(row.JOB_TYPE_ENHANCED),
    subsystem: text(row.JOB_SUBSYSTEM),
    entered: text(row.JOB_ENTERED_SYSTEM_TIME),
    started: text(row.JOB_ACTIVE_TIME),
    ended: text(row.JOB_END_TIME),
    completion: text(row.COMPLETION_STATUS),
    endReason: text(row.JOB_END_REASON),
    jobQueue: text(row.JOB_QUEUE_NAME) ? `${text(row.JOB_QUEUE_LIBRARY) || "*LIBL"}/${text(row.JOB_QUEUE_NAME)}` : undefined,
    submittedBy: text(row.SUBMITTER_JOB_NAME),
    jobLogPending: text(row.JOB_LOG_PENDING) === "YES" ? true : undefined
  }));

  // What the active ones are doing now: one look, only when there are any and a user narrows it.
  const warnings: string[] = [];
  const active = jobs.filter(job => job.state === "ACTIVE");
  if (active.length > 0 && user !== "*ALL") {
    try {
      const live: Record<string, unknown>[] = await conn.runSQL(
        `select JOB_NAME, JOB_STATUS, FUNCTION_TYPE, FUNCTION from table(qsys2.active_job_info(CURRENT_USER_LIST_FILTER => ${Tools.sqlString(user)}, DETAILED_INFO => 'NONE')) x`
      );
      const byName = new Map(live.map(row => [String(row.JOB_NAME ?? "").trim(), row]));
      for (const job of active) {
        const row = byName.get(job.jobName);
        if (!row) continue;
        job.activeStatus = text(row.JOB_STATUS);
        const fn = text(row.FUNCTION);
        if (fn) job.function = `${text(row.FUNCTION_TYPE) || ""}-${fn}`.replace(/^-/, "");
      }
    } catch (err: any) {
      warnings.push(`What the active jobs are doing could not be read: ${String(err?.message || err).slice(0, 200)}`);
    }
  }
  return { user, state, jobs, truncated, ...(warnings.length ? { warnings } : {}) };
}

// ---------------------------------------------------------------------------
// ibmi.jobs.log
// ---------------------------------------------------------------------------

export type JobLogResult = {
  jobName: string;
  /** "live": read from the job's message queue; "spooled": read from its printed job log. */
  source: "live" | "spooled";
  messages: JobLogMessage[];
  /** How many messages match in all, when the system counted them. */
  total?: number;
  truncated: boolean;
  /** Give this as `after` to read only what was logged since (a live tail). */
  lastPosition?: number;
  spooledFile?: { name: string; number: number };
  notes?: string[];
};

type LogFilter = { after?: number; types?: string[]; minSeverity?: number; messageId?: string; contains?: string; order: "oldest" | "newest"; limit: number; help: boolean };

function logFilter(args: any, defaultLimit = DEFAULT_LOG_MESSAGES): LogFilter {
  const types = (Array.isArray(args?.types) ? args.types : args?.types ? [args.types] : [])
    .map((t: unknown) => String(t).trim().toUpperCase().replace(/^INFORMATION$/, "INFORMATIONAL"))
    .filter(Boolean);
  for (const type of types) if (!MESSAGE_TYPES.includes(type)) throw new Error(`types may hold: ${MESSAGE_TYPES.join(", ")}`);
  const messageId = String(args?.messageId ?? "").trim().toUpperCase();
  if (messageId && !/^[A-Z0-9*]{1,7}$/.test(messageId)) throw new Error("messageId is a message id such as CPF9801, or a start with * (CPF*).");
  const order = String(args?.order ?? "oldest").toLowerCase();
  if (order !== "oldest" && order !== "newest") throw new Error('order must be "oldest" or "newest"');
  return {
    after: args?.after === undefined || args?.after === null ? undefined : clampInteger(args.after, 0, 2_000_000_000, 0),
    types: types.length ? types : undefined,
    minSeverity: args?.minSeverity === undefined || args?.minSeverity === null ? undefined : clampInteger(args.minSeverity, 0, 99, 0),
    messageId: messageId || undefined,
    contains: text(args?.contains)?.slice(0, 200),
    order,
    limit: clampInteger(args?.limit, 1, MAX_LOG_MESSAGES, defaultLimit),
    help: args?.includeHelp !== false
  };
}

function matches(message: JobLogMessage, filter: LogFilter) {
  if (filter.after !== undefined && message.position <= filter.after) return false;
  if (filter.types && !filter.types.includes(message.type)) return false;
  if (filter.minSeverity !== undefined && (message.severity ?? 0) < filter.minSeverity) return false;
  if (filter.messageId) {
    const id = message.id || "";
    if (filter.messageId.includes("*") ? !new RegExp(`^${filter.messageId.replace(/\*/g, ".*")}$`).test(id) : id !== filter.messageId) return false;
  }
  if (filter.contains) {
    const needle = filter.contains.toUpperCase();
    if (!`${message.text}\n${message.help || ""}`.toUpperCase().includes(needle)) return false;
  }
  return true;
}

export function buildJobLogSql(job: string, filter: LogFilter) {
  const where: string[] = [];
  if (filter.after !== undefined) where.push(`ORDINAL_POSITION > ${filter.after}`);
  if (filter.types) where.push(`MESSAGE_TYPE in (${filter.types.map(t => Tools.sqlString(t)).join(", ")})`);
  if (filter.minSeverity !== undefined) where.push(`SEVERITY >= ${filter.minSeverity}`);
  if (filter.messageId) where.push(filter.messageId.includes("*") ? `MESSAGE_ID like ${Tools.sqlString(likePattern(filter.messageId))} escape '\\'` : `MESSAGE_ID = ${Tools.sqlString(filter.messageId)}`);
  if (filter.contains) {
    const needle = Tools.sqlString(`%${likePattern(filter.contains.toUpperCase())}%`);
    where.push(`(upper(MESSAGE_TEXT) like ${needle} escape '\\' or upper(cast(MESSAGE_SECOND_LEVEL_TEXT as varchar(4000))) like ${needle} escape '\\')`);
  }
  return (
    "select ORDINAL_POSITION, hex(MESSAGE_KEY) as MESSAGE_KEY_HEX, MESSAGE_ID, MESSAGE_TYPE, SEVERITY, MESSAGE_TIMESTAMP, " +
    "FROM_LIBRARY, FROM_PROGRAM, FROM_MODULE, FROM_PROCEDURE, FROM_INSTRUCTION, TO_LIBRARY, TO_PROGRAM, TO_MODULE, TO_PROCEDURE, TO_INSTRUCTION, " +
    `FROM_USER, MESSAGE_TEXT, ${filter.help ? "MESSAGE_SECOND_LEVEL_TEXT" : "cast(null as varchar(1)) as MESSAGE_SECOND_LEVEL_TEXT"}, count(*) over () as TOTAL_MESSAGES ` +
    `from table(qsys2.joblog_info(${Tools.sqlString(job)})) x${where.length ? ` where ${where.join(" and ")}` : ""} ` +
    `order by ORDINAL_POSITION ${filter.order === "newest" ? "desc" : "asc"} fetch first ${filter.limit + 1} rows only`
  );
}

/** The printed job log of a job, newest one, when it has one. */
async function spooledJobLog(conn: Conn, job: string): Promise<{ name: string; number: number } | undefined> {
  const rows: Record<string, unknown>[] = await conn.runSQL(
    `select SPOOLED_FILE_NAME, SPOOLED_FILE_NUMBER from table(qsys2.spooled_file_info(JOB_NAME => ${Tools.sqlString(job)})) x ` +
    "where SPOOLED_FILE_NAME = 'QPJOBLOG' order by CREATION_TIMESTAMP desc fetch first 1 row only"
  );
  const number = Number(rows[0]?.SPOOLED_FILE_NUMBER);
  return rows.length && Number.isFinite(number) ? { name: "QPJOBLOG", number } : undefined;
}

export async function readJobLog(conn: Conn, args: any, defaultLimit = DEFAULT_LOG_MESSAGES): Promise<JobLogResult> {
  const job = requireJob(args?.jobName);
  const filter = logFilter(args, defaultLimit);
  let liveError: string | undefined;
  try {
    const rows: Record<string, unknown>[] = await conn.runSQL(buildJobLogSql(job, filter));
    if (rows.length > 0 || job === "*") {
      const truncated = rows.length > filter.limit;
      const messages = rows.slice(0, filter.limit).map(messageFromRow);
      const total = Number(rows[0]?.TOTAL_MESSAGES);
      return compact({
        jobName: job,
        source: "live" as const,
        messages,
        total: Number.isFinite(total) && rows.length ? total : undefined,
        truncated,
        lastPosition: messages.length ? Math.max(...messages.map(m => m.position)) : filter.after
      });
    }
  } catch (err: any) {
    if (job === "*") throw err;
    liveError = String(err?.message || err).slice(0, 300);
  }

  // Nothing live: the job has ended and its log was printed, or it has no log to read.
  let spooled: { name: string; number: number } | undefined;
  try {
    spooled = await spooledJobLog(conn, job);
  } catch (err: any) {
    if (!isMissingRoutineError(err)) liveError = liveError || String(err?.message || err).slice(0, 300);
  }
  if (!spooled) {
    if (liveError) throw new Error(`The job log of ${job} could not be read: ${liveError}`);
    return { jobName: job, source: "live", messages: [], truncated: false, lastPosition: filter.after, notes: ["No messages match, and the job has no printed job log (QPJOBLOG)."] };
  }
  const lines: Record<string, unknown>[] = await readSpooledFileData(conn, job, spooled.name, spooled.number, MAX_SPOOLED_LINES);
  const parsed = parseJobLogText(lines.map(row => String(row.SPOOLED_DATA ?? "")).join("\n"));
  const all = parsed.messages.filter(message => matches(message, filter));
  if (!filter.help) for (const message of all) delete message.help;
  const ordered = filter.order === "newest" ? [...all].reverse() : all;
  const notes = [...parsed.notes];
  if (lines.length >= MAX_SPOOLED_LINES) notes.push(`Only the first ${MAX_SPOOLED_LINES} lines of the printed job log were read.`);
  return compact({
    jobName: job,
    source: "spooled" as const,
    messages: ordered.slice(0, filter.limit),
    total: all.length,
    truncated: all.length > filter.limit,
    lastPosition: parsed.messages.length ? parsed.messages[parsed.messages.length - 1].position : undefined,
    spooledFile: spooled,
    notes: notes.length ? notes : undefined
  });
}

// ---------------------------------------------------------------------------
// ibmi.jobs.stack
// ---------------------------------------------------------------------------

export type StackEntry = { position: number; thread?: string; kind?: string; library?: string; program?: string; module?: string; procedure?: string; statement?: string; activationGroup?: string; own: boolean };

export async function jobStack(conn: Conn, args: any): Promise<{ jobName: string; entries: StackEntry[]; truncated: boolean }> {
  const job = requireJob(args?.jobName);
  const limit = clampInteger(args?.limit, 1, 2000, 200);
  const ownOnly = args?.ownOnly === true;
  const allThreads = args?.allThreads === true;
  const rows: Record<string, unknown>[] = await conn.runSQL(
    "select THREAD_ID, ORDINAL_POSITION, ENTRY_TYPE, PROGRAM_LIBRARY_NAME, PROGRAM_NAME, MODULE_NAME, PROCEDURE_NAME, STATEMENT_IDENTIFIERS, ACTIVATION_GROUP_NAME, " +
    "PASE_PROCEDURE_NAME, JAVA_CLASS_NAME, JAVA_METHOD_NAME, JAVA_LINE_NUMBER " +
    `from table(qsys2.stack_info(${Tools.sqlString(job)}${allThreads ? ", 'ALL'" : ""})) x order by THREAD_ID, ORDINAL_POSITION desc fetch first ${limit + 1} rows only`
  );
  let entries = rows.slice(0, limit).map((row): StackEntry => {
    const kind = text(row.ENTRY_TYPE);
    const place: ProgramPoint = { library: text(row.PROGRAM_LIBRARY_NAME), program: text(row.PROGRAM_NAME) };
    const java = text(row.JAVA_CLASS_NAME) ? `${text(row.JAVA_CLASS_NAME)}.${text(row.JAVA_METHOD_NAME) || ""}` : undefined;
    // STATEMENT_IDENTIFIERS can hold several, blank separated; leading zeros say nothing.
    const statement = text(row.STATEMENT_IDENTIFIERS)?.split(/\s+/).map(s => s.replace(/^0+(?=\d)/, "")).join(" ");
    return compact({
      position: Number(row.ORDINAL_POSITION) || 0,
      thread: allThreads ? text(row.THREAD_ID) : undefined,
      kind,
      library: place.library,
      program: place.program,
      module: text(row.MODULE_NAME),
      procedure: text(row.PROCEDURE_NAME) || text(row.PASE_PROCEDURE_NAME) || java,
      statement: statement || (text(row.JAVA_LINE_NUMBER) ? String(row.JAVA_LINE_NUMBER) : undefined),
      activationGroup: text(row.ACTIVATION_GROUP_NAME),
      own: isOwnProgram(place)
    });
  });
  if (ownOnly) entries = entries.filter(entry => entry.own);
  return { jobName: job, entries, truncated: rows.length > limit };
}

// ---------------------------------------------------------------------------
// ibmi.source.locateStatement
// ---------------------------------------------------------------------------

export type StatementLocation = {
  program: { library: string; name: string; objectType?: string; module?: string; attribute?: string; debugData?: string };
  source?: { library?: string; file?: string; member?: string; streamFile?: string };
  statement: string;
  /** Line in the source as it is now (1 = first line), when it could be worked out. */
  line?: number;
  lineText?: string;
  /**
   * exact: CL, whose statement numbers are the source sequence numbers.
   * probable: the statement matches one source sequence number; right when the module was compiled with OPTION(*SRCSTMT).
   * unknown: the source is known, the line is not.
   */
  confidence: "exact" | "probable" | "unknown";
  sourceChangedSinceCompile?: boolean;
  modules?: string[];
  notes: string[];
};

const CL_ATTRIBUTE = /^CL/;

export async function locateStatement(conn: Conn, args: any): Promise<StatementLocation> {
  const library = requireQsysName(conn, args?.library, "library");
  const program = requireQsysName(conn, args?.program, "program");
  const wantedModule = args?.module ? requireQsysName(conn, args.module, "module") : undefined;
  const objectType = args?.objectType ? String(args.objectType).trim().toUpperCase() : undefined;
  if (objectType && objectType !== "*PGM" && objectType !== "*SRVPGM") throw new Error("objectType must be *PGM or *SRVPGM");
  const statement = String(args?.statement ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{1,10}$/.test(statement)) throw new Error("statement is the statement number from the job log or call stack.");
  const notes: string[] = [];
  const where = `PROGRAM_LIBRARY = ${Tools.sqlString(library)} and PROGRAM_NAME = ${Tools.sqlString(program)}${objectType ? ` and OBJECT_TYPE = ${Tools.sqlString(objectType)}` : ""}`;

  const info: Record<string, unknown>[] = await conn.runSQL(
    "select OBJECT_TYPE, PROGRAM_TYPE, PROGRAM_ATTRIBUTE, SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_FILE_MEMBER, SOURCE_FILE_CHANGE_TIMESTAMP, " +
    `PROGRAM_ENTRY_PROCEDURE_MODULE from QSYS2.PROGRAM_INFO where ${where} fetch first 2 rows only`
  );
  if (info.length === 0) throw new Error(`${library}/${program} was not found as a program or service program (or you are not authorised to it).`);
  if (info.length > 1 && !objectType) notes.push(`${library}/${program} exists as both *PGM and *SRVPGM; the ${text(info[0].OBJECT_TYPE)} was used. Give objectType to choose.`);
  const head = info[0];
  const out: StatementLocation = {
    program: compact({ library, name: program, objectType: text(head.OBJECT_TYPE), attribute: text(head.PROGRAM_ATTRIBUTE) }),
    statement,
    confidence: "unknown",
    notes
  };

  let source: StatementLocation["source"];
  let compiledFrom: string | undefined;
  let modules: Record<string, unknown>[] = [];
  try {
    modules = await conn.runSQL(
      "select BOUND_MODULE, MODULE_ATTRIBUTE, SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_FILE_MEMBER, SOURCE_STREAM_FILE_PATH, SOURCE_CHANGE_TIMESTAMP, DEBUG_DATA " +
      `from QSYS2.BOUND_MODULE_INFO where ${where}${text(head.OBJECT_TYPE) ? ` and OBJECT_TYPE = ${Tools.sqlString(String(head.OBJECT_TYPE).trim())}` : ""} fetch first 500 rows only`
    );
  } catch (err: any) {
    if (!isMissingRoutineError(err)) notes.push(`The program's modules could not be read: ${String(err?.message || err).slice(0, 200)}`);
  }
  if (modules.length > 0) {
    const names = modules.map(row => String(row.BOUND_MODULE ?? "").trim());
    const pick = wantedModule
      ? modules.find(row => String(row.BOUND_MODULE ?? "").trim() === wantedModule)
      : modules.length === 1 ? modules[0] : modules.find(row => String(row.BOUND_MODULE ?? "").trim() === text(head.PROGRAM_ENTRY_PROCEDURE_MODULE));
    if (!pick) {
      out.modules = names;
      notes.push(wantedModule ? `Module ${wantedModule} is not bound into ${library}/${program}.` : "The program has several modules: give the module the message names (From module / To module).");
      return out;
    }
    if (!wantedModule && modules.length > 1) notes.push(`The program has ${modules.length} modules; its entry module ${String(pick.BOUND_MODULE).trim()} was assumed. Give module to be sure.`);
    out.program.module = String(pick.BOUND_MODULE ?? "").trim();
    out.program.attribute = text(pick.MODULE_ATTRIBUTE) || out.program.attribute;
    out.program.debugData = text(pick.DEBUG_DATA);
    source = compact({ library: text(pick.SOURCE_FILE_LIBRARY), file: text(pick.SOURCE_FILE), member: text(pick.SOURCE_FILE_MEMBER), streamFile: text(pick.SOURCE_STREAM_FILE_PATH) });
    compiledFrom = text(pick.SOURCE_CHANGE_TIMESTAMP);
  } else {
    // An OPM program: one source member, named by the program itself.
    source = compact({ library: text(head.SOURCE_FILE_LIBRARY), file: text(head.SOURCE_FILE), member: text(head.SOURCE_FILE_MEMBER) });
    compiledFrom = text(head.SOURCE_FILE_CHANGE_TIMESTAMP);
  }
  if (!source || (!source.member && !source.streamFile)) {
    notes.push("The object does not say which source it was compiled from.");
    return out;
  }
  out.source = source;

  if (!/^\d+$/.test(statement)) {
    notes.push("This is a machine instruction number, not a source statement: the program has no statement numbers at this point (system code, or compiled without them).");
    return out;
  }
  const number = Number(statement);
  const cl = CL_ATTRIBUTE.test(out.program.attribute || "");

  if (source.streamFile) {
    // Stream file source has no sequence numbers; with OPTION(*SRCSTMT) the statement number is the line number.
    out.line = number;
    out.confidence = "probable";
    notes.push("Source is a stream file: the statement number is the line number when the module was compiled with OPTION(*SRCSTMT). Otherwise it is a line of the compile listing.");
    return out;
  }

  const srcLib = source.library!, srcFile = source.file!, srcMbr = source.member!;
  if (![srcLib, srcFile, srcMbr].every(part => conn.validQsysName(part))) {
    notes.push("The source location recorded in the object is not a usable member name.");
    return out;
  }
  try {
    const changed: Record<string, unknown>[] = await conn.runSQL(
      "select LAST_SOURCE_UPDATE_TIMESTAMP from QSYS2.SYSPARTITIONSTAT " +
      `where SYSTEM_TABLE_SCHEMA = ${Tools.sqlString(srcLib)} and SYSTEM_TABLE_NAME = ${Tools.sqlString(srcFile)} and SYSTEM_TABLE_MEMBER = ${Tools.sqlString(srcMbr)} fetch first 1 row only`
    );
    if (changed.length === 0) {
      notes.push(`The source member ${srcLib}/${srcFile}(${srcMbr}) the object was compiled from is not there any more (or cannot be seen): the source may have moved.`);
      return out;
    }
    const now = text(changed[0].LAST_SOURCE_UPDATE_TIMESTAMP);
    if (now && compiledFrom) out.sourceChangedSinceCompile = now.slice(0, 19) !== compiledFrom.slice(0, 19);
    if (out.sourceChangedSinceCompile) notes.push("The member has been changed since the program was compiled: the line may have moved.");
  } catch (err: any) {
    notes.push(`The member's change date could not be read: ${String(err?.message || err).slice(0, 160)}`);
  }

  // Statement numbers are source sequence numbers without the decimal point: sequence 0012.00 is statement 1200.
  const sequence = (number / 100).toFixed(2);
  const alias = `QTEMP."${makeAliasName(`${srcLib}/${srcFile}/${srcMbr}`)}"`;
  const rows: Record<string, unknown>[] = await conn.runSQL(
    `create or replace alias ${alias} for "${srcLib}"."${srcFile}"("${srcMbr}");\n` +
    "select X.LINE_NUMBER, X.SRCDTA, X.LINES from (" +
    `select row_number() over (order by rrn(M)) as LINE_NUMBER, M.SRCSEQ, M.SRCDTA, count(*) over () as LINES from ${alias} as M) as X ` +
    `where X.SRCSEQ = ${sequence} order by X.LINE_NUMBER fetch first 3 rows only`
  );
  if (rows.length === 1) {
    out.line = Number(rows[0].LINE_NUMBER);
    out.lineText = String(rows[0].SRCDTA ?? "").replace(/\s+$/, "");
    out.confidence = cl ? "exact" : "probable";
    if (!cl) notes.push("The statement matches one source sequence number. That is the failing line when the module was compiled with OPTION(*SRCSTMT); without it the number counts lines of the compile listing (copy members and generated lines included) and the real line is at or before this number.");
    if (out.sourceChangedSinceCompile && out.confidence === "exact") out.confidence = "probable";
  } else if (rows.length > 1) {
    notes.push(`Sequence number ${sequence} is on more than one line of the member (it was not renumbered): the line cannot be told.`);
  } else {
    notes.push(cl
      ? `No line of the member has sequence number ${sequence}: the member was renumbered or changed since the compile.`
      : `No line of the member has sequence number ${sequence}, so the module was not compiled with OPTION(*SRCSTMT): ${number} is a line of the compile listing. Read the listing (ibmi.compile.listing) or look near line ${number} or before it.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ibmi.jobs.diagnose
// ---------------------------------------------------------------------------

/** A message of the chain without its second-level text: the failure and the root cause carry theirs in full. */
function brief(message: JobLogMessage) {
  const { help: _help, key: _key, fromUser: _fromUser, ...rest } = message;
  return rest;
}

function trimHelp(message: JobLogMessage | undefined): JobLogMessage | undefined {
  if (!message) return undefined;
  if (!message.help || message.help.length <= HELP_IN_DIAGNOSIS) return message;
  return { ...message, help: `${message.help.slice(0, HELP_IN_DIAGNOSIS)} …` };
}

export async function diagnoseJob(conn: Conn, args: any) {
  const job = requireJob(args?.jobName);
  const log = await readJobLog(conn, { jobName: job, order: "newest", limit: DIAGNOSE_MESSAGES, includeHelp: true }, DIAGNOSE_MESSAGES);
  const diagnosis = diagnoseJobLog(log.messages);
  const notes = [...diagnosis.notes, ...(log.notes || [])];
  if (log.truncated) notes.push(`The log is long: only its last ${DIAGNOSE_MESSAGES} messages were read.`);

  // What the system itself knows about the job.
  let jobInfo: Record<string, unknown> | undefined;
  const parts = splitJob(job);
  if (parts) {
    try {
      const rows: Record<string, unknown>[] = await conn.runSQL(
        "select JOB_STATUS, JOB_TYPE_ENHANCED, JOB_SUBSYSTEM, JOB_ENTERED_SYSTEM_TIME, JOB_ACTIVE_TIME, JOB_END_TIME, COMPLETION_STATUS, JOB_END_REASON, SUBMITTER_JOB_NAME, JOB_DESCRIPTION_LIBRARY, JOB_DESCRIPTION " +
        `from table(qsys2.job_info(JOB_USER_FILTER => ${Tools.sqlString(parts.user)})) x where JOB_NAME = ${Tools.sqlString(job)} fetch first 1 row only`
      );
      jobInfo = rows[0];
    } catch (err: any) {
      notes.push(`The job's own details could not be read: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  const state = text(jobInfo?.JOB_STATUS);
  const completion = text(jobInfo?.COMPLETION_STATUS);
  let verdict = diagnosis.verdict;
  if (completion === "ABNORMAL" && verdict !== "waiting") verdict = "failed";

  // A job that is waiting, or still active with a failure in its log: where it stands now.
  let stack: StackEntry[] | undefined;
  if (state === "ACTIVE" && (diagnosis.waitingOn || diagnosis.failure)) {
    try {
      const got = await jobStack(conn, { jobName: job, limit: 300 });
      const own = got.entries.filter(entry => entry.own);
      stack = (own.length ? own : got.entries).slice(0, 25);
    } catch (err: any) {
      notes.push(`The call stack could not be read: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  let location: StatementLocation | undefined;
  const suspect = diagnosis.suspect;
  if (suspect?.library && suspect.program && suspect.statement && args?.locate !== false) {
    try {
      location = await locateStatement(conn, { library: suspect.library, program: suspect.program, module: suspect.module, statement: suspect.statement.split(/\s+/)[0] });
    } catch (err: any) {
      notes.push(`The source of ${suspect.library}/${suspect.program} could not be located: ${String(err?.message || err).slice(0, 200)}`);
    }
  }

  const failure = diagnosis.waitingOn || diagnosis.failure;
  const where = suspect ? `${suspect.library}/${suspect.program}${suspect.statement ? ` statement ${suspect.statement}` : ""}` : undefined;
  /** A message as one sentence: its id and text, with one full stop. */
  const said = (message: JobLogMessage | undefined) => `${message?.id || "A message"}: ${(message?.text || "").replace(/[.\s]+$/, "")}.`;
  const root = diagnosis.rootCause && diagnosis.rootCause !== failure ? diagnosis.rootCause : undefined;
  const began = root ? ` It began with ${said(root)}` : "";
  const summary =
    verdict === "waiting" ? `The job is waiting for a reply to ${said(failure)}`
    : verdict === "failed" ? `${failure ? said(failure) : completion === "ABNORMAL" ? `The job ended abnormally (${text(jobInfo?.JOB_END_REASON) || "no reason given"}).` : "The job failed."}${began}${where ? ` In ${where}.` : ""}`
    : verdict === "warnings" ? `The job did not fail, but its log has ${diagnosis.counts.severe} message(s) of severity 30 or more${failure ? `. The last escape was ${said(failure)}` : "."}`
    : "Nothing in the log says the job failed.";

  return compact({
    jobName: job,
    source: log.source,
    verdict,
    summary,
    job: jobInfo ? compact({
      state,
      type: text(jobInfo.JOB_TYPE_ENHANCED),
      subsystem: text(jobInfo.JOB_SUBSYSTEM),
      entered: text(jobInfo.JOB_ENTERED_SYSTEM_TIME),
      started: text(jobInfo.JOB_ACTIVE_TIME),
      ended: text(jobInfo.JOB_END_TIME),
      completion,
      endReason: text(jobInfo.JOB_END_REASON),
      submittedBy: text(jobInfo.SUBMITTER_JOB_NAME),
      jobDescription: text(jobInfo.JOB_DESCRIPTION) ? `${text(jobInfo.JOB_DESCRIPTION_LIBRARY)}/${text(jobInfo.JOB_DESCRIPTION)}` : undefined
    }) : undefined,
    ended: diagnosis.ended,
    counts: { messages: diagnosis.messages, ...diagnosis.counts },
    waitingOn: trimHelp(diagnosis.waitingOn),
    failure: trimHelp(diagnosis.failure),
    rootCause: diagnosis.rootCause && diagnosis.rootCause !== diagnosis.failure ? trimHelp(diagnosis.rootCause) : undefined,
    chain: diagnosis.chain.map(brief),
    suspect,
    location,
    stack,
    notes: notes.length ? [...new Set(notes)] : undefined
  });
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const JOB_NAME_PROPERTY = { type: "string", description: 'The job as number/user/name (123456/QPGMR/NIGHTLY). Left out or "*": the connection\'s own job.' };

async function handle(ctx: McpContext, name: string, args: any) {
  if (name === "ibmi.joblog.parse") {
    const body = String(args?.text ?? "");
    if (!body.trim()) throw new Error("text is required: the text of a printed job log.");
    if (body.length > 20 * 1024 * 1024) throw new Error("That text is too large to read as a job log (20 MB at most).");
    const parsed = parseJobLogText(body);
    const diagnosis = diagnoseJobLog(parsed.messages);
    const limit = clampInteger(args?.limit, 0, MAX_LOG_MESSAGES, DEFAULT_LOG_MESSAGES);
    const filter = logFilter({ ...args, limit: Math.max(1, limit) });
    const all = parsed.messages.filter(message => matches(message, filter));
    const ordered = filter.order === "newest" ? [...all].reverse() : all;
    return json(compact({
      job: parsed.job,
      system: parsed.system,
      release: parsed.release,
      dateOrder: parsed.dateOrder,
      verdict: diagnosis.verdict,
      ended: diagnosis.ended,
      counts: { messages: diagnosis.messages, ...diagnosis.counts },
      waitingOn: trimHelp(diagnosis.waitingOn),
      failure: trimHelp(diagnosis.failure),
      rootCause: diagnosis.rootCause && diagnosis.rootCause !== diagnosis.failure ? trimHelp(diagnosis.rootCause) : undefined,
      chain: diagnosis.chain.map(brief),
      suspect: diagnosis.suspect,
      messages: limit === 0 ? undefined : ordered.slice(0, limit),
      total: all.length,
      truncated: limit > 0 && all.length > limit,
      notes: [...parsed.notes, ...diagnosis.notes].length ? [...new Set([...parsed.notes, ...diagnosis.notes])] : undefined
    }));
  }
  const conn = await ctx.ensureActive(args?.connectionName);
  switch (name) {
    case "ibmi.jobs.find": return json(await findJobs(conn, args));
    case "ibmi.jobs.log": return json(await readJobLog(conn, args));
    case "ibmi.jobs.diagnose": return json(await diagnoseJob(conn, args));
    case "ibmi.jobs.stack": return json(await jobStack(conn, args));
    case "ibmi.source.locateStatement": return json(await locateStatement(conn, args));
  }
  throw new Error(`Unknown tool: ${name}`);
}

const FILTER_PROPERTIES = {
  types: { type: "array", items: { type: "string", enum: MESSAGE_TYPES }, description: "Only these message types, for example [\"ESCAPE\", \"DIAGNOSTIC\"]." },
  minSeverity: { type: "number", description: "Only messages of this severity or more (30 and up are the serious ones)." },
  messageId: { type: "string", description: "Only this message id, or ids that start alike (CPF*)." },
  contains: { type: "string", description: "Only messages whose text or second-level text holds this (case does not matter)." },
  order: { type: "string", enum: ["oldest", "newest"], description: "oldest first (default) or newest first." },
  limit: { type: "number", description: `How many messages at most (default ${DEFAULT_LOG_MESSAGES}, up to ${MAX_LOG_MESSAGES}).` }
};

export const jobsModule: ToolModule = {
  tools: [
    {
      name: "ibmi.jobs.find",
      description:
        "Find jobs in any state: active, waiting on a job queue, or ended with output still on the system (ibmi.jobs.list shows active jobs only). " +
        "Newest first, with how each ended (normal or abnormal, and why) and, for an active one, what it is doing now (MSGW = waiting on a message). " +
        "Left to itself it lists the connection user's own jobs.",
      inputSchema: {
        type: "object",
        properties: {
          userName: { type: "string", description: "Whose jobs. Left out: the connection's user. *ALL needs a name." },
          name: { type: "string", description: "Job name, or the start of one with * (NIGHT*)." },
          state: { type: "string", enum: JOB_STATES, description: "*ALL (default), *ACTIVE, *JOBQ, or *OUTQ (ended, output still there)." },
          sinceHours: { type: "number", description: "Only jobs that entered the system in the last so many hours." },
          limit: { type: "number", description: "How many at most (default 100)." },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    },
    {
      name: "ibmi.jobs.log",
      description:
        "Read the job log of any job: every message with its type, severity, time, second-level text (cause and recovery), and the program, module, procedure and statement it was sent from and to. " +
        "Works for a running job, and for an ended one whose log was printed (it is then read from the QPJOBLOG spooled file and returned in the same shape; source says which). " +
        "To follow a running job, pass the lastPosition of one answer as after in the next. To find out why a job failed, use ibmi.jobs.diagnose first.",
      inputSchema: {
        type: "object",
        properties: {
          jobName: JOB_NAME_PROPERTY,
          after: { type: "number", description: "Only messages logged after this position (the lastPosition of an earlier answer)." },
          ...FILTER_PROPERTIES,
          includeHelp: { type: "boolean", description: "Second-level text with each message (default true). false makes a long log much smaller." },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    },
    {
      name: "ibmi.jobs.diagnose",
      description:
        "Find out why a job failed or is stuck, in one call. Reads the end of its job log and returns: a verdict (failed, waiting, warnings, clean), how the job ended, the message that ended it or that it waits on, " +
        "the messages that led to it (oldest first), the program of the site's own nearest the cause with its statement, where that statement is in the source (library, file, member, line, and how sure that is), " +
        "and for a job that is still active its call stack. Start here, then read the source at the line given.",
      inputSchema: {
        type: "object",
        properties: {
          jobName: JOB_NAME_PROPERTY,
          locate: { type: "boolean", description: "Look up the source line of the failing statement (default true)." },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    },
    {
      name: "ibmi.jobs.stack",
      description:
        "The call stack of a job, newest call first: program, module, procedure and statement of each entry, and which entries are the site's own code (own: true). " +
        "For a job waiting on a message or looping, this says where it is.",
      inputSchema: {
        type: "object",
        properties: {
          jobName: JOB_NAME_PROPERTY,
          ownOnly: { type: "boolean", description: "Leave out the system's own programs." },
          allThreads: { type: "boolean", description: "Every thread of the job, not only the first." },
          limit: { type: "number" },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    },
    {
      name: "ibmi.joblog.parse",
      description:
        "Read the text of a printed job log (a QPJOBLOG spooled file that was saved, or text someone pasted) and return it as messages, with the same diagnosis ibmi.jobs.diagnose gives: verdict, the failing message, what led to it and the program nearest the cause. " +
        "Needs no connection. For a job that is still on the system use ibmi.jobs.log or ibmi.jobs.diagnose instead.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The job log text." },
          ...FILTER_PROPERTIES,
          limit: { type: "number", description: `How many messages to return (default ${DEFAULT_LOG_MESSAGES}); 0 for the diagnosis alone.` }
        },
        required: ["text"]
      },
      annotations: READ
    },
    {
      name: "ibmi.source.locateStatement",
      description:
        "From a program and a statement number (as a job log or call stack gives them) to the source: which member or stream file the module was compiled from, and the line. " +
        "confidence says how sure the line is: exact (CL), probable (the statement matches a source sequence number, right when compiled with OPTION(*SRCSTMT)), or unknown (the notes say why and what to read instead). " +
        "Also says when the source has changed since the program was compiled.",
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string", description: "The program's library." },
          program: { type: "string" },
          objectType: { type: "string", enum: ["*PGM", "*SRVPGM"] },
          module: { type: "string", description: "The module the message names (From module / To module). Needed when the program has several." },
          statement: { type: "string", description: "The statement number." },
          connectionName: { type: "string" }
        },
        required: ["library", "program", "statement"]
      },
      annotations: READ
    }
  ],
  handle
};
