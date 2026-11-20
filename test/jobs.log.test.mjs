import test from "node:test";
import assert from "node:assert/strict";
// tools.js first: it loads the tool modules.
import { getTools } from "../dist/mcp/tools.js";
import { diagnoseJobLog, formatHelpText, isOwnProgram, isoTime, messageFromRow, parseJobLogText } from "../dist/ibmi/jobLog.js";
import { buildJobLogSql, diagnoseJob, findJobs, jobStack, locateStatement, readJobLog, requireJob } from "../dist/mcp/modules/jobs.js";

// A printed job log in the system's own layout (names made up).
const PRINTED = [
  " 5770SS1 V7R5M0 220415                           Job Log                            TESTSYS   11/19/26  12:27:28 EST     Page    1",
  "  Job name . . . . . . . . . . :   NIGHTLY         User  . . . . . . :   DEVUSER      Number . . . . . . . . . . . :   529971",
  "  Job description  . . . . . . :   DEVJOBD         Library . . . . . :   QGPL",
  "MSGID      TYPE                    SEV  DATE      TIME             FROM PGM     LIBRARY     INST     TO PGM      LIBRARY     INST",
  "CPF1124    Information             00   11/19/26  12:27:28.894742  QWTPIIPP     QSYS        04DC     *EXT                    *N",
  "                                     Message . . . . :   Job 529971/DEVUSER/NIGHTLY started on 11/19/26 at",
  "                                       12:27:28 in subsystem QBATCH in QGPL.",
  "*NONE      Request                      11/19/26  12:27:28.895588  QWTSCSBJ                 *N       QCMD        QSYS        0195",
  "                                     Message . . . . :  -CALL PGM(DEVLIB/ORDPOST) PARM('A')",
  "CPF503E    Sender copy             30   11/19/26  12:27:28.932106  QDBIOERRQO   QSYS        *STMT    QDBIOERRQO  QSYS        *STMT",
  "                                     From module . . . . . . . . :   QDBIOERRQO",
  "                                     From procedure  . . . . . . :   SEND_MESSAGE",
  "                                     Statement . . . . . . . . . :   4170",
  "                                     To module . . . . . . . . . :   QDBIOERRQO",
  "                                     To procedure  . . . . . . . :   SEND_MESSAGE",
  "                                     Statement . . . . . . . . . :   4170",
  "                                     Message . . . . :   User-defined function error on member QSQPTABL.",
  "MCH1211    Escape                  40   11/19/26  12:27:28.932500  QRNXIE       QSYS        *STMT    ORDPOST     DEVLIB      *STMT",
  "                                     From module . . . . . . . . :   QRNXMSG",
  "                                     From procedure  . . . . . . :   SignalException",
  "                                     Statement . . . . . . . . . :   21",
  "                                     To module . . . . . . . . . :   ORDPOST",
  "                                     To procedure  . . . . . . . :   CALCTOTAL",
  "                                     Statement . . . . . . . . . :   4200",
  "                                     Message . . . . :   Attempt made to divide by zero for fixed point",
  "                                       operation.",
  "                                     Cause . . . . . :   The divisor was zero. Recovery  . . . :   Change the",
  "                                       program so the divisor is not zero.",
  " 5770SS1 V7R5M0 220415                           Job Log                            TESTSYS   11/19/26  12:27:28 EST     Page    2",
  "  Job name . . . . . . . . . . :   NIGHTLY         User  . . . . . . :   DEVUSER      Number . . . . . . . . . . . :   529971",
  "  Job description  . . . . . . :   DEVJOBD         Library . . . . . :   QGPL",
  "MSGID      TYPE                    SEV  DATE      TIME             FROM PGM     LIBRARY     INST     TO PGM      LIBRARY     INST",
  "RNQ0102    Inquiry                 99   11/19/26  12:27:28.940000  QRNXIE       QSYS        *STMT    QRNXIE      QSYS        *STMT",
  "                                     From module . . . . . . . . :   QRNXMSG",
  "                                     From procedure  . . . . . . :   InqMsg",
  "                                     Statement . . . . . . . . . :   7",
  "                                     To module . . . . . . . . . :   QRNXMSG",
  "                                     To procedure  . . . . . . . :   InqMsg",
  "                                     Statement . . . . . . . . . :   7",
  "                                     Message . . . . :   Attempt to divide by zero (C G D F).",
  "*NONE      Reply                        11/19/26  12:27:28.941000  QMHSCLVL     QSYS        0000     QRNXIE      QSYS        *STMT",
  "                                     Message . . . . :   C",
  "CPF1164    Completion              00   11/19/26  12:27:28.990000  QWTMCEOJ     QSYS        0118     *EXT                    *N",
  "                                     Message . . . . :   Job 529971/DEVUSER/NIGHTLY ended on 11/19/26 at 12:27:28;",
  "                                       .018 seconds used; end code 30 ."
].join("\n");

