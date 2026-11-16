import test from "node:test";
import assert from "node:assert/strict";
// tools.js first: it loads the tool modules, of which jobWatch is one.
import { handleTool, isSubmitJob } from "../dist/mcp/tools.js";
import {
  assessStuckJob,
  buildSubmitCommand,
  clTextProblem,
  clTimedOut,
  connectionJobName,
  forgetOwnJobs,
  isOwnJob,
  mark,
  mayEndJobs,
  nextAction,
  parseSubmittedJob,
  pollDelayMs,
  rememberOwnJob,
  runTestJob,
  runningConnectionJob,
  runsProgram,
  sideChannel,
  stuckConnectionJob,
  stuckNote,
  submittedByThisCall,
  submittedJobs,
  testJobName,
  uniqueJobName,
  waitingJobs,
  waitingJobsNotice,
  waitingNote
} from "../dist/mcp/modules/jobWatch.js";
import { classifyHostOperation } from "../dist/mcp/hostApproval.js";

const JOB = "123456/DEV/TPROBE";
const OLDER = "111111/DEV/TPROBE";
const NOW_AT = "2026-11-16-10.00.00";
const NORMAL = { COMPLETION_STATUS: "NORMAL", JOB_END_REASON: "JOB ENDING IN NORMAL MANNER" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A fake connection. `states` is what the job looks like at each look, in order
 * (the last one repeats): { state, activeStatus, inquiry, queued, row }. Every
 * query is answered from the SQL it is given, so a query for another job, name
 * or user finds nothing.
 */
function fakeConn({
  states = [{ state: "OUTQ", row: NORMAL }],
  found = [JOB],
  existing = [],
  waiting = [],
  config = {},
  log = [],
  failLooks = 0,
  queuedAfterEnd,
  noServices = false
} = {}) {
  let look = -1;
  const current = () => states[Math.min(Math.max(look, 0), states.length - 1)];
  const conn = {
    sql: [],
    submitted: false,
    getConfig: () => config,
    async runSQL(sql) {
      conn.sql.push(sql);
      if (/NOW_AT/.test(sql)) return [{ CURRENT_USER_NAME: "DEV", NOW_AT }];
      if (/current user/i.test(sql)) return [{ CURRENT_USER_NAME: "DEV" }];
      if (/CURRENT_USER_LIST_FILTER/.test(sql)) return waiting;
      if (/active_job_info\(JOB_NAME_FILTER/i.test(sql)) return sql.includes(`JOB_NAME = '${JOB}'`) ? [{ JOB_STATUS: current().activeStatus || "RUN", AUTHORIZATION_NAME: "DEV" }] : [];
      if (/job_info\(/i.test(sql) && /JOB_NAME_SHORT/.test(sql)) {
        if (noServices) throw new Error("SQL0204 JOB_INFO in QSYS2 type *N not found.");
        // Only jobs of this user and name that entered the system at or after the mark.
        if (!sql.includes("JOB_USER_FILTER => 'DEV'") || !sql.includes("JOB_NAME_SHORT = 'TPROBE'") || !sql.includes(`timestamp('${NOW_AT}')`)) return [];
        return (conn.submitted ? found : existing).map(JOB_NAME => ({ JOB_NAME }));
      }
      if (/job_info\(/i.test(sql)) {
        if (failLooks > 0) {
          failLooks--;
          throw new Error("transport closed");
        }
        if (!sql.includes(`JOB_NAME = '${JOB}'`)) return [];
        look++;
        const s = current();
        if (s.state === "GONE") return [];
        return [{ JOB_NAME: JOB, JOB_STATUS: s.state, JOB_QUEUE_LIBRARY: "QGPL", JOB_QUEUE_NAME: "QBATCH", JOB_QUEUE_STATUS: "RELEASED", ...(s.row || {}) }];
      }
      if (/joblog_info/i.test(sql) && /'INQUIRY', 'SENDER'/.test(sql)) {
        const inquiry = current().inquiry;
        return inquiry ? [{ MESSAGE_ID: inquiry.id, MESSAGE_TEXT: inquiry.text, INQUIRIES: inquiry.count ?? 1 }] : [];
      }
      if (/joblog_info/i.test(sql)) return log;
      if (/message_queue_info/i.test(sql)) {
        const queued = current().state === "OUTQ" ? queuedAfterEnd : current().queued;
        return queued && sql.includes(`MESSAGE_QUEUE_NAME = '${queued.queue}'`) && sql.includes(`FROM_JOB = '${JOB}'`)
          ? [{ MESSAGE_ID: queued.id, MESSAGE_TEXT: queued.text, INQUIRIES: queued.count ?? 1 }]
          : [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
  return conn;
}

function deps(conn, { fail, mayEnd } = {}) {
  let now = 1_000_000;
  const d = {
    cl: [],
    mayEnd,
    lookBudgetMs: 200,
    now: () => now,
    sleep: async ms => { now += ms; },
    runCl: async command => {
      d.cl.push(command);
      if (fail && fail.re.test(command)) return { code: 1, stderr: fail.stderr };
      if (/^SBMJOB/.test(command) && conn) conn.submitted = true;
      return { code: 0 };
    }
  };
  return d;
}

const run = (conn, options = {}, d = deps(conn)) => runTestJob(conn, "dev", { command: "CALL PGM(DEV/TPROBE)", jobName: "TPROBE", ...options }, d).then(result => ({ result, d }));
const ended = d => d.cl.filter(c => /^ENDJOB /.test(c));

test.beforeEach(() => forgetOwnJobs());

// ---- text and names ----

test("the job an SBMJOB made is read from its completion message", () => {
  assert.equal(parseSubmittedJob("Job 123456/DEV/TPROBE submitted to job queue QBATCH in library QGPL."), JOB);
  assert.equal(parseSubmittedJob("job 000123/pgm#1/a.b submitted to job queue X in library Y."), "000123/PGM#1/A.B");
  assert.equal(parseSubmittedJob("Object TPROBE in DEV type *PGM created."), undefined);
  assert.equal(parseSubmittedJob(undefined), undefined);
});

test("a made-up job name is a valid IBM i name and differs from call to call", () => {
  for (const now of [0, 1, 1794800000000, Date.now()]) assert.match(testJobName(now), /^T[A-Z0-9]{7}$/);
  assert.notEqual(testJobName(1794800000000, 0.1), testJobName(1794800000000, 0.9));
});

test("CL text for the job must be one balanced command, not another submit", () => {
  assert.equal(clTextProblem("CALL PGM(DEV/TPROBE) PARM('a (b' 'it''s')"), undefined);
  assert.match(clTextProblem(""), /required/);
  assert.match(clTextProblem("CALL PGM(DEV/TPROBE"), /unmatched \(/);
  assert.match(clTextProblem("CALL PGM(DEV/TPROBE))"), /unmatched \)/);
  assert.match(clTextProblem("CALL PGM(DEV/TPROBE) PARM('a)"), /quote/);
  assert.match(clTextProblem("SBMJOB CMD(CALL PGM(DEV/TPROBE))"), /not an SBMJOB/);
  assert.match(clTextProblem("QSYS/SBMJOB CMD(DLYJOB 5)"), /not an SBMJOB/);
  assert.match(clTextProblem("CALL PGM(A)\nDLTLIB B"), /one line/);
});

test("a comment cannot be used to close CMD( early and add submit parameters", () => {
  // Without this, the job would be submitted under another user while a same-named job of this user was watched.
  const trick = "DLYJOB DLY(1) /* ' */) USER(PAYROLL) HOLD(*NO /* ' */";
  assert.match(clTextProblem(trick), /comment/);
  assert.throws(() => buildSubmitCommand({ command: trick, jobName: "NIGHTLY" }), /comment/);
  assert.match(clTextProblem("CALL PGM(A) /* note */"), /comment/);
});

test("a double quote cannot be used to hide a parenthesis either", () => {
  assert.match(clTextProblem('A "(" ) USER(QSECOFR) PRTTXT(")")'), /double quote/);
});

test("the job name is always unique, keeping the start the caller asked for", () => {
  assert.match(uniqueJobName("nightly", 0, 0.5), /^NIGHTL[A-Z0-9]{4}$/);
  assert.match(uniqueJobName("AB"), /^AB[A-Z0-9]{4}$/);
  assert.notEqual(uniqueJobName("NIGHTLY", 0, 0.1), uniqueJobName("NIGHTLY", 0, 0.9));
  assert.match(uniqueJobName(undefined), /^T[A-Z0-9]{7}$/);
  assert.throws(() => uniqueJobName("A) USER(X"), /Invalid jobName/);
});

test("the submit never waits for a person and names what was asked for", () => {
  const { jobName, command } = buildSubmitCommand({
    command: "CALL PGM(DEV/TPROBE)",
    jobName: "tprobe",
    jobQueue: "qgpl/qbatch",
    jobDescription: "*LIBL/DEVJOBD",
    libraryList: ["dev", "QGPL"],
    currentLibrary: "dev"
  });
  assert.equal(jobName, "TPROBE");
  assert.equal(command, "SBMJOB CMD(CALL PGM(DEV/TPROBE)) JOB(TPROBE) JOBD(*LIBL/DEVJOBD) JOBQ(QGPL/QBATCH) INLLIBL(DEV QGPL) CURLIB(DEV) INQMSGRPY(*DFT) LOG(4 00 *SECLVL)");
  assert.match(buildSubmitCommand({ command: "DLYJOB DLY(1)" }, 1794800000000).command, /^SBMJOB CMD\(DLYJOB DLY\(1\)\) JOB\(T[A-Z0-9]{7}\) INQMSGRPY\(\*DFT\) LOG\(4 00 \*SECLVL\)$/);
  assert.throws(() => buildSubmitCommand({ command: "DLYJOB DLY(1)", jobName: "TOO-LONG-NAME" }), /Invalid jobName/);
  assert.throws(() => buildSubmitCommand({ command: "DLYJOB DLY(1)", jobName: "A) USER(X" }), /Invalid jobName/);
  assert.throws(() => buildSubmitCommand({ command: "DLYJOB DLY(1)", libraryList: ["DEV)", "X"] }), /Invalid library/);
  assert.throws(() => buildSubmitCommand({ command: "DLYJOB DLY(1)", jobQueue: "A/B/C" }), /Invalid jobQueue/);
});

test("the watcher's next step follows what it sees", () => {
  const o = { timeoutMs: 10_000, onInquiry: "end", onTimeout: "end" };
  assert.equal(nextAction({ state: "OUTQ" }, 100, o), "done");
  assert.equal(nextAction({ state: "GONE" }, 100, o), "done");
  assert.equal(nextAction({ state: "JOBQ" }, 100, o), "wait");
  assert.equal(nextAction({ state: "ACTIVE", activeStatus: "RUN" }, 100, o), "wait");
  // MSGW alone is not a question: a program waiting for work on a message queue shows the same status.
  assert.equal(nextAction({ state: "ACTIVE", activeStatus: "MSGW" }, 100, o), "wait");
  assert.equal(nextAction({ state: "ACTIVE", activeStatus: "MSGW", inquiry: { id: "RNQ0202", text: "?", count: 1 } }, 100, o), "end-inquiry");
  // A question that was answered by itself (INQMSGRPY(*DFT)) still stops the job: it may be asking in a loop.
  assert.equal(nextAction({ state: "ACTIVE", activeStatus: "RUN", inquiry: { id: "ENC0001", text: "?", count: 40 } }, 100, o), "end-inquiry");
  assert.equal(nextAction({ state: "ACTIVE", inquiry: { id: "X", text: "?", count: 1 } }, 100, { ...o, onInquiry: "report" }), "report-inquiry");
  assert.equal(nextAction({ state: "ACTIVE", activeStatus: "RUN" }, 10_000, o), "end-timeout");
  assert.equal(nextAction({ state: "JOBQ" }, 10_001, { ...o, onTimeout: "report" }), "report-timeout");
  assert.equal(nextAction({ state: "OUTQ" }, 99_999, o), "done");
  assert.deepEqual([0, 4, 5, 14, 15, 99].map(pollDelayMs), [1000, 1000, 2000, 2000, 5000, 5000]);
});

test("commands that can leave a job waiting, timeouts and the policy's say on ending jobs are recognised", () => {
  assert.equal(runsProgram("CALL PGM(A/B)"), true);
  assert.equal(runsProgram(" qsys/sbmjob cmd(dlyjob 1)"), true);
  assert.equal(runsProgram("CALLPRC PRC(X)"), true);
  assert.equal(runsProgram("DLYJOB DLY(1)"), false);
  assert.equal(runsProgram("CRTBNDCL PGM(A/CALL)"), false);
  assert.equal(clTimedOut({ code: 1, stderr: "CL command timed out after 30000ms" }), true);
  assert.equal(clTimedOut({ code: 1, stderr: "CPF1338 Errors occurred on SBMJOB command." }), false);
  assert.equal(clTimedOut({ code: 0, stderr: "" }), false);
  assert.equal(clTimedOut(undefined), false);
  assert.equal(mayEndJobs(undefined), true);
  assert.equal(mayEndJobs({ profile: "guarded" }), true);
  assert.equal(mayEndJobs({ profile: "read-only" }), false);
  assert.equal(mayEndJobs({ profile: "guarded", denyCommands: ["ENDJOB"] }), false);
  assert.equal(isSubmitJob("SBMJOB CMD(CALL PGM(A/B))"), true);
  assert.equal(isSubmitJob("CALL PGM(A/SBMJOB)"), false);
});

// ---- the watched job ----

test("a job that ends normally is reported as completed and remembered as submitted here", async () => {
  const conn = fakeConn({ states: [{ state: "JOBQ" }, { state: "ACTIVE", activeStatus: "RUN" }, { state: "OUTQ", row: NORMAL }] });
  const { result, d } = await run(conn);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "completed");
  assert.match(result.note, /ended normally, and no question from it was found\. Its job log/);
  assert.equal(result.jobName, JOB);
  assert.equal(result.ended.byWatcher, false);
  assert.equal(result.ended.completionStatus, "NORMAL");
  assert.deepEqual(d.cl, ["SBMJOB CMD(CALL PGM(DEV/TPROBE)) JOB(TPROBE) INQMSGRPY(*DFT) LOG(4 00 *SECLVL)"]);
  assert.equal(isOwnJob("DEV", JOB), true);
});

test("a job that ends abnormally is a failure, not a completion", async () => {
  const { result } = await run(fakeConn({ states: [{ state: "OUTQ", row: { COMPLETION_STATUS: "ABNORMAL", JOB_END_REASON: "JOB ENDED DUE TO AN UNHANDLED ERROR" } }] }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
  assert.match(result.note, /abnormally \(JOB ENDED DUE TO AN UNHANDLED ERROR\)/);
});

test("a job the system no longer knows is reported as unknown, not as a failure", async () => {
  const { result } = await run(fakeConn({ states: [{ state: "ACTIVE" }, { state: "GONE" }] }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "unknown");
  assert.match(result.note, /how it ended is not known/);
});

test("a job that asks a question is ended at once, the end is checked, and nobody is asked to reply", async () => {
  const conn = fakeConn({
    states: [
      { state: "ACTIVE", activeStatus: "RUN" },
      { state: "ACTIVE", activeStatus: "RUN", inquiry: { id: "ENC0001", text: "Program TPROBE attempted decryption (C R)", count: 3 } },
      { state: "OUTQ", row: { COMPLETION_STATUS: "ABNORMAL", JOB_END_REASON: "JOB ENDING IMMEDIATELY" } }
    ],
    log: [{ MESSAGE_ID: "ENC0001", MESSAGE_TYPE: "SENDER", SEVERITY: 30, MESSAGE_TEXT: "Program TPROBE attempted decryption (C R)" }]
  });
  const { result, d } = await run(conn);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "ended-on-inquiry");
  assert.equal(result.inquiry.id, "ENC0001");
  assert.equal(result.inquiry.count, 3);
  assert.deepEqual(result.ended, { byWatcher: true, verified: true });
  assert.deepEqual(ended(d), [`ENDJOB JOB(${JOB}) OPTION(*IMMED)`]);
  assert.match(result.note, /was ended; nobody was asked to reply/);
  assert.equal(result.jobLog[0].id, "ENC0001");
  // Nothing that answers a message is ever run: only the submit and the end.
  assert.equal(d.cl.every(c => /^(SBMJOB|ENDJOB) /.test(c)), true);
  assert.equal(conn.sql.some(sql => /SNDRPY|SEND_MESSAGE|QMHSNDRM/i.test(sql)), false);
});

test("a job waiting on a message queue with no question found is not taken for one that asked", async () => {
  // RCVMSG WAIT on a queue shows MSGW too. It is ended by the time limit, and the result says what was seen.
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE", activeStatus: "MSGW" }] }), { timeoutSeconds: 10 });
  assert.equal(result.outcome, "ended-on-timeout");
  assert.equal(result.inquiry, undefined);
  assert.match(result.note, /waiting on a message queue, with no question from it found/);
  assert.equal(ended(d).length, 1);
});

test("a question on a message queue but not in the job log still ends the job", async () => {
  for (const queue of ["QSYSOPR", "DEV"]) {
    const conn = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "DLYW", queued: { queue, id: "CPA2401", text: "Continue? (C R)", count: 4 } }, { state: "OUTQ" }] });
    const { result, d } = await run(conn);
    assert.equal(result.outcome, "ended-on-inquiry", queue);
    assert.equal(result.inquiry.count, 4);
    assert.equal(ended(d).length, 1);
  }
});

test("a job that asked, was answered by default and finished between two looks is not reported as a clean run", async () => {
  const conn = fakeConn({ states: [{ state: "OUTQ", row: NORMAL }], queuedAfterEnd: { queue: "QSYSOPR", id: "CPA0701", text: "CPF0001 received by TPROBE (C D I R)" } });
  const { result, d } = await run(conn);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "completed-after-inquiry");
  assert.equal(result.inquiry.id, "CPA0701");
  assert.match(result.note, /asked a question .* that nobody answered: the system gave the default reply/);
  assert.equal(ended(d).length, 0);
});

test("a message queue that cannot be read does not stop the watch", async () => {
  const conn = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }, { state: "OUTQ", row: NORMAL }] });
  const inner = conn.runSQL;
  conn.runSQL = async sql => { if (/message_queue_info/i.test(sql)) throw new Error("SQL0551 Not authorized to object QSYSOPR"); return inner(sql); };
  const { result } = await run(conn);
  assert.equal(result.outcome, "completed");
  // The clean result says what it could not look at.
  assert.match(result.note, /operator's message queue could not be read, so a question that got a default reply would not have been seen/);
});

test("with onInquiry report the job is left and the person is told which one", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE", activeStatus: "MSGW", inquiry: { id: "RNQ0202", text: "The call ended in error (C G D F)." } }] }), { onInquiry: "report" });
  assert.equal(result.outcome, "waiting-on-inquiry");
  assert.equal(ended(d).length, 0);
  assert.match(result.note, /123456\/DEV\/TPROBE: tell the person now/);
});

