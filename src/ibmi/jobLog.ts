/**
 * Job logs as data: one shape for a message whether it was read live
 * (QSYS2.JOBLOG_INFO) or from the printed job log (QPJOBLOG, saved or pasted
 * text), and the reading of a log a person does first: how did the job end,
 * which message ended it, what led to it, and where in whose program.
 *
 * Nothing here talks to a system; the tools in mcp/modules/jobs.ts do.
 */

export type ProgramPoint = {
  library?: string;
  program?: string;
  module?: string;
  procedure?: string;
  /** Statement or instruction as the system gives it (a statement number, or a hex MI instruction for system code). */
  statement?: string;
};

export type JobLogMessage = {
  /** Place in the log, 1 = oldest. */
  position: number;
  /** Message key (hex), when read live. */
  key?: string;
  id: string | null;
  /** ESCAPE, DIAGNOSTIC, INQUIRY, REPLY, COMPLETION, INFORMATIONAL, COMMAND, REQUEST, NOTIFY, SENDER, ... */
  type: string;
  severity: number | null;
  /** ISO-like local time of the job: 2026-11-19T12:50:33.123456 */
  time: string | null;
  text: string;
  /** Second-level text (cause and recovery), formatting codes turned into line breaks. */
  help?: string;
  from: ProgramPoint;
  to: ProgramPoint;
  fromUser?: string;
};

export type JobLogDiagnosis = {
  messages: number;
  counts: { byType: Record<string, number>; severe: number };
  /** What the log itself says about how the job ended (CPF1164), when it says. */
  ended?: { endCode: number; meaning: string; text: string };
  /** A question nobody has answered yet: the job is waiting on it. */
  waitingOn?: JobLogMessage;
  /** The message that ended the work, or the last serious one when the job did not end. */
  failure?: JobLogMessage;
  /** What led to the failure, oldest first, the failure last. */
  chain: JobLogMessage[];
  /** Where it began: the first serious message (escape or diagnostic) of the chain. */
  rootCause?: JobLogMessage;
  /** The program of the person's own (not the system's) nearest the cause, with its statement. */
  suspect?: ProgramPoint & { role: "received" | "sent"; messageId: string | null };
  verdict: "failed" | "waiting" | "warnings" | "clean";
  notes: string[];
};

const TYPE_NAMES: Record<string, string> = {
  INFORMATION: "INFORMATIONAL",
  INFORMATIONAL: "INFORMATIONAL",
  INFO: "INFORMATIONAL",
  COMPLETION: "COMPLETION",
  DIAGNOSTIC: "DIAGNOSTIC",
  ESCAPE: "ESCAPE",
  INQUIRY: "INQUIRY",
  REPLY: "REPLY",
  REQUEST: "REQUEST",
  COMMAND: "COMMAND",
  NOTIFY: "NOTIFY",
  SENDER: "SENDER",
  "SENDER COPY": "SENDER",
  SCOPE: "SCOPE"
};

export function normalizeType(value: unknown) {
  const raw = String(value ?? "").trim().toUpperCase();
  return TYPE_NAMES[raw] || raw || "UNKNOWN";
}

function clean(value: unknown) {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str === "" || str === "*N" ? undefined : str;
}

function point(row: Record<string, unknown>, prefix: "FROM" | "TO"): ProgramPoint {
  const out: ProgramPoint = {};
  const library = clean(row[`${prefix}_LIBRARY`]);
  const program = clean(row[`${prefix}_PROGRAM`]);
  const module = clean(row[`${prefix}_MODULE`]);
  const procedure = clean(row[`${prefix}_PROCEDURE`]);
  const statement = clean(row[`${prefix}_INSTRUCTION`]);
  if (library) out.library = library;
  if (program) out.program = program;
  if (module) out.module = module;
  if (procedure) out.procedure = procedure;
  if (statement) out.statement = statement;
  return out;
}

/**
 * Second-level text as the system stores it carries formatting codes:
 * &N (new line), &P (new paragraph, indented), &B (new line, indented).
 */