test("a printed job log is read into messages by the page's own columns", () => {
  const parsed = parseJobLogText(PRINTED);
  assert.deepEqual(parsed.job, { name: "NIGHTLY", user: "DEVUSER", number: "529971", qualified: "529971/DEVUSER/NIGHTLY" });
  assert.equal(parsed.release, "V7R5M0");
  assert.equal(parsed.system, "TESTSYS");
  assert.equal(parsed.dateOrder, "MDY");
  assert.equal(parsed.messages.length, 7);
  const [start, request, sender, escape, inquiry, reply, end] = parsed.messages;
  assert.equal(start.id, "CPF1124");
  assert.equal(start.type, "INFORMATIONAL");
  assert.equal(start.time, "2026-11-19T12:27:28.894742");
  assert.match(start.text, /^Job 529971\/DEVUSER\/NIGHTLY started on 11\/19\/26 at 12:27:28 in subsystem QBATCH in QGPL\.$/);
  assert.deepEqual(start.to, { program: "*EXT" });
  // A blank library and a blank severity do not shift the columns that follow.
  assert.equal(request.id, null);
  assert.equal(request.severity, null);
  assert.deepEqual(request.from, { program: "QWTSCSBJ" });
  assert.deepEqual(request.to, { program: "QCMD", library: "QSYS", statement: "0195" });
  assert.equal(sender.type, "SENDER");
  assert.equal(sender.from.statement, "4170");
  assert.deepEqual(escape.to, { program: "ORDPOST", library: "DEVLIB", module: "ORDPOST", procedure: "CALCTOTAL", statement: "4200" });
  assert.equal(escape.from.statement, "21");
  assert.equal(escape.text, "Attempt made to divide by zero for fixed point operation.");
  assert.equal(escape.help, "Cause . . . . . :   The divisor was zero.\nRecovery . . . :   Change the program so the divisor is not zero.");
  assert.equal(inquiry.severity, 99);
  assert.equal(reply.text, "C");
  assert.equal(end.id, "CPF1164");
});

test("the date order is taken from the dates themselves", () => {
  const dmy = PRINTED.replace(/11\/19\/26/g, "19.11.26");
  assert.equal(parseJobLogText(dmy).dateOrder, "DMY");
  assert.equal(parseJobLogText(dmy).messages[0].time, "2026-11-19T12:27:28.894742");
  assert.equal(parseJobLogText(PRINTED.replace(/11\/19\/26/g, "11/05/26")).dateOrder, "MDY", "ambiguous dates with a slash stay month first");
  assert.equal(parseJobLogText(PRINTED.replace(/11\/19\/26/g, "2026-11-19")).dateOrder, "YMD");
});

test("text that is not a job log yields no messages and says so", () => {
  const parsed = parseJobLogText("hello\nworld");
  assert.equal(parsed.messages.length, 0);
  assert.match(parsed.notes.join(" "), /No job log messages/);
});

test("a fragment without its page heading still names its job", () => {
  const body = PRINTED.split("\n").slice(4).join("\n");
  const parsed = parseJobLogText(body);
  assert.equal(parsed.job.qualified, "529971/DEVUSER/NIGHTLY");
  assert.ok(parsed.messages.length >= 6);
});

test("the diagnosis finds the failure, what led to it and whose program", () => {
  const diagnosis = diagnoseJobLog(parseJobLogText(PRINTED).messages);
  assert.equal(diagnosis.verdict, "failed");
  assert.equal(diagnosis.ended.endCode, 30);
  // The question answered "C" is what ended the work; the escape before it is where it began.
  assert.equal(diagnosis.failure.id, "RNQ0102");
  assert.equal(diagnosis.rootCause.id, "MCH1211");
  assert.deepEqual(diagnosis.chain.map(m => m.id), ["CPF503E", "MCH1211", "RNQ0102", null]);
  assert.deepEqual(diagnosis.suspect, { program: "ORDPOST", library: "DEVLIB", module: "ORDPOST", procedure: "CALCTOTAL", statement: "4200", role: "received", messageId: "MCH1211" });
  assert.equal(diagnosis.counts.byType.ESCAPE, 1);
});