test("a connection setting decides what happens when the call does not say, and the call wins", async () => {
  const asking = [{ state: "ACTIVE", inquiry: { id: "X0001", text: "?" } }, { state: "OUTQ" }];
  assert.equal((await run(fakeConn({ states: asking, config: { testJobOnInquiry: "report" } }))).result.outcome, "waiting-on-inquiry");
  assert.equal((await run(fakeConn({ states: asking, config: { testJobOnInquiry: "report" } }), { onInquiry: "end" })).result.outcome, "ended-on-inquiry");
});

test("when the policy does not let jobs be ended, the job is reported and never ended", async () => {
  const asking = fakeConn({ states: [{ state: "ACTIVE", inquiry: { id: "X0001", text: "?" } }] });
  const first = await run(asking, {}, deps(asking, { mayEnd: false }));
  assert.equal(first.result.outcome, "waiting-on-inquiry");
  assert.match(first.result.note, /policy does not let jobs be ended/);
  assert.equal(ended(first.d).length, 0);
  const slow = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }] });
  const second = await run(slow, { timeoutSeconds: 5 }, deps(slow, { mayEnd: false }));
  assert.equal(second.result.outcome, "still-running");
  assert.equal(ended(second.d).length, 0);
});

test("a job still running when its time is up is ended", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }] }), { timeoutSeconds: 10 });
  assert.equal(result.outcome, "ended-on-timeout");
  assert.ok(result.seconds >= 10 && result.seconds < 25, String(result.seconds));
  assert.equal(ended(d).length, 1);
  assert.match(result.note, /larger timeoutSeconds/);
  // The end was accepted but the job never showed as stopped: that is said, not assumed.
  assert.equal(result.ended.byWatcher, true);
  assert.equal(result.ended.verified, undefined);
});

