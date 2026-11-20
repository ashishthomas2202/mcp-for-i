# Finding out why a program failed, and debugging

This is the plan for the job log and debugging work, what is built, and what comes next. Keep it current as the work moves.

## The idea

A developer with a failed job wants three things in order: what failed, where in whose code, and then, if reading is not enough, to stop the program there and look. The first two need no debugger and are built. The third goes through the IBM i Debug Service and is planned below.

Everything is a tool first, so any agent can use it. The person gets a page on their own computer (`ibmi.workbench.open`) that shows what the tools return. A host application that has its own interface calls the same tools and draws the result itself.

## Built (read-only)

| Tool | What it answers |
|---|---|
| `ibmi.jobs.find` | Which jobs are there, in any state, and how did each end |
| `ibmi.jobs.log` | What does the job log say, live or already printed |
| `ibmi.jobs.diagnose` | Why did it fail: the message, what led to it, the program, the source line |
| `ibmi.jobs.stack` | Where is a job now |
| `ibmi.joblog.parse` | The same for job log text that was saved or pasted |
| `ibmi.source.locateStatement` | From a statement number to a source line, and how sure that is |
| `ibmi.debug.ready` | Can this system be debugged from this computer, and what is in the way |
| `ibmi.workbench.open` | The page for the person |

Layout of the code:

- `src/ibmi/jobLog.ts`: the message shape, the diagnosis and the printed-log parser. No system access; fully unit tested.
- `src/mcp/modules/jobs.ts`: the tools, and the functions the page uses.
- `src/mcp/modules/debug.ts`: the readiness check.
- `src/mcp/modules/workbench.ts`, `workbenchPage.ts`: the local server and the page. The page can call only the tools in `PAGE_TOOLS`.

## Next: debug sessions

The IBM i Debug Service speaks the Debug Adapter Protocol (DAP) over TLS on the debug port (8005). A session lives in this server, so the agent and the person share one session the way they share one 5250 screen.

### Step 1: protocol trial (before anything else is built)

One short script, on a development system, against one small program compiled with `DBGVIEW(*SOURCE)`: connect, `initialize`, `launch`, set one breakpoint, read the stack and variables at the stop, step, end. With tracing on.

It has to answer:

1. The exact form of the `launch` request the service accepts (the arguments IBM publishes for `launch.json`: host, user, password, library, program, the `SBMJOB` command; and how the password is encoded).
2. How the service names a source in `setBreakpoints` and in a stack frame (member, stream file, `*SOURCE` or `*LIST` view), so breakpoints set on a member land in the right place.
3. What the service does when the client goes away with the job stopped.

It submits one batch job, so it runs only with the person's go-ahead, on a system and a program they name. If the trial fails, the plan below changes.

### Step 2: tools

| Tool | Notes |
|---|---|
| `ibmi.debug.start` | Launch a program as a batch job under debug: the call command, library list, breakpoints. Returns a session id and the first stop. |
| `ibmi.debug.attach` | Attach to a job by name, first of all the job of the shared 5250 session. Depends on the trial showing that attach works. |
| `ibmi.debug.breakpoints` | Set or clear line breakpoints in a member. |
| `ibmi.debug.continue`, `.step` | Run on; step over, into, out. Each returns the next stop (or how the job ended) so an agent needs one call per step. |
| `ibmi.debug.stack`, `.variables`, `.evaluate` | Read the state at a stop. |
| `ibmi.debug.setVariable` | Changes the running program: asks the person. |
| `ibmi.debug.runUntil` | Continue until an expression holds or a message is logged (the service has no conditional breakpoints; this server does the checking at each stop). |
| `ibmi.debug.end` | End the session and the job it started. |
| `ibmi.debug.sessions` | What is open. |

Rules that hold from the first version:

- A job the session started is ended with the session, and a session whose client is gone is ended after a short wait. A job is never left stopped at a breakpoint.
- The debug job is submitted with `INQMSGRPY(*DFT)` and watched, as test jobs are.
- "Update production files" is off unless the person switches it on for that session.
- The password is read from the credential store for the session and never returned or logged; DAP tracing is refused unless the password is masked.
- Starting a session is a guarded operation (it runs a program); reading state is not.

### Step 3: the person's view

The workbench page gains a Debug view next to Jobs: the source with the stopped line, breakpoints in the margin, Continue / Step / Stop, Variables, Watch, Call stack and the job's log, fed by a live stream from this server (as the live 5250 view is). The person and the agent act on the same session; when the person acts, the agent reads the state again before it carries on.

A host application draws the same from the tools and the stream in its own editor.

### Step 4: service entry points

Stopping in a job somebody else starts (a web request, another user's session). This needs the second connection of the Debug Service (port 8008), whose messages IBM does not document. Not started until steps 1 to 3 work and it is still wanted.

## Known limits

- The printed-log parser reads English job logs.
- A statement number maps to a source line only when the module was compiled with `OPTION(*SRCSTMT)` (or is CL). Otherwise the tool says so rather than guess.
- The diagnosis follows fixed rules (last escape, or the question answered with a cancel; the run of serious messages before it). It names what it found and leaves the judgement to the reader.
- `ibmi.debug.ready` does not check authority to `STRDBG` or to the program.

## Protocol trial, 2026-11-20 (IBM i 7.5, Debug Service 3.0.0)

What was learned by talking to the service directly on port 8005:

- It speaks standard DAP with `Content-Length` framing over TLS, with no adapter in between. `initialize` is answered at once. The service says it supports conditional breakpoints, hit counts, function breakpoints, set variable, set expression, modules, restart and terminate.
- Its certificate can be one issued by a public authority (it was, on the system tried). Trusting only the file in the service's certs directory then fails, because that file is the leaf and not its issuer. Trust has to be: the computer's own roots, or that exact certificate.
- `launch` and `attach` take the arguments IBM publishes for `launch.json`, plus `sessionId` (the service refuses a request without it: `EQARD1013E`). The password is accepted base64-encoded; the sign-on succeeded and counted no invalid attempt.
- `initialized` arrives right after the request, and `configurationDone` is answered.
- **Not solved:** neither `launch` (batch) nor `attach` (to a job held on a job queue) was ever answered, within 90 seconds. The service's log shows it got as far as "Debugging batch program ..." and "Attaching to job ...", the same lines it writes for working sessions from the VS Code extension. No job was submitted and no debug engine job (`QB5PHSRV`) was started for the user. Something the IBM client sends, or does on its second connection (port 8008), is missing from these requests.
- Nothing was left behind: no job, no change to the system except the small trial program and its source member.

To get past this, one of:

1. A trace of one working session from the VS Code extension (Code for IBM i's debug tracing setting writes the DAP messages to its output), run by a developer against the same program. This shows the exact requests without reading IBM's code.
2. Reading the extension's adapter to see what it sends. IBM's licence for the extension forbids reverse engineering, so this is the owner's decision.
3. Asking IBM for the client contract of the Debug Service.