test("a question nobody answered means the job is waiting", () => {
  const messages = parseJobLogText(PRINTED).messages.slice(0, 5);
  const diagnosis = diagnoseJobLog(messages);
  assert.equal(diagnosis.verdict, "waiting");
  assert.equal(diagnosis.waitingOn.id, "RNQ0102");
  assert.equal(diagnosis.suspect.program, "ORDPOST");
});

test("a handled escape in a job that ended normally is a warning, and a quiet log is clean", () => {
  const messages = parseJobLogText(PRINTED).messages;
  const handled = [messages[0], messages[3], { ...messages[6], text: messages[6].text.replace("end code 30", "end code 0") }];
  const diagnosis = diagnoseJobLog(handled);
  assert.equal(diagnosis.verdict, "warnings");
  assert.match(diagnosis.notes.join(" "), /ended normally/);
  assert.equal(diagnoseJobLog([messages[0]]).verdict, "clean");
  assert.equal(diagnoseJobLog([]).verdict, "clean");
});

test("rows of JOBLOG_INFO become the same message shape", () => {
  const message = messageFromRow({
    ORDINAL_POSITION: 7, MESSAGE_KEY_HEX: "000B1CFA", MESSAGE_ID: "CPF9898", MESSAGE_TYPE: "ESCAPE", SEVERITY: 40,
    MESSAGE_TIMESTAMP: "2026-11-19-12.27.28.932581", FROM_LIBRARY: "DEVLIB", FROM_PROGRAM: "ORDPOST", FROM_MODULE: "ORDPOST", FROM_PROCEDURE: "ORDPOST",
    FROM_INSTRUCTION: "32300", TO_LIBRARY: "QSYS", TO_PROGRAM: "QCMD", TO_MODULE: null, TO_PROCEDURE: null, TO_INSTRUCTION: "01C8", FROM_USER: "DEVUSER",
    MESSAGE_TEXT: "Something failed.", MESSAGE_SECOND_LEVEL_TEXT: "&N Cause . . . . . :   It broke. &N Recovery  . . . :   Fix it. &P More."
  });
  assert.equal(message.position, 7);
  assert.equal(message.key, "000B1CFA");
  assert.equal(message.time, "2026-11-19T12:27:28.932581");
  assert.deepEqual(message.from, { library: "DEVLIB", program: "ORDPOST", module: "ORDPOST", procedure: "ORDPOST", statement: "32300" });
  assert.deepEqual(message.to, { library: "QSYS", program: "QCMD", statement: "01C8" });
  assert.equal(message.help, "Cause . . . . . :   It broke.\nRecovery  . . . :   Fix it.\n  More.");
  assert.equal(formatHelpText(""), undefined);
  assert.equal(isoTime(null), null);
  assert.equal(isOwnProgram({ library: "QSYS", program: "QCMD" }), false);
  assert.equal(isOwnProgram({ library: "DEVLIB", program: "ORDPOST" }), true);
  assert.equal(isOwnProgram({ program: "*EXT" }), false);
});

test("job names are checked before they reach SQL", () => {
  assert.equal(requireJob(undefined), "*");
  assert.equal(requireJob(" 123456/qpgmr/nightly "), "123456/QPGMR/NIGHTLY");
  assert.throws(() => requireJob("123456/QPGMR/NIGHTLY' or 1=1 --"), /number\/user\/name/);
  assert.throws(() => requireJob("NIGHTLY"), /number\/user\/name/);
  assert.throws(() => requireJob("*", false), /number\/user\/name/);
});