test("the time limit comes from the connection when the call gives none, within bounds", async () => {
  const fromConfig = await run(fakeConn({ states: [{ state: "ACTIVE" }], config: { testJobTimeoutSeconds: 30 } }));
  assert.ok(fromConfig.result.seconds >= 30 && fromConfig.result.seconds < 45, String(fromConfig.result.seconds));
  const low = await run(fakeConn({ states: [{ state: "ACTIVE" }] }), { timeoutSeconds: 1 });
  assert.ok(low.result.seconds >= 5, "the limit is never under five seconds");
});

test("an end the system refuses at the time limit is said to have been tried, with its reason", async () => {
  const conn = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }] });
  const { result } = await run(conn, { timeoutSeconds: 5 }, deps(conn, { fail: { re: /^ENDJOB/, stderr: "CPF1344 Not authorized to control job." } }));
  assert.equal(result.outcome, "still-running");
  assert.match(result.note, /An end was tried and failed \(CPF1344/);
});

test("an end answered with 'already ending' or 'not found' is not reported as a failed end", async () => {
  for (const stderr of ["CPF1362 Job 123456/DEV/TPROBE has already ended or is ending.", "CPF1321 Job TPROBE user DEV job number 123456 not found."]) {
    const conn = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }] });
    const { result } = await run(conn, { timeoutSeconds: 5 }, deps(conn, { fail: { re: /^ENDJOB/, stderr } }));
    assert.equal(result.outcome, "ended-on-timeout", stderr);
    // Accepted, but the job was never seen to have left: that is said, not assumed.
    assert.equal(result.ended.verified, undefined);
  }
});