export function formatHelpText(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  return raw
    .replace(/\s*&N\s+/g, "\n")
    .replace(/\s*&P\s+/g, "\n  ")
    .replace(/\s*&B\s+/g, "\n    ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** A JOBLOG_INFO timestamp (2026-11-19-12.50.33.123456) as 2026-11-19T12:50:33.123456. */
export function isoTime(value: unknown) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[-T ](\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d{1,6}))?/);
  if (!match) return raw;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] ? `.${match[5]}` : ""}`;
}

/** One row of QSYS2.JOBLOG_INFO as a message. */
export function messageFromRow(row: Record<string, unknown>): JobLogMessage {
  const severity = Number(row.SEVERITY);
  const message: JobLogMessage = {
    position: Number(row.ORDINAL_POSITION) || 0,
    id: clean(row.MESSAGE_ID) ?? null,
    type: normalizeType(row.MESSAGE_TYPE),
    severity: Number.isFinite(severity) && row.SEVERITY !== null ? severity : null,
    time: isoTime(row.MESSAGE_TIMESTAMP),
    text: String(row.MESSAGE_TEXT ?? "").trim(),
    from: point(row, "FROM"),
    to: point(row, "TO")
  };
  const key = clean(row.MESSAGE_KEY_HEX ?? row.MESSAGE_KEY);
  if (key) message.key = key.replace(/^X'|'$/gi, "").toUpperCase();
  const help = formatHelpText(row.MESSAGE_SECOND_LEVEL_TEXT);
  if (help) message.help = help;
  const fromUser = clean(row.FROM_USER);
  if (fromUser) message.fromUser = fromUser;
  return message;
}

// ---------------------------------------------------------------------------
// Reading a log
// ---------------------------------------------------------------------------

/** Job end codes of CPF1164. */
export const END_CODES: Record<number, string> = {
  0: "The job completed normally.",
  10: "The job completed normally during controlled ending or controlled subsystem ending.",
  20: "The job exceeded end severity (ENDSEV job attribute).",
  30: "The job ended abnormally.",
  40: "The job ended before becoming active.",
  50: "The job ended while the job was active.",
  60: "The subsystem ended abnormally while the job was active.",
  70: "The system ended abnormally while the job was active.",
  80: "The job ended (ENDJOBABN command).",
  90: "The job was forced to end after the time limit ended (ENDJOBABN command)."
};

const SYSTEM_LIBRARY = /^(Q[A-Z0-9#@$_]*|SYSIBM|SYSIBMADM|SYSPROC|SYSTOOLS)$/;

/** A program the person's site wrote: named, and not in a library of the system's. */
export function isOwnProgram(place: ProgramPoint | undefined) {
  if (!place?.program || place.program.startsWith("*")) return false;
  if (!place.library) return false;
  return !SYSTEM_LIBRARY.test(place.library.toUpperCase());
}

const SERIOUS = new Set(["ESCAPE", "DIAGNOSTIC", "INQUIRY", "REPLY", "NOTIFY"]);

function inChain(message: JobLogMessage) {
  if (SERIOUS.has(message.type)) return true;
  return (message.severity ?? 0) >= 30 && message.type !== "COMPLETION";
}

/** Replies that end the work rather than carry it on. */
function cancelReply(text: string) {
  const reply = text.trim().toUpperCase();
  return reply === "C" || reply === "D" || reply === "S" || reply === "F";
}

/**
 * Read a job log the way a person does. `messages` in any order; they are
 * taken oldest first by position.
 */
export function diagnoseJobLog(input: JobLogMessage[], options: { chainLimit?: number } = {}): JobLogDiagnosis {
  const messages = [...input].sort((a, b) => a.position - b.position);
  const chainLimit = Math.max(3, options.chainLimit ?? 15);
  const byType: Record<string, number> = {};
  let severe = 0;
  for (const message of messages) {
    byType[message.type] = (byType[message.type] || 0) + 1;
    if ((message.severity ?? 0) >= 30) severe += 1;
  }
  const out: JobLogDiagnosis = { messages: messages.length, counts: { byType, severe }, chain: [], verdict: "clean", notes: [] };

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.id !== "CPF1164") continue;
    const code = message.text.match(/end code\s+(\d+)/i) || message.help?.match(/end code\s+(\d+)/i);
    if (code) {
      const endCode = Number(code[1]);
      out.ended = { endCode, meaning: END_CODES[endCode] || `End code ${endCode}.`, text: message.text };
    }
    break;
  }

  // A question with no reply after it: the job is waiting on it now.
  let failureAt = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== "INQUIRY") continue;
    const answered = messages.slice(i + 1).some(later => later.type === "REPLY");
    if (!answered && !out.ended) {
      out.waitingOn = messages[i];
      failureAt = i;
    }
    break;
  }

  if (failureAt < 0) {
    // The last escape message is what ended the work, unless a question was answered "cancel" after it:
    // then the question (and what made the system ask it) is the failure.
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.type === "ESCAPE") { failureAt = i; break; }
      if (message.type === "REPLY" && cancelReply(message.text)) {
        for (let q = i - 1; q >= 0; q--) if (messages[q].type === "INQUIRY") { failureAt = q; break; }
        if (failureAt >= 0) break;
      }
    }
  }

  if (failureAt >= 0) {
    out.failure = messages[failureAt];
    // What led to it: the run of serious messages that ends at the failure. One ordinary message
    // may stand between two of them (a command echo, an informational line) without breaking the run.
    const chain: JobLogMessage[] = [messages[failureAt]];
    let gap = 0;
    for (let i = failureAt - 1; i >= 0 && chain.length < chainLimit; i--) {
      if (inChain(messages[i])) { chain.unshift(messages[i]); gap = 0; }
      else if (++gap > 1) break;
    }
    // A reply to the question belongs with it.
    const reply = messages[failureAt].type === "INQUIRY" ? messages.slice(failureAt + 1).find(m => m.type === "REPLY") : undefined;
    if (reply) chain.push(reply);
    out.chain = chain;
    // Where it began: the first serious message of the run (a diagnostic often names the cause before the escape that follows it).
    out.rootCause = chain.find(m => (m.type === "ESCAPE" || m.type === "DIAGNOSTIC") && (m.severity ?? 0) >= 20) || chain.find(m => m.type === "ESCAPE") || messages[failureAt];

    // Whose code: an escape is sent *to* the program that was running the failing statement, so the
    // receiver comes first; a message a program of the person's own sent (SNDPGMMSG) names it as sender.
    const order = [out.rootCause, ...chain.filter(m => m !== out.rootCause)];
    for (const message of order) {
      if (isOwnProgram(message.to)) { out.suspect = { ...message.to, role: "received", messageId: message.id }; break; }
      if (isOwnProgram(message.from)) { out.suspect = { ...message.from, role: "sent", messageId: message.id }; break; }
    }
    if (!out.suspect) out.notes.push("No program outside the system's own libraries is named in the messages that led to the failure.");
  }

  if (out.waitingOn) out.verdict = "waiting";
  else if (out.ended && out.ended.endCode >= 20) out.verdict = "failed";
  else if (out.failure && !out.ended) out.verdict = "failed";
  else if (out.failure || severe > 0) out.verdict = "warnings";

  if (out.failure && out.ended && out.ended.endCode < 20) {
    out.notes.push("The job ended normally; the last escape message was handled by the program that received it, or did not stop the job.");
  }
  if (out.failure && !out.ended && !out.waitingOn) {
    out.notes.push("The log does not say how the job ended (no CPF1164): it may still be running, or the message may have been handled.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// The printed job log (DSPJOBLOG OUTPUT(*PRINT), QPJOBLOG)
// ---------------------------------------------------------------------------

export type ParsedJobLog = {
  job?: { name?: string; user?: string; number?: string; qualified?: string };
  system?: string;
  release?: string;
  dateOrder: "MDY" | "DMY" | "YMD";
  messages: JobLogMessage[];
  notes: string[];
};

type Columns = { type: number; sev: number; date: number; time: number; fromPgm: number; fromLib: number; fromInst: number; toPgm: number; toLib: number; toInst: number };

const DETAIL = /^\s+([A-Za-z][A-Za-z ]*?)\s*(?:\. ?)+:\s?(.*)$/;
const MESSAGE_START = /^\s?(\*NONE|[A-Z][A-Z0-9]{2}[0-9A-F]{4})\s+([A-Za-z]+)\s/;
const PAGE_HEADER = /^\s*5\d{3}\w{3}\s+V\dR\dM\d\b/;

function headerColumns(line: string): Columns | undefined {
  const upper = line.toUpperCase();
  if (!/^\s?MSGID\s+TYPE\s/.test(upper)) return undefined;
  const at = (label: string, from = 0) => upper.indexOf(label, from);
  const fromPgm = at("FROM PGM");
  const toPgm = at("TO PGM");
  if (fromPgm < 0 || toPgm < 0) return undefined;
  const fromLib = at("LIBRARY", fromPgm);
  const toLib = at("LIBRARY", toPgm);
  return {
    type: at("TYPE"),
    sev: at("SEV"),
    date: at("DATE"),
    time: at("TIME"),
    fromPgm,
    fromLib,
    fromInst: at("INST", fromLib),
    toPgm,
    toLib,
    toInst: at("INST", toLib)
  };
}

function slice(line: string, start: number, end?: number) {
  return clean(line.slice(start, end));
}

/** Which of the three parts of a printed date is the day, from the dates themselves; the separator decides a tie. */
function dateOrderOf(dates: string[]): "MDY" | "DMY" | "YMD" {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const date of dates) {
    const parts = date.split(/[./-]/).map(Number);
    if (parts.length !== 3) continue;
    if (parts[0] > 31) return "YMD";
    if (parts[0] > 12) firstOver12 = true;
    if (parts[1] > 12) secondOver12 = true;
  }
  if (firstOver12 && !secondOver12) return "DMY";
  if (secondOver12 && !firstOver12) return "MDY";
  return dates.some(date => date.includes("/")) || dates.length === 0 ? "MDY" : "DMY";
}

function isoFromPrinted(date: string | undefined, time: string | undefined, order: "MDY" | "DMY" | "YMD") {
  if (!date) return null;
  const parts = date.split(/[./-]/);
  if (parts.length !== 3) return null;
  const [a, b, c] = parts;
  let [year, month, day] = order === "YMD" ? [a, b, c] : order === "DMY" ? [c, b, a] : [c, a, b];
  if (year.length === 2) year = `${Number(year) >= 40 ? "19" : "20"}${year}`;
  const clock = (time || "00:00:00").replace(/^(\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d+))?.*$/, (_m, h, m, s, f) => `${h}:${m}:${s}${f ? `.${f}` : ""}`);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${clock}`;
}