test("the job log statement carries the filters, and nothing unchecked", () => {
  const sql = buildJobLogSql("123456/QPGMR/NIGHTLY", { after: 40, types: ["ESCAPE", "DIAGNOSTIC"], minSeverity: 30, messageId: "CPF*", contains: "it's 100%", order: "newest", limit: 50, help: false });
  assert.match(sql, /joblog_info\('123456\/QPGMR\/NIGHTLY'\)/);
  assert.match(sql, /ORDINAL_POSITION > 40/);
  assert.match(sql, /MESSAGE_TYPE in \('ESCAPE', 'DIAGNOSTIC'\)/);
  assert.match(sql, /SEVERITY >= 30/);
  assert.match(sql, /MESSAGE_ID like 'CPF%'/);
  assert.match(sql, /like '%IT''S 100\\%%' escape/);
  assert.match(sql, /order by ORDINAL_POSITION desc fetch first 51 rows only/);
  assert.match(sql, /cast\(null as varchar\(1\)\) as MESSAGE_SECOND_LEVEL_TEXT/);
});

/** A connection that answers each statement from the first rule whose text it holds. */
function fakeConn(rules) {
  const seen = [];
  return {
    seen,
    currentUser: "DEVUSER",
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/.test(name),
    getConfig: () => ({}),
    runSQL: async sql => {
      seen.push(sql);
      for (const [needle, answer] of rules) {
        if (sql.includes(needle)) {
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(sql) : answer;
        }
      }
      return [];
    }
  };
}

const LIVE_ROWS = [
  { ORDINAL_POSITION: 3, MESSAGE_ID: "CPF9898", MESSAGE_TYPE: "ESCAPE", SEVERITY: 40, MESSAGE_TIMESTAMP: "2026-11-19-12.27.28.932581", FROM_LIBRARY: "DEVLIB", FROM_PROGRAM: "ORDPOST", FROM_MODULE: "ORDPOST", FROM_PROCEDURE: "ORDPOST", FROM_INSTRUCTION: "32300", TO_LIBRARY: "QSYS", TO_PROGRAM: "QCMD", TO_INSTRUCTION: "01C8", MESSAGE_TEXT: "Data area missing.", TOTAL_MESSAGES: 3 },
  { ORDINAL_POSITION: 2, MESSAGE_ID: "CPF1015", MESSAGE_TYPE: "DIAGNOSTIC", SEVERITY: 40, MESSAGE_TIMESTAMP: "2026-11-19-12.27.28.900000", FROM_LIBRARY: "QSYS", FROM_PROGRAM: "QWCCRTEC", FROM_INSTRUCTION: "01A3", TO_LIBRARY: "DEVLIB", TO_PROGRAM: "ORDPOST", TO_MODULE: "ORDPOST", TO_PROCEDURE: "ORDPOST", TO_INSTRUCTION: "32000", MESSAGE_TEXT: "Data area ORDCTL in *LIBL not found.", TOTAL_MESSAGES: 3 },
  { ORDINAL_POSITION: 1, MESSAGE_ID: "CPF1124", MESSAGE_TYPE: "INFORMATIONAL", SEVERITY: 0, MESSAGE_TIMESTAMP: "2026-11-19-12.27.28.800000", FROM_LIBRARY: "QSYS", FROM_PROGRAM: "QWTPIIPP", TO_PROGRAM: "*EXT", MESSAGE_TEXT: "Job started.", TOTAL_MESSAGES: 3 }
];

test("a live job log comes back with its count and the place to carry on from", async () => {
  const conn = fakeConn([["joblog_info", LIVE_ROWS]]);
  const log = await readJobLog(conn, { jobName: "529971/DEVUSER/NIGHTLY", order: "newest", limit: 2 });
  assert.equal(log.source, "live");
  assert.equal(log.messages.length, 2);
  assert.equal(log.truncated, true);
  assert.equal(log.total, 3);
  assert.equal(log.lastPosition, 3);
});

test("a job whose log was printed is read from its spooled file in the same shape", async () => {
  const conn = fakeConn([
    ["joblog_info", new Error("[SQL0443] JOB 529971/DEVUSER/NIGHTLY NOT FOUND")],
    ["spooled_file_info", [{ SPOOLED_FILE_NAME: "QPJOBLOG", SPOOLED_FILE_NUMBER: 2 }]],
    ["spooled_file_data", PRINTED.split("\n").map((line, i) => ({ ORDINAL_POSITION: i + 1, SPOOLED_DATA: line }))]
  ]);
  const log = await readJobLog(conn, { jobName: "529971/DEVUSER/NIGHTLY", types: ["ESCAPE"] });
  assert.equal(log.source, "spooled");
  assert.deepEqual(log.spooledFile, { name: "QPJOBLOG", number: 2 });
  assert.deepEqual(log.messages.map(m => m.id), ["MCH1211"]);
  assert.equal(log.total, 1);
  assert.equal(log.lastPosition, 7);
});