test("a job still shown as ending is not reported as stopped", async () => {
  const { result } = await run(fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }, { state: "ACTIVE", activeStatus: "RUN" }, { state: "ACTIVE", activeStatus: "RUN" }, { state: "ACTIVE", activeStatus: "RUN" }, { state: "ACTIVE", activeStatus: "RUN" }, { state: "ACTIVE", activeStatus: "END" }] }), { timeoutSeconds: 5 });
  assert.equal(result.outcome, "ended-on-timeout");
  assert.equal(result.ended.verified, undefined);
});

test("a look that is only slow does not get a healthy job ended before its time", async () => {
  const conn = fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }, { state: "OUTQ", row: NORMAL }] });
  const inner = conn.runSQL;
  let slowLooks = 4;
  conn.runSQL = sql => (/job_info\(/i.test(sql) && !/JOB_NAME_SHORT/.test(sql) && !/active_job_info/i.test(sql) && slowLooks-- > 0 ? new Promise(() => {}) : inner(sql));
  const { result, d } = await run(conn, { timeoutSeconds: 60 });
  assert.equal(result.outcome, "completed");
  assert.equal(ended(d).length, 0);
});

test("a job that never left the job queue is taken off it and the queue is named", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "JOBQ" }] }), { timeoutSeconds: 5 });
  assert.equal(result.outcome, "not-started");
  assert.equal(result.jobQueue, "QGPL/QBATCH");
  assert.match(result.note, /had not started/);
  assert.match(result.note, /taken off the queue/);
  assert.equal(ended(d).length, 1);
});

test("with onTimeout report a running job is left", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE", activeStatus: "RUN" }] }), { timeoutSeconds: 5, onTimeout: "report" });
  assert.equal(result.outcome, "still-running");
  assert.equal(ended(d).length, 0);
});

// ---- what may be adopted as "the job just submitted" ----

test("nothing is submitted when the system cannot be asked about jobs", async () => {
  const conn = fakeConn({ noServices: true });
  const { result, d } = await run(conn);
  assert.equal(result.outcome, "not-available");
  assert.match(result.note, /Nothing was submitted/);
  assert.deepEqual(d.cl, []);
});

test("nothing is submitted when a job of that name already entered the system just now", async () => {
  const { result, d } = await run(fakeConn({ existing: [OLDER] }));
  assert.equal(result.outcome, "not-started");
  assert.match(result.note, /nothing was submitted/);
  assert.deepEqual(d.cl, []);
  assert.equal(isOwnJob("dev", OLDER), false);
});

test("a submit that fails says why and watches nothing", async () => {
  const conn = fakeConn();
  const { result } = await run(conn, {}, deps(conn, { fail: { re: /^SBMJOB/, stderr: "CPF1338 Errors occurred on SBMJOB command." } }));
  assert.equal(result.outcome, "not-started");
  assert.match(result.note, /CPF1338/);
  assert.equal(isOwnJob("dev", JOB), false);
});