/**
 * Read the text of a printed job log. Columns are taken from the heading line
 * of the page (so a blank library or instruction does not shift what follows);
 * a log without a heading is read by position in the line as the system prints it.
 */
export function parseJobLogText(text: string): ParsedJobLog {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: ParsedJobLog = { dateOrder: "MDY", messages: [], notes: [] };
  let columns: Columns | undefined;
  type Draft = { message: JobLogMessage; date?: string; clock?: string; field?: "text" | "help"; side: "from" | "to" };
  const drafts: Draft[] = [];
  let current: Draft | undefined;

  for (const raw of lines) {
    const line = raw.replace(/\f/g, "").replace(/\s+$/, "");
    if (!line.trim()) continue;

    if (PAGE_HEADER.test(line)) {
      const release = line.match(/V\dR\dM\d/);
      if (release) out.release = release[0];
      const system = line.match(/\b([A-Z0-9_]{1,8})\s+\d{2}[./-]\d{2}[./-]\d{2}\s+\d{2}[:.]\d{2}[:.]\d{2}/);
      if (system) out.system = system[1];
      continue;
    }
    const jobLine = line.match(/Job name[ .]*:\s*(\S+)\s+User[ .]*:\s*(\S+)\s+Number[ .]*:\s*(\d+)/i);
    if (jobLine) {
      out.job = { name: jobLine[1], user: jobLine[2], number: jobLine[3], qualified: `${jobLine[3]}/${jobLine[2]}/${jobLine[1]}` };
      continue;
    }
    if (/^\s*Job description[ .]*:/i.test(line)) continue;
    const header = headerColumns(line);
    if (header) { columns = header; continue; }

    const start = line.match(MESSAGE_START);
    if (start && (!columns || line.search(/\S/) <= 1)) {
      const id = start[1] === "*NONE" ? null : start[1];
      let type: string, sev: string | undefined, date: string | undefined, clock: string | undefined;
      const from: ProgramPoint = {};
      const to: ProgramPoint = {};
      if (columns) {
        type = slice(line, columns.type, columns.sev) || "";
        sev = slice(line, columns.sev, columns.date);
        date = slice(line, columns.date, columns.time);
        clock = slice(line, columns.time, columns.fromPgm);
        const set = (place: ProgramPoint, pgm?: string, lib?: string, inst?: string) => {
          if (pgm) place.program = pgm;
          if (lib) place.library = lib;
          if (inst) place.statement = inst;
        };
        set(from, slice(line, columns.fromPgm, columns.fromLib), slice(line, columns.fromLib, columns.fromInst), slice(line, columns.fromInst, columns.toPgm));
        set(to, slice(line, columns.toPgm, columns.toLib), slice(line, columns.toLib, columns.toInst), slice(line, columns.toInst));
      } else {
        const tokens = line.trim().split(/\s+/);
        type = tokens[1] || "";
        let at = 2;
        if (/^\d{1,2}$/.test(tokens[at] || "")) sev = tokens[at++];
        date = tokens[at++];
        clock = tokens[at++];
        const rest = tokens.slice(at);
        // Without a heading the six trailing fields cannot be told from each other when one is blank;
        // they are taken in order only when all six are there.
        if (rest.length === 6) {
          [from.program, from.library, from.statement, to.program, to.library, to.statement] = rest;
        } else if (rest.length > 0) {
          from.program = rest[0];
          out.notes.push("A message line had blank fields and no page heading to place them by: its program names may be incomplete.");
        }
      }
      const severity = sev !== undefined && /^\d+$/.test(sev) ? Number(sev) : null;
      current = {
        message: { position: drafts.length + 1, id, type: normalizeType(type), severity, time: null, text: "", from, to },
        date,
        clock,
        side: "from"
      };
      // *STMT in the instruction column says the statement is on a line of its own below.
      for (const place of [current.message.from, current.message.to]) {
        if (place.statement === "*N" || place.statement === "*STMT") delete place.statement;
        if (place.program === "*N") delete place.program;
      }
      drafts.push(current);
      continue;
    }

    if (!current) continue;
    const detail = line.match(DETAIL);
    const label = detail ? detail[1].trim().toLowerCase() : "";
    const value = detail ? detail[2].trim() : "";
    if (detail && label === "message") { current.message.text = value; current.field = "text"; continue; }
    if (detail && (label === "cause" || label === "recovery" || label === "technical description")) {
      const titled = `${detail[1].trim()} . . . . . :   ${value}`;
      current.message.help = current.message.help ? `${current.message.help}\n${titled}` : titled;
      current.field = "help";
      continue;
    }
    if (detail && label === "from module") { if (value) current.message.from.module = value; current.side = "from"; current.field = undefined; continue; }
    if (detail && label === "from procedure") { if (value) current.message.from.procedure = value; current.side = "from"; current.field = undefined; continue; }
    if (detail && label === "to module") { if (value) current.message.to.module = value; current.side = "to"; current.field = undefined; continue; }
    if (detail && label === "to procedure") { if (value) current.message.to.procedure = value; current.side = "to"; current.field = undefined; continue; }
    if (detail && label === "statement") {
      // A Statement line belongs to the module and procedure lines just above it (the sender's or the receiver's).
      const place = current.side === "from" ? current.message.from : current.message.to;
      if (value) place.statement = value;
      current.side = "to";
      current.field = undefined;
      continue;
    }
    if (detail && label === "from user") { if (value) current.message.fromUser = value; current.field = undefined; continue; }
    if (detail && (label === "thread" || label === "from job" || label === "to job")) { current.field = undefined; continue; }
    // A line that carries on the message or its second-level text.
    if (current.field === "text") current.message.text = `${current.message.text} ${line.trim()}`.trim();
    else if (current.field === "help") current.message.help = `${current.message.help} ${line.trim()}`;
  }

  out.dateOrder = dateOrderOf(drafts.map(draft => draft.date || "").filter(Boolean));
  for (const draft of drafts) {
    draft.message.time = isoFromPrinted(draft.date, draft.clock, out.dateOrder);
    // The printed log runs cause and recovery together in one paragraph.
    if (draft.message.help) draft.message.help = draft.message.help.replace(/\s+(Recovery|Technical description)\s*(?:\. ?)+:\s*/g, "\n$1 . . . :   ");
    out.messages.push(draft.message);
  }
  if (!out.job) {
    // A fragment without its page heading: the job names itself in its start and end messages.
    const named = out.messages.find(m => m.id === "CPF1124" || m.id === "CPF1164")?.text.match(/(\d{6})\/([A-Z0-9#@$_.]+)\/([A-Z0-9#@$_.]+)/);
    if (named) out.job = { number: named[1], user: named[2], name: named[3], qualified: `${named[1]}/${named[2]}/${named[3]}` };
  }
  if (out.messages.length === 0) out.notes.push("No job log messages were found in this text.");
  out.notes = [...new Set(out.notes)];
  return out;
}