test("a job that is not there says so in the system's words", async () => {
  const conn = fakeConn([["joblog_info", new Error("[SQL0443] JOB 999999/NOBODY/NOJOB NOT FOUND")]]);
  await assert.rejects(readJobLog(conn, { jobName: "999999/NOBODY/NOJOB" }), /could not be read: .*NOT FOUND/);
});

const MEMBER_ROWS = sql => (sql.includes("X.SRCSEQ = 323.00") ? [{ LINE_NUMBER: 323, SRCDTA: "  SendEscape('CPF9898');   ", LINES: 900 }] : []);

function programConn(extra = []) {
  return fakeConn([
    ...extra,
    ["QSYS2.PROGRAM_INFO", [{ OBJECT_TYPE: "*PGM", PROGRAM_TYPE: "ILE", PROGRAM_ATTRIBUTE: "RPGLE", PROGRAM_ENTRY_PROCEDURE_MODULE: "ORDPOST" }]],
    ["QSYS2.BOUND_MODULE_INFO", [{ BOUND_MODULE: "ORDPOST", MODULE_ATTRIBUTE: "RPGLE", SOURCE_FILE_LIBRARY: "DEVLIB", SOURCE_FILE: "QRPGLESRC", SOURCE_FILE_MEMBER: "ORDPOST", SOURCE_CHANGE_TIMESTAMP: "2026-11-18-09.00.00.000000", DEBUG_DATA: "*YES" }]],
    ["QSYS2.SYSPARTITIONSTAT", [{ LAST_SOURCE_UPDATE_TIMESTAMP: "2026-11-18-09.00.00.000000" }]],
    ["create or replace alias", MEMBER_ROWS]
  ]);
}

test("a statement is found in the source by its sequence number", async () => {
  const found = await locateStatement(programConn(), { library: "devlib", program: "ordpost", statement: "32300" });
  assert.deepEqual(found.source, { library: "DEVLIB", file: "QRPGLESRC", member: "ORDPOST" });
  assert.equal(found.line, 323);
  assert.equal(found.lineText, "  SendEscape('CPF9898');");
  assert.equal(found.confidence, "probable");
  assert.equal(found.sourceChangedSinceCompile, false);
  assert.match(found.notes.join(" "), /\*SRCSTMT/);

  const missed = await locateStatement(programConn(), { library: "DEVLIB", program: "ORDPOST", statement: "512" });
  assert.equal(missed.line, undefined);
  assert.equal(missed.confidence, "unknown");
  assert.match(missed.notes.join(" "), /compile listing/);

  const machine = await locateStatement(programConn(), { library: "DEVLIB", program: "ORDPOST", statement: "04DC" });
  assert.equal(machine.confidence, "unknown");
  assert.match(machine.notes.join(" "), /machine instruction/);
  await assert.rejects(locateStatement(programConn(), { library: "DEVLIB", program: "ORDPOST", statement: "1; drop" }), /statement number/);
});

test("a program with several modules asks which one", async () => {
  const conn = fakeConn([
    ["QSYS2.PROGRAM_INFO", [{ OBJECT_TYPE: "*SRVPGM", PROGRAM_ATTRIBUTE: "RPGLE" }]],
    ["QSYS2.BOUND_MODULE_INFO", [{ BOUND_MODULE: "A" }, { BOUND_MODULE: "B" }]]
  ]);
  const found = await locateStatement(conn, { library: "DEVLIB", program: "SRV", statement: "100" });
  assert.deepEqual(found.modules, ["A", "B"]);
  assert.equal(found.source, undefined);
});