test("a submitted job that cannot be found is said so, and no job is adopted in its place", async () => {
  const { result, d } = await run(fakeConn({ found: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "not-found");
  assert.match(result.note, /could not be found/);
  assert.equal(ended(d).length, 0);
});

test("when two jobs fit, neither is taken for the new one and neither is ended", async () => {
  const { result, d } = await run(fakeConn({ found: [JOB, "123457/DEV/TPROBE"] }));
  assert.equal(result.outcome, "not-found");
  assert.match(result.note, /More than one job named TPROBE/);
  assert.equal(ended(d).length, 0);
  assert.equal(isOwnJob("dev", JOB), false);
});

test("only a job of this user and name that entered the system at or after the mark is found", async () => {
  const conn = fakeConn();
  conn.submitted = true;
  const since = await mark(conn);
  assert.deepEqual(since, { user: "DEV", at: NOW_AT });
  assert.deepEqual(await submittedJobs(conn, since, "TPROBE"), [JOB]);
  assert.deepEqual(await submittedJobs(conn, since, "NIGHTLY"), []);
  assert.deepEqual(await submittedJobs(conn, { user: "PAYROLL", at: NOW_AT }, "TPROBE"), []);
  assert.deepEqual(await submittedJobs(conn, { user: "DEV", at: "2026-11-16-09.00.00" }, "TPROBE"), []);
  await submittedJobs(conn, since, "TPROBE", "268115/QUSER/QZDASOINIT");
  assert.match(conn.sql.at(-1), /and SUBMITTER_JOB_NAME = '268115\/QUSER\/QZDASOINIT'/);
  await submittedJobs(conn, since, "TPROBE", "not a job') or ('1'='1");
  assert.equal(/SUBMITTER_JOB_NAME/.test(conn.sql.at(-1)), false);
  await submittedJobs(conn, { user: "DEV", at: "2026-11-16-09.00.00" }, "TPROBE");
  assert.match(conn.sql.at(-1), /JOB_ENTERED_SYSTEM_TIME >= timestamp\('2026-11-16-09\.00\.00'\)/);
});

// ---- the watch itself failing ----

test("a few failed looks are waited out", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE" }, { state: "OUTQ", row: NORMAL }], failLooks: 2 }));
  assert.equal(result.outcome, "completed");
  assert.equal(ended(d).length, 0);
});

test("a job that can no longer be watched is ended, not left running", async () => {
  const { result, d } = await run(fakeConn({ states: [{ state: "ACTIVE" }], failLooks: 99 }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "watch-lost");
  assert.equal(result.jobName, JOB);
  assert.deepEqual(ended(d), [`ENDJOB JOB(${JOB}) OPTION(*IMMED)`]);
  assert.match(result.note, /could no longer be watched \(transport closed\)/);
  assert.match(result.note, /It was ended so that it is not left running unwatched/);
});

test("a look that never answers counts as failed, and the job is ended", async () => {
  const conn = fakeConn({ states: [{ state: "ACTIVE" }] });
  const inner = conn.runSQL;
  conn.runSQL = sql => (/job_info\(/i.test(sql) && !/JOB_NAME_SHORT/.test(sql) && !/active_job_info/i.test(sql) ? new Promise(() => {}) : inner(sql));
  const { result, d } = await run(conn);
  assert.equal(result.outcome, "watch-lost");
  assert.equal(ended(d).length, 1);
});

test("a job that cannot be watched and cannot be ended is said to be possibly still running", async () => {
  const conn = fakeConn({ states: [{ state: "ACTIVE" }], failLooks: 99 });
  const { result } = await run(conn, {}, deps(conn, { fail: { re: /^ENDJOB/, stderr: "CPF1344 Not authorized to control job." } }));
  assert.equal(result.outcome, "watch-lost");
  assert.equal(result.ended, undefined);
  assert.match(result.note, /could not be ended \(CPF1344[^)]*\): it may still be running as 123456\/DEV\/TPROBE; tell the person now/);
});

test("a submit that does not answer: the job is looked for from a new job and ended if it was made", async () => {
  const conn = fakeConn({ states: [{ state: "OUTQ" }] });
  conn.sqlJob = { status: () => ({ jobName: "268115/QUSER/QZDASOINIT" }) };
  conn.runSqlQzdfmdb2 = async sql => { conn.submitted = true; return conn.runSQL(sql); };
  const d = deps(conn, { fail: { re: /^SBMJOB/, stderr: "CL command timed out after 30000ms" } });
  const { result } = await run(conn, {}, d);
  assert.equal(result.outcome, "submit-timed-out");
  assert.equal(result.jobName, JOB);
  assert.equal(result.ended.byWatcher, true);
  assert.match(result.note, /was submitted as 123456\/DEV\/TPROBE\. It was ended/);
  assert.equal(ended(d).length, 1);
  // Only a job this connection's job submitted is looked for.
  assert.match(conn.sql.find(sql => /JOB_NAME_SHORT/.test(sql) && /SUBMITTER_JOB_NAME/.test(sql)), /SUBMITTER_JOB_NAME = '268115\/QUSER\/QZDASOINIT'/);

  // Without knowing which job submitted it, a job found by name is named for the person and not ended.
  forgetOwnJobs();
  const unknown = fakeConn({ states: [{ state: "ACTIVE" }] });
  unknown.runSqlQzdfmdb2 = async sql => { unknown.submitted = true; return unknown.runSQL(sql); };
  const third = await run(unknown, {}, deps(unknown, { fail: { re: /^SBMJOB/, stderr: "CL command timed out after 30000ms" } }));
  assert.equal(third.result.outcome, "submit-timed-out");
  assert.match(third.result.note, /cannot be confirmed that it was submitted from here, so it was left alone/);
  assert.equal(ended(third.d).length, 0);
  assert.equal(isOwnJob("dev", JOB), false);

  const none = fakeConn({ found: [] });
  none.runSqlQzdfmdb2 = async sql => none.runSQL(sql);
  const second = await run(none, {}, deps(none, { fail: { re: /^SBMJOB/, stderr: "CL command timed out after 30000ms" } }));
  assert.equal(second.result.outcome, "submit-timed-out");
  assert.match(second.result.note, /Whether a job was submitted is not known/);
  assert.equal(ended(second.d).length, 0);
});

test("a submit whose answer was lost is not reported as 'not submitted'", async () => {
  // The connection dropped after the system ran the SBMJOB: only a CPF/CPD message from SBMJOB means nothing was submitted.
  const conn = fakeConn({ states: [{ state: "OUTQ" }] });
  conn.sqlJob = { status: () => ({ jobName: "268115/QUSER/QZDASOINIT" }) };
  conn.runSqlQzdfmdb2 = async sql => { conn.submitted = true; return conn.runSQL(sql); };
  const d = deps(conn, { fail: { re: /^SBMJOB/, stderr: "Connection failed with code 1006" } });
  const { result } = await run(conn, {}, d);
  assert.equal(result.outcome, "submit-timed-out");
  assert.match(result.note, /The submit did not come back \(Connection failed with code 1006\), but the job was submitted as 123456\/DEV\/TPROBE/);
  assert.equal(ended(d).length, 1);
});

// ---- jobs submitted here ----

test("only well-formed jobs are remembered, per connection, and a disconnect forgets them", () => {
  rememberOwnJob("Dev", JOB);
  rememberOwnJob("dev", "not a job");
  rememberOwnJob("dev", `${JOB}) OPTION(*IMMED`);
  assert.equal(isOwnJob("DEV", JOB.toLowerCase()), true);
  assert.equal(isOwnJob("other", JOB), false);
  assert.equal(isOwnJob("dev", "143272/QUSER/QZDASOINIT"), false);
  assert.equal(isOwnJob("dev", `${JOB}) OPTION(*IMMED`), false);
  forgetOwnJobs("dev");
  assert.equal(isOwnJob("dev", JOB), false);
});

test("a submit through the connection is believed only for a job of this user that just entered the system", async () => {
  const logRow = text => ({ MESSAGE_TEXT: text });
  const conn = (text, jobs) => ({
    sql: [],
    async runSQL(sql) {
      this.sql.push(sql);
      if (/joblog_info\('\*'\)/.test(sql)) return text ? [logRow(text)] : [];
      if (/JOB_NAME_SHORT/.test(sql)) return jobs.map(JOB_NAME => ({ JOB_NAME }));
      return [];
    }
  });
  const since = { user: "DEV", at: NOW_AT };
  const honest = conn("Job 123456/DEV/TPROBE submitted to job queue QBATCH in library QGPL.", [JOB]);
  assert.equal(await submittedByThisCall(honest, since), JOB);
  assert.match(honest.sql[0], /MESSAGE_ID = 'CPC1221' and MESSAGE_TYPE = 'COMPLETION' and MESSAGE_TIMESTAMP >= timestamp\('2026-11-16-10\.00\.00'\)/);
  // A message that names a job of another user (a pooled server job, say) is not believed, whoever sent it.
  assert.equal(await submittedByThisCall(conn("Job 143272/QUSER/QZDASOINIT submitted to job queue X in library Y.", ["143272/QUSER/QZDASOINIT"]), since), undefined);
  // A message that names a job of this user that did not just enter the system is not believed either.
  assert.equal(await submittedByThisCall(conn("Job 111111/DEV/NIGHTLY submitted to job queue X in library Y.", []), since), undefined);
  assert.equal(await submittedByThisCall(conn(undefined, []), since), undefined);
  assert.equal(await submittedByThisCall({ runSQL: async () => { throw new Error("SQL0204"); } }, since), undefined);
});

test("host mode: ending a job submitted here is routine, ending any other job asks", () => {
  const policy = { profile: "guarded", approvalMode: "host", trustedLibraries: ["DEV"] };
  const own = classifyHostOperation({ policy, operation: "jobs.endOwn", toolName: "ibmi.jobs.end", args: { jobName: JOB }, shell: false });
  assert.equal(own.critical, false);
  const other = classifyHostOperation({ policy, operation: "jobs.end", toolName: "ibmi.jobs.end", args: { jobName: "143272/QUSER/QZDASOINIT" }, shell: false });
  assert.equal(other.critical, true);
  const strict = classifyHostOperation({ policy: { ...policy, alwaysConfirm: ["jobs.endOwn"] }, operation: "jobs.endOwn", toolName: "ibmi.jobs.end", args: { jobName: JOB }, shell: false });
  assert.equal(strict.critical, true);
});

// ---- waiting jobs ----

test("jobs of the user that wait on a message are listed, with whose they are, without interactive sessions", async () => {
  rememberOwnJob("dev", JOB);
  const conn = fakeConn({
    waiting: [
      { JOB_NAME: JOB, JOB_TYPE: "BCH", SUBSYSTEM: "QBATCH", FUNCTION: "TPROBE" },
      { JOB_NAME: "143272/QUSER/QZDASOINIT", JOB_TYPE: "PJ", SUBSYSTEM: "QUSRWRK", FUNCTION: "QZDASOINIT" }
    ],
    states: [{ state: "ACTIVE", inquiry: { id: "ENC0001", text: "decryption (C R)" } }]
  });
  const jobs = await waitingJobs(conn, "DEV", "dev");
  assert.deepEqual(jobs.map(j => [j.jobName, j.submittedHere]), [[JOB, true], ["143272/QUSER/QZDASOINIT", false]]);
  assert.equal(jobs[0].message.id, "ENC0001");
  const sql = conn.sql.find(text => /CURRENT_USER_LIST_FILTER/.test(text));
  assert.match(sql, /CURRENT_USER_LIST_FILTER => 'DEV'/);
  assert.match(sql, /JOB_STATUS = 'MSGW' and JOB_TYPE <> 'INT'/);
  const note = waitingNote(jobs);
  assert.match(note, /2 jobs working for this user are waiting on a message/);
  assert.match(note, /Do not reply to the message/);
});

test("the notice after a program step is empty when nothing waits, and never throws", async () => {
  assert.deepEqual(await waitingJobsNotice(fakeConn(), "dev"), {});
  const asking = fakeConn({ waiting: [{ JOB_NAME: "143272/QUSER/QZDASOINIT" }], states: [{ state: "ACTIVE", inquiry: { id: "RNQ0211", text: "(C G D F)" } }] });
  const found = await waitingJobsNotice(asking, "dev");
  assert.equal(found.waitingJobs.length, 1);
  assert.match(found.waitingJobsNote, /A job working for this user is waiting on a message: 143272\/QUSER\/QZDASOINIT/);
  assert.match(asking.sql.find(sql => /joblog_info/i.test(sql)), /MESSAGE_TIMESTAMP >= current timestamp - 600 seconds/);
  // A job that has been waiting without a recent question (a monitor on a message queue, another session's job) is not this call's news.
  assert.deepEqual(await waitingJobsNotice(fakeConn({ waiting: [{ JOB_NAME: "143272/QUSER/QZDASOINIT" }] }), "dev"), {});
  // One submitted here is always listed.
  rememberOwnJob("dev", JOB);
  assert.equal((await waitingJobsNotice(fakeConn({ waiting: [{ JOB_NAME: JOB }] }), "dev")).waitingJobs.length, 1);
  assert.deepEqual(await waitingJobsNotice({ runSQL: async () => { throw new Error("SQL0204 ACTIVE_JOB_INFO not found"); } }, "dev"), {});
  const off = fakeConn({ waiting: [{ JOB_NAME: JOB }], config: { watchWaitingJobs: false } });
  assert.deepEqual(await waitingJobsNotice(off, "dev"), {});
  assert.equal(off.sql.length, 0);
});

// ---- the connection's own job is the one that is stuck ----

const SERVER_JOB = "268115/QUSER/QZDASOINIT";
const RNQ = { MESSAGE_ID: "RNQ0211", MESSAGE_TEXT: "Error occurred while calling program or procedure *LIBL/RTVVRMP (C G D F).", INQUIRIES: 1 };

/**
 * A connection whose long-lived job is stuck: anything sent to it never comes
 * back, so everything must go through the new-job channel.
 */
function stuckConn({ status = "MSGW", workingFor = "DEV", config = { stuckConnectionJob: "end" }, endFails = false, others = [], asked = true, answered = false, slow = {}, statusAfter } = {}) {
  let looks = 0;
  const conn = {
    side: [],
    main: 0,
    ended: false,
    getConfig: () => config,
    sqlJob: { status: () => ({ jobName: SERVER_JOB, running: { jobName: SERVER_JOB, since: 5000 } }) },
    runSQL: async () => { conn.main++; return new Promise(() => {}); },
    async runSqlQzdfmdb2(sql) {
      conn.side.push(sql);
      for (const [pattern, ms] of Object.entries(slow)) if (new RegExp(pattern, "i").test(sql)) await pause(ms);
      if (/current user/i.test(sql)) return [{ CURRENT_USER_NAME: "DEV" }];
      if (/CURRENT_USER_LIST_FILTER/.test(sql)) return [...(status === "MSGW" && workingFor === "DEV" && !conn.ended ? [{ JOB_NAME: SERVER_JOB, JOB_TYPE: "PJ" }] : []), ...others];
      if (/JOB_NAME_FILTER/.test(sql)) {
        looks++;
        return [{ JOB_STATUS: statusAfter && looks > 1 ? statusAfter.status : status, AUTHORIZATION_NAME: statusAfter && looks > 1 ? statusAfter.workingFor : workingFor }];
      }
      // An answered question has a reply after it: a query that asks for unanswered ones does not find it.
      if (/joblog_info/i.test(sql)) return asked && !(answered && /not exists/.test(sql)) ? [RNQ] : [];
      if (/message_queue_info/i.test(sql)) return [];
      if (/ENDJOB/.test(sql)) {
        if (endFails) throw new Error("CPF1343 Job not valid job type for function.");
        conn.ended = true;
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
  return conn;
}
const endsSent = conn => conn.side.filter(sql => /ENDJOB/.test(sql));

test("the connection's job name and a new-job channel are read from the client", () => {
  const conn = stuckConn();
  assert.equal(connectionJobName(conn), SERVER_JOB);
  assert.equal(connectionJobName({ runSQL: async () => [] }), undefined);
  assert.equal(connectionJobName({ runSQL: async () => [], sqlJob: { status: () => ({ jobName: "not-a-job" }) } }), undefined);
  assert.equal(connectionJobName({ runSQL: async () => [], sqlJob: { status: () => ({ jobName: `${SERVER_JOB}) OPTION(*IMMED` }) } }), undefined);
  assert.notEqual(sideChannel(conn), conn);
  const plain = { runSQL: async () => [] };
  assert.equal(sideChannel(plain), plain);
});

test("a connection job stuck on a question is ended from a new job, without a reply", async () => {
  const conn = stuckConn();
  const stuck = await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true });
  assert.equal(stuck.ended, true);
  assert.equal(stuck.jobName, SERVER_JOB);
  assert.equal(stuck.message.id, "RNQ0211");
  assert.equal(conn.main, 0, "the stuck job itself is never asked");
  assert.deepEqual(endsSent(conn), ["CALL QSYS2.QCMDEXC('ENDJOB JOB(268115/QUSER/QZDASOINIT) OPTION(*IMMED)')"]);
  assert.equal(conn.side.some(sql => /SNDRPY|SEND_MESSAGE/i.test(sql)), false);
  assert.match(stuckNote(stuck), /was ended and nobody was asked to reply/);
  assert.match(stuckNote(stuck), /ibmi\.jobs\.runTest/);
});

test("a connection job that waits on a message queue but asked nothing is left alone", async () => {
  // A program waiting for work on a message queue looks the same: ending it would kill a healthy call.
  const conn = stuckConn({ asked: false });
  const stuck = await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true });
  assert.equal(stuck.ended, false);
  assert.match(stuck.reason, /no unanswered question it asked during this call was found/);
  assert.equal(endsSent(conn).length, 0);
  assert.match(stuckNote(stuck), /no unanswered question it asked during this call was found, so it was left alone/);
});

test("an old question that was already answered does not get a waiting connection job ended", async () => {
  // Earlier in the session the job asked something that was answered; now a program legitimately waits on a message queue.
  const conn = stuckConn({ answered: true });
  const stuck = await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true, withinSeconds: 55 });
  assert.equal(stuck.ended, false);
  assert.equal(endsSent(conn).length, 0);
  const asked = conn.side.find(sql => /joblog_info/i.test(sql));
  assert.match(asked, /MESSAGE_TIMESTAMP >= current timestamp - 55 seconds/);
  assert.match(asked, /not exists \(select 1 from table\(qsys2\.joblog_info\('268115\/QUSER\/QZDASOINIT'\)\) r where r\.MESSAGE_TYPE = 'REPLY'/);
});

test("by default a stuck connection job is reported, not ended", async () => {
  const conn = stuckConn({ config: {} });
  const found = await assessStuckJob(conn, SERVER_JOB, { mayEnd: true });
  assert.equal(found.end, false);
  assert.equal(found.stuck.message.id, "RNQ0211");
  const stuck = await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true });
  assert.equal(stuck.ended, false);
  assert.equal(endsSent(conn).length, 0);
});

test("the connection's job is looked at only when the statement running in it is the caller's own", () => {
  const conn = stuckConn();
  // The statement there started at 5000. A call that began at 4000 owns it; one that began at 9000 was still queued behind it.
  assert.equal(runningConnectionJob(conn, 4000), SERVER_JOB);
  assert.equal(runningConnectionJob(conn, 9000), undefined);
  assert.equal(runningConnectionJob({ runSQL: async () => [], sqlJob: { status: () => ({ jobName: SERVER_JOB }) } }, 0), undefined);
  assert.equal(runningConnectionJob({ runSQL: async () => [] }, 0), undefined);
});

test("a pooled server job that now works for someone else is left alone", async () => {
  const conn = stuckConn({ workingFor: "PAYROLL" });
  assert.equal(await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true }), undefined);
  assert.equal(endsSent(conn).length, 0);
});

test("a job handed to someone else between the first look and the end is not ended", async () => {
  const conn = stuckConn({ statusAfter: { status: "MSGW", workingFor: "PAYROLL" } });
  assert.equal(await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true }), undefined);
  assert.equal(endsSent(conn).length, 0);
  const moved = stuckConn({ statusAfter: { status: "RUN", workingFor: "DEV" } });
  assert.equal(await stuckConnectionJob(moved, SERVER_JOB, { mayEnd: true }), undefined);
  assert.equal(endsSent(moved).length, 0);
});