test("diagnosing a job brings the log, the job and the source line together", async () => {
  const conn = programConn([
    ["joblog_info", LIVE_ROWS],
    ["qsys2.job_info", [{ JOB_STATUS: "OUTQ", JOB_TYPE_ENHANCED: "BATCH", COMPLETION_STATUS: "ABNORMAL", JOB_END_REASON: "JOB ENDED DUE TO THE MESSAGE SEVERITY LEVEL BEING EXCEEDED" }]]
  ]);
  const got = await diagnoseJob(conn, { jobName: "529971/DEVUSER/NIGHTLY" });
  assert.equal(got.verdict, "failed");
  assert.equal(got.failure.id, "CPF9898");
  assert.equal(got.rootCause.id, "CPF1015");
  assert.equal(got.suspect.program, "ORDPOST");
  assert.equal(got.suspect.statement, "32000");
  assert.equal(got.summary, "CPF9898: Data area missing. It began with CPF1015: Data area ORDCTL in *LIBL not found. In DEVLIB/ORDPOST statement 32000.");
  assert.equal(got.location.source.member, "ORDPOST");
  assert.equal(got.chain.every(m => m.help === undefined), true);
  assert.equal(got.stack, undefined, "an ended job has no call stack to read");
});

test("jobs are found for the connection's user unless another is named", async () => {
  const conn = fakeConn([
    ["qsys2.job_info", [
      { JOB_NAME: "000002/DEVUSER/B", JOB_STATUS: "ACTIVE", JOB_TYPE_ENHANCED: "BATCH" },
      { JOB_NAME: "000001/DEVUSER/A", JOB_STATUS: "OUTQ", COMPLETION_STATUS: "ABNORMAL", JOB_QUEUE_NAME: "QBATCH", JOB_QUEUE_LIBRARY: "QGPL", JOB_LOG_PENDING: "NO" }
    ]],
    ["active_job_info", [{ JOB_NAME: "000002/DEVUSER/B", JOB_STATUS: "MSGW", FUNCTION_TYPE: "PGM", FUNCTION: "ORDPOST" }]],
    ["current user", [{ CURRENT_USER_NAME: "DEVUSER" }]]
  ]);
  const got = await findJobs(conn, { limit: 1 });
  assert.equal(got.user, "DEVUSER");
  assert.equal(got.truncated, true);
  assert.deepEqual(got.jobs, [{ jobName: "000002/DEVUSER/B", state: "ACTIVE", type: "BATCH", activeStatus: "MSGW", function: "PGM-ORDPOST" }]);
  assert.match(conn.seen.find(sql => sql.includes("qsys2.job_info")), /JOB_USER_FILTER => 'DEVUSER'/);
  await assert.rejects(findJobs(conn, { userName: "*ALL" }), /Give a job name/);
  await assert.rejects(findJobs(conn, { userName: "A'B" }), /Invalid userName/);
  await assert.rejects(findJobs(conn, { state: "*BAD" }), /state must be/);
});

test("the call stack is newest first and marks the site's own code", async () => {
  const conn = fakeConn([["stack_info", [
    { THREAD_ID: 1, ORDINAL_POSITION: 3, ENTRY_TYPE: "ILE", PROGRAM_LIBRARY_NAME: "QSYS", PROGRAM_NAME: "QRNXIE", MODULE_NAME: "QRNXMSG", PROCEDURE_NAME: "InqMsg", STATEMENT_IDENTIFIERS: "0000000007" },
    { THREAD_ID: 1, ORDINAL_POSITION: 2, ENTRY_TYPE: "ILE", PROGRAM_LIBRARY_NAME: "DEVLIB", PROGRAM_NAME: "ORDPOST", MODULE_NAME: "ORDPOST", PROCEDURE_NAME: "CALCTOTAL", STATEMENT_IDENTIFIERS: "0000004200 0000004300" }
  ]]]);
  const all = await jobStack(conn, { jobName: "529971/DEVUSER/NIGHTLY" });
  assert.equal(all.entries[0].own, false);
  assert.deepEqual(all.entries[1], { position: 2, kind: "ILE", library: "DEVLIB", program: "ORDPOST", module: "ORDPOST", procedure: "CALCTOTAL", statement: "4200 4300", own: true });
  const own = await jobStack(conn, { jobName: "529971/DEVUSER/NIGHTLY", ownOnly: true });
  assert.deepEqual(own.entries.map(e => e.program), ["ORDPOST"]);
});

test("the new tools are listed as read-only", () => {
  const tools = getTools();
  for (const name of ["ibmi.jobs.find", "ibmi.jobs.log", "ibmi.jobs.diagnose", "ibmi.jobs.stack", "ibmi.joblog.parse", "ibmi.source.locateStatement"]) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, `${name} is listed`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} only reads`);
  }
});