test("a connection job that is only slow is not ended", async () => {
  const conn = stuckConn({ status: "RUN" });
  assert.equal(await stuckConnectionJob(conn, SERVER_JOB, { mayEnd: true }), undefined);
  assert.equal(endsSent(conn).length, 0);
});

test("with stuckConnectionJob report, or a policy that forbids it, the job is reported and not ended", async () => {
  const reported = stuckConn({ config: { stuckConnectionJob: "report" } });
  const first = await stuckConnectionJob(reported, SERVER_JOB, { mayEnd: true });
  assert.equal(first.ended, false);
  assert.match(first.reason, /not "end"/);
  assert.match(stuckNote(first), /was not ended \(stuckConnectionJob is not "end"\)/);
  assert.match(stuckNote(first), /ENDJOB JOB\(268115\/QUSER\/QZDASOINIT\) OPTION\(\*IMMED\)/);
  assert.equal(endsSent(reported).length, 0);
  const forbidden = stuckConn();
  const second = await stuckConnectionJob(forbidden, SERVER_JOB, { mayEnd: false });
  assert.equal(second.ended, false);
  assert.match(second.reason, /policy/);
  assert.equal(endsSent(forbidden).length, 0);
});

test("an end the system refuses is reported with its reason", async () => {
  const stuck = await stuckConnectionJob(stuckConn({ endFails: true }), SERVER_JOB, { mayEnd: true });
  assert.equal(stuck.ended, false);
  assert.match(stuck.reason, /CPF1343/);
  assert.match(stuckNote(stuck), /was not ended \(CPF1343/);
});

test("without a well-formed job name or a new-job channel nothing is looked at", async () => {
  assert.equal(await stuckConnectionJob(stuckConn(), undefined, { mayEnd: true }), undefined);
  assert.equal(await stuckConnectionJob(stuckConn(), `${SERVER_JOB}) OPTION(*IMMED`, { mayEnd: true }), undefined);
  assert.equal(await stuckConnectionJob({ runSQL: async () => [] }, SERVER_JOB, { mayEnd: true }), undefined);
});

test("after a timeout the notice comes from a new job and carries the stuck job", async () => {
  const conn = stuckConn({ others: [{ JOB_NAME: JOB, JOB_TYPE: "BCH" }] });
  const notice = await waitingJobsNotice(conn, "dev", { connectionJob: SERVER_JOB, mayEnd: true });
  assert.equal(conn.main, 0);
  assert.equal(notice.stuckJob.ended, true);
  assert.match(notice.stuckJobNote, /268115\/QUSER\/QZDASOINIT was waiting on a question it asked \(RNQ0211/);
  assert.deepEqual(notice.waitingJobs.map(j => j.jobName), [JOB]);
});

test("after a timeout with nothing stuck the notice is empty", async () => {
  assert.deepEqual(await waitingJobsNotice(stuckConn({ status: "RUN" }), "dev", { connectionJob: SERVER_JOB, mayEnd: true }), {});
});

test("a job that was ended is reported even when the rest of the look runs out of time", async () => {
  const conn = stuckConn({ slow: { CURRENT_USER_LIST_FILTER: 400 } });
  const notice = await waitingJobsNotice(conn, "dev", { connectionJob: SERVER_JOB, mayEnd: true }, 150);
  assert.equal(notice.stuckJob.ended, true, "the end that happened is not lost");
  assert.equal(notice.waitingJobs, undefined);
});

test("an end that takes longer than the look's limit is still waited for and reported", async () => {
  const conn = stuckConn({ slow: { ENDJOB: 300 } });
  const notice = await waitingJobsNotice(conn, "dev", { connectionJob: SERVER_JOB, mayEnd: true }, 150);
  assert.equal(notice.stuckJob.ended, true, "the tool call does not answer before the end it issued");
  assert.equal(conn.ended, true);
});

test("a look that runs out of time does not end the job afterwards", async () => {
  const conn = stuckConn({ slow: { joblog_info: 300 } });
  const notice = await waitingJobsNotice(conn, "dev", { connectionJob: SERVER_JOB, mayEnd: true }, 100);
  assert.deepEqual(notice, {});
  await pause(500);
  assert.equal(endsSent(conn).length, 0, "no ENDJOB after the tool call has already answered");
});

// ---- through the tool handlers ----

function toolConn(config = {}) {
  const calls = { sql: [] };
  const conn = {
    currentConnectionName: "DEV",
    getConfig: () => ({ readOnlyMode: false, currentLibrary: "DEVLIB", ...config }),
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/.test(String(name).toUpperCase()),
    async runSQL(sql) {
      calls.sql.push(sql);
      return [];
    }
  };
  return { conn, calls };
}
const ctxFor = (conn, policy) => ({ store: {}, activeName: "DEV", sessionApprovals: new Set(), ensureActive: async () => conn, getPolicy: () => policy });

test("the test tool holds the job's command to the policy as if it were run directly", async () => {
  const { conn, calls } = toolConn();
  const policy = { profile: "power-user", denyCommands: ["CALL"] };
  await assert.rejects(handleTool(ctxFor(conn, policy), "ibmi.cl.run", { command: "CALL PGM(DEV/X)" }), /Blocked by policy/);
  await assert.rejects(handleTool(ctxFor(conn, policy), "ibmi.jobs.runTest", { command: "CALL PGM(DEV/X)" }), /Blocked by policy/);
  assert.equal(calls.sql.some(sql => /SBMJOB/.test(sql)), false);
});

test("the test tool is refused on a read-only connection and for a comment in the command", async () => {
  const readOnly = toolConn({ readOnlyMode: true });
  await assert.rejects(handleTool(ctxFor(readOnly.conn, { profile: "power-user" }), "ibmi.jobs.runTest", { command: "DLYJOB DLY(1)" }), /read-only/i);
  assert.equal(readOnly.calls.sql.some(sql => /SBMJOB/.test(sql)), false);
  const { conn, calls } = toolConn();
  await assert.rejects(handleTool(ctxFor(conn, { profile: "power-user" }), "ibmi.jobs.runTest", { command: "DLYJOB DLY(1) /* ' */) USER(PAYROLL) HOLD(*NO /* ' */" }), /comment/);
  assert.equal(calls.sql.some(sql => /SBMJOB/.test(sql)), false);
});

test("an ordinary command through ibmi.cl.run costs no extra queries; a program call is followed by the look", async () => {
  const plain = toolConn();
  await handleTool(ctxFor(plain.conn, { profile: "power-user" }), "ibmi.cl.run", { command: "DLYJOB DLY(0)" });
  assert.equal(plain.calls.sql.length, 1);
  const call = toolConn();
  await handleTool(ctxFor(call.conn, { profile: "power-user" }), "ibmi.cl.run", { command: "CALL PGM(DEVLIB/X)" });
  assert.equal(call.calls.sql.filter(sql => /QCMDEXC/.test(sql)).length, 1);
  assert.equal(call.calls.sql.some(sql => /current user/i.test(sql)), true);
});
