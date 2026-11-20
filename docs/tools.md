# Tools

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so MCP clients can auto-approve read-only tools and ask before destructive ones. Only the IBM Docs tools reach the internet (`openWorldHint: true`).

## Connection
- `ibmi.connect`
- `ibmi.disconnect`
- `ibmi.session.list`
- `ibmi.session.status`
- `ibmi.session.keepalive`
- `ibmi.session.terminate`
- `ibmi.session.bootstrap`
- `ibmi.connections.list`
- `ibmi.connections.add`
- `ibmi.connections.update`
- `ibmi.connections.delete`

## QSYS / Members
- `ibmi.qsys.libraries.list`
- `ibmi.qsys.objects.list`
- `ibmi.qsys.sourcefiles.list`
- `ibmi.qsys.members.list`
- `ibmi.qsys.members.read`
- `ibmi.qsys.members.write`
- `ibmi.qsys.members.create`
- `ibmi.qsys.members.rename`
- `ibmi.qsys.members.delete`
- `ibmi.qsys.sourcefiles.create`
- `ibmi.qsys.libraries.create`

### Source performance and compatibility notes

- Existing `members.list` calls keep the legacy array response. Set `responseFormat: "page"`, provide a filter, or provide paging arguments to receive a bounded structured page.
- Existing `members.read` calls keep the legacy text response. Set `responseFormat: "structured"` or request ranges, context, metadata, or a version check to receive the structured snapshot envelope.
- `members.write` supports optional optimistic-concurrency checks through `expectedVersion` and `expectedSha256`.
- `members.read` uses a job-local alias for source-date reads and a complete `CPYTOSTMF` fallback if the SQL path is unavailable.
- Both read paths normalize content the same way before hashing (LF line endings, trailing blanks trimmed from every line), so `sha256` and `version` do not change when a read falls back from SQL to `CPYTOSTMF`.
- Cached snapshots are only served after a cheap re-check of the member's `LAST_SOURCE_UPDATE_TIMESTAMP` and row count, so edits made outside this server are seen immediately. Cache hits report `cacheStatus: "hit"` and `validatedAt`.
- Full reads are capped by the `sourceReadMaxBytes` / `sourceReadMaxLines` settings (defaults 2,000,000 bytes and 50,000 lines). Larger members return a `SOURCE_TOO_LARGE` error with the size and version; read them with `startLine`/`endLine` or `ranges`, or locate code with `ibmi.search.members` / `ibmi.source.inspect`.
- `startLine` without `endLine` reads to the end of the member. Ranges past the end return no lines and a warning. Range responses are limited to 2,000 lines; when cut, the response has `truncated: true` and `nextLine`.
- `metadataOnly: true` does not download content. It returns `changeMarker` and catalog metadata, plus `sha256`/`version` only when a validated cached snapshot exists.
- A version mismatch (`expectedVersion` / `expectedSha256`) on read, inspect or write is a tool error with `code: "VERSION_CONFLICT"`, `currentVersion` and `currentSha256`; nothing is modified.
- A successful `members.write` reads the member back and returns `version`, `sha256`, `lineCount` and `previousVersion` (as JSON when a version check or `responseFormat: "structured"` is used; otherwise the text stays `OK` and the details are in `structuredContent`). The version check and the write are separate host operations, so a change made in the instant between them is not detected.

## IFS
- `ibmi.ifs.list`
- `ibmi.ifs.read`
- `ibmi.ifs.write`
- `ibmi.ifs.mkdir`
- `ibmi.ifs.delete`
- `ibmi.ifs.upload`
- `ibmi.ifs.download`

## Search
- `ibmi.search.members`
- `ibmi.search.ifs`
- `ibmi.find.ifs`

`ibmi.search.members` accepts either `term` or up to 20 `terms` in one remote request.

- Terms are matched literally (`-F`) and sent over stdin (`-f -`), never through the shell.
- `maxMatches` defaults to 100 (maximum 1,000). The limit is applied on the host while the grep runs (`-m` per member plus a bounded output pipe), not after downloading everything.
- The response includes `matchCount`, `maxMatches`, `truncated` and, when truncated, `truncatedReason` (`max-matches` or `output-limit`). When `truncated` is true, narrow the search (members filter, more specific terms) rather than raising the limit.
- With `before`/`after` (0 to 50), each returned line has `kind: "match"` or `kind: "context"`.
- `pfgrep` is used when installed at `/QOpenSys/pkgs/bin/pfgrep`; otherwise grep is used.

## Composite Source Inspection

- `ibmi.source.resolve`
- `ibmi.source.inspect`

`ibmi.source.inspect` batches metadata, outline, search, range-read, and dependency extraction over one versioned source snapshot.

Outline and dependency extraction follow the member source type: RPG (fully free, fixed and mixed: procedures, subroutines, prototypes, data structures, `dcl-f`/F-spec files, `EXTPGM`/`EXTPROC`, `CALL`/`CALLB`/`CALLP`, `/COPY`/`/INCLUDE` and embedded SQL tables), CL (`CALL`, `CALLPRC`, `DCLF`, `OVRDBF TOFILE`, `INCLUDE`, `RUNSQL`, `SBMJOB CMD(CALL ...)`, labels, subroutines), SQL (created objects; tables from `FROM`, `JOIN`, `INSERT`/`MERGE INTO`, `UPDATE`, `DELETE FROM`, `REFERENCES`; `CALL`), and DDS PF/LF/DSPF/PRTF (record formats, keys, fields; `REF`, `REFFLD`, `PFILE`, `JFILE`). Results include the detected `language`.

## Official IBM i Documentation

- `ibmi.docs.search`
- `ibmi.docs.open`

The documentation catalog is also exposed through MCP resources: `ibmi-docs://catalog` and `ibmi-docs://topic/{ref}`.

- `ibmi.docs.open` accepts a `ref` from search or any `https://www.ibm.com/docs/...` URL (for example a single CL command or API page). The URL must be https, host exactly `www.ibm.com`, path under `/docs/`, with no user information or port. Redirects are followed only within `www.ibm.com/docs/`, at most 3.
- Pages are capped at 12 MiB while downloading, HTML tables become Markdown tables, and pages that were opened become searchable.
- Cached pages expire after 7 days (`MCP_FOR_I_IBM_DOCS_CACHE_TTL_DAYS`). `cacheStatus` is `hit`, `miss`, `refreshed` or `stale` (expired copy served because the refresh failed).
- The search catalog covers IBM i 7.2 to 7.6. Asking for an older release returns a warning saying IBM Docs has no collection for it.

## Actions
- `ibmi.actions.list`
- `ibmi.actions.run`
- `ibmi.actions.save`
- `ibmi.actions.delete`

## Library List
- `ibmi.libl.get`
- `ibmi.libl.set`
- `ibmi.libl.add`
- `ibmi.libl.remove`
- `ibmi.libl.setCurrent`
- `ibmi.libl.validate`
- `ibmi.libl.move`
- `ibmi.libl.prune`
- `ibmi.libl.runProfileCommand`

## Profiles
- `ibmi.profiles.list`
- `ibmi.profiles.save`
- `ibmi.profiles.delete`
- `ibmi.profiles.activate`

## Resolve
- `ibmi.resolve.path`

## Deploy
- `ibmi.deploy.uploadDirectory`
- `ibmi.deploy.uploadFiles`
- `ibmi.deploy.setCcsid`
- `ibmi.deploy.compare`
- `ibmi.deploy.sync`

### Deploy Notes
- `ibmi.deploy.compare` returns richer drift data: `onlyLocal`, `onlyRemote`, `identical`, `changed`, `unresolved`, and a `summary`.
- `ibmi.deploy.sync` supports `overwrite`, `dryRun`, and `deleteExtraRemote`.
- `ibmi.deploy.sync` returns execution mapping (`planned`, `applied`, `errors`) for safer automation, plus a `summary` with `planned`, `uploaded`, `unchanged`, `skipped`, `deleted` and `failed` counts.
- `ibmi.deploy.sync` takes `method`:
  - `all` (default): original behavior. Uploads files missing remotely; with `overwrite`, also files whose size differs or is unknown.
  - `changed`: compares SHA-256 hashes of files present on both sides (local with node crypto, remote with `sha256sum` or `openssl dgst -sha256` in batched calls) and uploads only missing or different files. Fails with a clear error when the IBM i has neither tool.
  - `gitChanged`: uploads the staged, unstaged and untracked files under `localPath` reported by `git status --porcelain -z` (run without a shell). Deleted files are listed in `planned.gitDeleted`, never removed remotely.
  - `selection`: uploads the paths listed in `files` (relative to `localPath`; absolute paths and `..` are refused).
- `deleteExtraRemote` works only with `all` and `changed`.
- `ibmi.deploy.compare` takes `method: "changed"` to compare by SHA-256 instead of size (`comparedBy: "sha256"`).

## Filters
- `ibmi.filters.list`
- `ibmi.filters.save`
- `ibmi.filters.delete`

## IFS Shortcuts
- `ibmi.ifs.shortcuts.list`
- `ibmi.ifs.shortcuts.add`
- `ibmi.ifs.shortcuts.delete`

## Debug
- `ibmi.debug.status`
- `ibmi.debug.startService`
- `ibmi.debug.stopService`
- `ibmi.debug.ready`

## SQL / CL
- `ibmi.sql.query`
- `ibmi.sql.execute`
- `ibmi.cl.run`

### SQL / CL Notes
- `ibmi.sql.query` supports cursor paging (`cursor`), `pageSize`, `maxRows`, `timeoutMs`, and optional `includeMetadata`.
- `ibmi.sql.execute` asks the user before writes under the guarded policy and supports optional `timeoutMs`.
- `ibmi.cl.run` supports `ile`, `qsh`, or `pase` execution with optional `timeoutMs`.
- Tool responses include structured envelopes (`structuredContent`) for machine-safe agent parsing.

## Diagnostics / Ops
- `ibmi.diagnostics.parseEvfevent`
- `ibmi.joblog.get`
- `ibmi.spool.list`
- `ibmi.spool.read`
- `ibmi.spool.hold`
- `ibmi.spool.release`
- `ibmi.spool.delete`
- `ibmi.spool.move`
- `ibmi.jobs.list`
- `ibmi.jobs.hold`
- `ibmi.jobs.release`
- `ibmi.jobs.end`
- `ibmi.jobs.runTest`
- `ibmi.jobs.waiting`
- `ibmi.jobs.find`
- `ibmi.jobs.log`
- `ibmi.jobs.diagnose`
- `ibmi.jobs.stack`
- `ibmi.joblog.parse`
- `ibmi.source.locateStatement`
- `ibmi.workbench.open`
- `ibmi.subsystems.list`
- `ibmi.subsystems.status`
- `ibmi.subsystems.start`
- `ibmi.subsystems.end`
- `ibmi.msgq.read`
- `ibmi.msgq.send`
- `ibmi.msgq.reply`
- `ibmi.locks.list`
- `ibmi.authority.object.get`
- `ibmi.dataqueue.send`
- `ibmi.dataqueue.receive`
- `ibmi.dataarea.read`
- `ibmi.dataarea.write`

## Jobs, job logs and why a job failed

All of these only read.

### `ibmi.jobs.find`

Jobs in any state, newest first: active, on a job queue, or ended with output still on the system (`ibmi.jobs.list` shows active jobs only). Left to itself it lists the connection user's jobs. `userName`, `name` (may end in `*`), `state` (`*ALL`, `*ACTIVE`, `*JOBQ`, `*OUTQ`), `sinceHours`, `limit`. Each job has `state`, and where the system knows them `completion` (`NORMAL` / `ABNORMAL`), `endReason`, `jobQueue`, `submittedBy`; an active job also has `activeStatus` (`MSGW` = waiting on a message) and `function`. `userName: "*ALL"` needs a `name`.

### `ibmi.jobs.log`

The job log of any job (`jobName` as `number/user/name`; left out, the connection's own job). Every message has `position`, `id`, `type`, `severity`, `time`, `text`, `help` (second-level text, formatting codes turned into line breaks), and `from` / `to` with `library`, `program`, `module`, `procedure` and `statement`.

- Filters: `types`, `minSeverity`, `messageId` (`CPF*`), `contains`; `order` (`oldest` / `newest`), `limit` (default 200, up to 5,000), `includeHelp: false` for a smaller answer.
- To follow a running job, pass the `lastPosition` of one answer as `after` in the next.
- `source` says where the messages came from. `live`: the job's message queue (`QSYS2.JOBLOG_INFO`). `spooled`: the job has ended and its log was printed, so its newest `QPJOBLOG` spooled file was read and parsed into the same shape (`spooledFile` names it; up to 60,000 lines).
- Reading another user's job log needs what the system asks for it: `*JOBCTL`, or being that user.

### `ibmi.jobs.diagnose`

One call that reads the end of a job's log (its last 3,000 messages) and answers "why did it fail":

- `verdict`: `failed`, `waiting` (a question nobody has answered), `warnings` (escape or severe messages, but the job did not fail), or `clean`. `summary` says it in a sentence.
- `ended`: the end code from the log (CPF1164) with its meaning; `job`: what the system knows about the job (state, completion, end reason, times).
- `failure`: the message that ended the work: the last escape message, or the question that was answered with a cancel. `waitingOn` for a job that waits. `rootCause`: the first serious message of the run that led there, when it is another one.
- `chain`: the messages that led to the failure, oldest first, without their second-level text.
- `suspect`: the program nearest the cause that is not in a library of the system's own, with module, procedure and statement, and whether it `received` the message (it was running the failing statement) or `sent` it.
- `location`: where that statement is in the source (see `ibmi.source.locateStatement`); `locate: false` skips it.
- `stack`: for a job that is still active, its call stack (the site's own programs when there are any).

The rules are simple and stated in `notes` when they could mislead: an escape message in a job that ended normally was handled; without a CPF1164 the log does not say how the job ended.

### `ibmi.jobs.stack`

The call stack of a job, newest call first (`QSYS2.STACK_INFO`): `library`, `program`, `module`, `procedure`, `statement`, and `own: true` for code that is not the system's. `ownOnly`, `allThreads`, `limit`.

### `ibmi.joblog.parse`

The same reading for job log text that was saved or pasted (`text`): the messages, and the diagnosis fields of `ibmi.jobs.diagnose` (`verdict`, `failure`, `chain`, `suspect`, ...). Needs no connection. Columns are taken from the page's own heading line, so a blank library or severity does not shift what follows; the order of day and month is taken from the dates themselves (`dateOrder` says which was used; dates that could be either are read month first when written with `/`). English job logs only. `limit: 0` returns the diagnosis alone.

### `ibmi.source.locateStatement`

From `library`, `program` and `statement` (and `module` when the program has several) to the source member or stream file the module was compiled from, and the line.

- `confidence: "exact"`: CL, whose statement numbers are the source sequence numbers.
- `confidence: "probable"`: the statement matches exactly one source sequence number (statement 32300 = sequence 323.00). That is the failing line when the module was compiled with `OPTION(*SRCSTMT)`. Without it the number counts lines of the compile listing, and the real line is at or before it.
- `confidence: "unknown"`: the source is known but not the line; `notes` say why (no such sequence number, a machine instruction number, several modules) and what to read instead.
- `sourceChangedSinceCompile` is true when the member was changed after the program was compiled.

To read the member's sequence numbers it creates an alias in `QTEMP` of the connection's job, as the other source readers do.

### `ibmi.workbench.open`

Returns a link (`url`) to a page on this computer that shows jobs, a job's log with its diagnosis, and the debug readiness check, for the person to look at themselves. `jobName` opens it on a job, `view: "debug"` on the readiness check. The page can also read a pasted job log.

- It listens on `127.0.0.1` only (port 3982, or another free one) and every request needs the key that is part of the link.
- It can call only these tools: `ibmi.jobs.find`, `ibmi.jobs.log`, `ibmi.jobs.diagnose`, `ibmi.jobs.stack`, `ibmi.joblog.parse`, `ibmi.source.locateStatement`, `ibmi.debug.ready`. The connection's policy applies to it as to the agent.
- A host application that embeds the page can listen for a window message of type `mcp-for-i.openSource` (`library`, `file`, `member`, `streamFile`, `line`) to open the source in its own editor; in a browser the button copies the location.

### `ibmi.debug.ready`

Checks whether programs on the system can be debugged from this computer through the IBM i Debug Service, and returns one entry per check (`ok` true, false, or null when it could not be told; `detail`; and for a failure `fix` and `who`: `you` or `administrator`):

- `installed`: the service is there and at version 3 or later.
- `running`, `debugServer`, `sepDaemon`: listeners on the debug port (`debugPort`, default 8005), the debug server port (3825) and the service entry point port (`debugSepPort`, default 8008).
- `certificate`: the service's certificate can be read, is in date, and is issued for the host name the connection uses (a connection by IP address fails this).
- `reachable`: one TLS handshake from this computer to the debug port, trusting only that certificate. Nothing is sent after the handshake. `checkNetwork: false` skips it.
- `password`: the connection has a stored password (the Debug Service signs on with user and password; a key is not enough).
- `program`, `sourceCurrent`: when `library` and `program` are given, whether its modules have debug data and whether their source changed since the compile.

It does not check the user's authority to `STRDBG` or to the program. This version checks readiness only; it does not run debug sessions (see [debugging](debugging.md)).

### Diagnostics Notes
- Diagnostics tools return normalized records suitable for downstream agents (`source`, normalized severity/status fields, and preserved raw fields).
- `ibmi.actions.run` now returns mapped execution status (`ok`, `status`) and parsed command diagnostics alongside raw command output.
- Spool controls now support hold/release/delete and output-queue move operations for targeted spool entries.
- Job and subsystem controls support both observability (`list`/`status`) and lifecycle actions (hold/release/end/start).
- Message queue tooling supports operational reads plus explicit send/reply workflows.
- Lock and authority tools are useful preflight checks before risky writes.
- Data queue and data area tooling covers common IBM i operational integration surfaces.

## Audit
- `ibmi.audit.list`
- `ibmi.audit.verify`
- `ibmi.audit.export`
- `ibmi.audit.purge`

### Audit Notes
- Tool calls are recorded in a tamper-evident local audit chain.
- `ibmi.audit.verify` validates hash continuity and head hash state.
- `ibmi.audit.export` supports `jsonl`, `json`, and `csv` output.
- `ibmi.audit.purge` supports `dryRun`; destructive purge asks the user under guarded (other profiles: `approve=true`).

## Journaling
- `ibmi.journal.objects.list`
- `ibmi.journal.entries.query`
- `ibmi.qaudjrn.events.query`
- `ibmi.journal.receiver.create`
- `ibmi.journal.create`
- `ibmi.journal.receiver.change`
- `ibmi.journal.startPf`
- `ibmi.journal.endPf`
- `ibmi.journal.startIfs`
- `ibmi.journal.endIfs`
- `ibmi.journal.receivers.retention`

### Journaling Notes
- `ibmi.journal.entries.query` supports advanced filters (`journalCode`, `entryType`, `userName`, `jobName`, `programName`) and normalizes key fields.
- `ibmi.qaudjrn.events.query` targets `QSYS/QAUDJRN` for security/compliance event review.
- `ibmi.journal.receivers.retention` supports `dryRun`; destructive cleanup asks the user under guarded (other profiles: `approve=true`).

## Compliance
- `ibmi.compliance.report.generate`

### Compliance Notes
- Generates preset compliance snapshots with audit-chain verification + QAUDJRN summaries.
- Optional evidence-bundle signing writes `<outputPath>.sig` and `<outputPath>.sha256`.

## TN5250
- `ibmi.tn5250.connect`
- `ibmi.tn5250.readScreen`
- `ibmi.tn5250.setField`
- `ibmi.tn5250.sendKeys`
- `ibmi.tn5250.click`
- `ibmi.tn5250.waitFor`
- `ibmi.tn5250.snapshot`
- `ibmi.tn5250.disconnect`

### TN5250 Notes
These tools drive a real 5250 display session over telnet (RFC 1205 / RFC 2877 / RFC 4777): what you see is the actual green screen, and anything an operator can do there (menus, prompts, interactive programs) can be done here.

- **connect**: opens one session per saved connection. The host is the connection's host; the port and TLS come from the connection (or global) settings `tn5250Port` and `tn5250Tls` (default port 23; port 992 or `tn5250Tls: true` means TLS), and can be overridden with `port` / `tls`. `deviceName` (or the `tn5250DeviceName` setting) requests a virtual device name. `screenSize: "27x132"` announces an IBM-3477-FC display; the default is IBM-3179-2 (24x80). `ccsid` (or the `tn5250Ccsid` setting) picks the single-byte EBCDIC code page for screen text; the matching `CODEPAGE`, `CHARSET` and `KBDTYPE` are announced to the host. Calling connect again while the session is open returns the current screen with `reused: true`.
- **Sign-on**: `signOn: true` uses the connection's saved user and password; a password is never accepted as a tool argument. Over TLS the credentials are offered in the telnet negotiation (RFC 4777 auto sign-on, which needs the `QRMTSIGN` system value to allow it). Otherwise, or if the host still shows a sign-on screen, the user and password fields of the sign-on screen are filled and Enter is pressed. The result reports `signOn.method` and `signOn.stillOnSignOnScreen`. On plain telnet (port 23) the password travels unencrypted, exactly as with any 5250 emulator; use TLS.
- **readScreen** returns `text` (one string per row), `cursor`, `keyboardLocked`, `inputInhibited` (an error message is showing; `errorLine` has it), `readPending` and `fields`. Each field has an `id` such as `r6c53` (row 6, column 53), `index`, `row`, `col`, `length`, a `label` taken from the text to its left, `protected`, `hidden`, `modified`, `numeric` and `commandLine` (labelled `===>`). Hidden (non-display, password-style) fields never include their content, only `hasValue`, and their positions are blank in `text`.
- **setField** fills a field locally by `fieldId` (id, 1-based index, or `"command"` for the command line) or by `row`/`col`. Nothing is sent until an AID key is pressed. `useStoredPassword: true` fills a hidden field with the connection's saved password (for example a re-sign-on prompt).
- **sendKeys** types `text` at the cursor (optionally after moving it with `cursorRow`/`cursorCol`), then presses `keys`: local keys `Tab`, `BackTab` (`Shift+Tab`), `Home`, `End`, `Reset`, `EraseEOF`, `EraseInput`, `FieldExit`, `Field+`, `Field-`, `Dup`, `Insert` (toggles insert mode, shown as `insertMode`), `Delete`, `Up`, `Down`, `Left` (`Backspace`), `Right` and `NewLine`, and at most one host key, last: `Enter`, `F1`-`F24`, `PageUp`/`PageDown` (Roll Down/Up), `Clear`, `Help`, `Print`, `Attn`, `SysReq`. A local key can be repeated with `*N` (`Down*3`). As in IBM emulators, `Esc` (also `Escape`, `Attention`) is `Attn` and `Shift+Esc` (also `SysRq`) is `SysReq`. Attn runs the job's attention program (the "Esc menu"); if the host sends nothing back within 5 seconds (no attention program), the keyboard is unlocked again and the result has a `note`. `Field+`/`Field-` right-adjust numeric fields (Field- marks the value negative), `Field Exit` right-adjusts fields that ask for it, and `Dup` fills a Dup-enabled field with the DUP character (shown as `*`). After an AID key it waits up to `timeoutMs` for the host to unlock the keyboard and returns the new screen with `settled`. If an error message has inhibited input, `Reset` is pressed automatically (`autoReset: true`).
- **click** works like an emulator mouse: it moves the cursor to `row`/`col`. A click on a function-key legend such as `F3=Exit` presses that key, and on `More...` presses PageDown (`hotspots: false` turns this off); `doubleClick: true` moves the cursor and presses Enter. Keys pressed by a click go through the same checks as sendKeys.
- **waitFor** waits for `text` to appear on any row and/or for the keyboard to unlock (`keyboardUnlocked`, default true when no text is given). An input-inhibited error state also counts as unlocked, because the host is waiting for the operator.
- **Live view**: as soon as a session opens, the MCP server serves a live 5250 page on `127.0.0.1` (port 3981, or the next free port; `tn5250LiveViewPort` sets it, `tn5250LiveView: false` turns it off). Every screen result carries `liveViewUrl`; the link holds a per-process token, so only someone with the link can open it. The page shows the session the agent drives and follows it live, and you can type and click in it like an emulator (Esc = Attn, Shift+Esc = SysReq, Ctrl alone = Reset, a click moves the cursor or presses a key legend, a double click presses Enter). While you type, the agent's setField, sendKeys and click calls are refused for a few seconds with a message asking it to wait and re-read the screen; `readScreen` then shows `personTyping: true` and `lastActor: "person"`. Your own keys skip the approval prompt but keep read-only mode, the read-only profile and deny lists. The control plane's Runtime tab lists the open sessions with an Open link. The screen scales to fill the space (fit to width or height), so the page embeds cleanly in a product at any size, including an iframe. The controls are optional: press the **Controls** button (top right), or add `view=screen` to the link, for a screen-only view that fills the whole area; `keys=0`, `header=0`, `hint=0` and `status=0` hide individual parts, and `chrome=full` forces everything on. The choice is remembered per browser, and a URL param always wins.
- **In-chat screen (MCP Apps)**: clients that support MCP Apps (`io.modelcontextprotocol/ui`) draw the same screen inside the chat after any 5250 tool call; you can type and click there too, and its key presses go through the 5250 tools, so the approval prompts still apply. Clients without that support see the usual text result and can use `liveViewUrl`.
- **snapshot** returns `plainText` plus the structured screen. **disconnect** closes the session; `ibmi.disconnect` and `ibmi.session.terminate` close it too.
- **Write gate**: every AID key goes through the write gate. Read-only connections (`readOnlyMode` or the `read-only` policy) refuse all AID keys, including Enter and `signOn`, so they can only open and read the first screen. When a recognised command line (`===>`) holds text, pressing a data-sending AID key is checked as `cl.run` with that text (command policy, and approval under the default guarded policy); any other AID key is checked as `tn5250.sendKeys` (add it to `requireApprovalFor` to ask the user first).
- Text typed into hidden fields is replaced by `***REDACTED***` in the server log and the audit record.
- Supported: TN5250 negotiation (TERMINAL-TYPE, BINARY, EOR, NEW-ENVIRON with DEVNAME, KBDTYPE, CODEPAGE and CHARSET), TLS with certificate pinning, Write To Display (SOH, SBA, SF with field format words, IC/MC, RA, EA, TD), Clear Unit (and Alternate for 27x132), Clear Format Table, Write Error Code, Read Input Fields / Read MDT Fields / Read Immediate / Read Screen, Save/Restore Screen, Roll and the 5250 Query. Text uses one of the single-byte CCSIDs 37, 273, 277, 278, 280, 284, 285, 297, 500, 871, 1047 and 1140-1149; double-byte (DBCS) code pages are not supported. The audit record of each 5250 call keeps the screen's first line, so you can see where a session went. Windows, pull-down menus and other Write To Display Structured Field constructs are skipped (their text still shows where the host writes it as plain data); a warning is listed in `warnings`.

## Object, Member and IFS Operations
- `ibmi.objects.copy` - `CRTDUPOBJ` to `toLibrary` (default: same library) as `newObject` (default: same name); `data=true` adds `DATA(*YES)` for `*FILE`.
- `ibmi.objects.move` - `MOVOBJ` to `toLibrary`.
- `ibmi.objects.rename` - `RNMOBJ` to `newObject`.
- `ibmi.objects.delete` - runs the delete command for the type (`DLTPGM`, `DLTSRVPGM`, `DLTF`, `DLTDTAARA`, ...). `objectType: "*LIB"` deletes the library named in `library` with `DLTLIB` and needs `confirmName` repeating the library name; under guarded the user confirms every library delete (other profiles: `approve=true`).
- `ibmi.objects.changeDescription` - `CHGOBJD TEXT(...)`; an empty `text` sets `*BLANK`.
- `ibmi.libraries.copy` - `CPYLIB FROMLIB TOLIB CRTLIB(*YES|*NO) DATA(*YES|*NO)`; `createLibrary` and `data` default to true; `timeoutMs` defaults to 10 minutes.
- `ibmi.qsys.members.copy` - `CPYSRCF ... MBROPT(*REPLACE)` to `toLibrary`/`toSourceFile`/`toMember` (each defaults to the source value). Refuses an existing target member unless `replace=true`.
- `ibmi.qsys.members.changeText` - `CHGPFM TEXT(...)`.
- `ibmi.qsys.members.changeType` - `CHGPFM SRCTYPE(...)`.
- `ibmi.ifs.copy` - `cp`, or `cp -R` with `recursive=true`.
- `ibmi.ifs.move` - `mv`.

### Object, Member and IFS Operation Notes
- All of these tools change the system: they are refused in read-only mode and by the read-only policy profile, and ask the user first when the guarded profile lists their operation (`qsys.write`; IFS tools use `ifs.write` or `qsys.write` for the destination, and `ibmi.ifs.move` also `ifs.delete`).
- Supported object types: `*PGM`, `*SRVPGM`, `*MODULE`, `*FILE`, `*DTAARA`, `*DTAQ`, `*CMD`, `*MSGF`, `*MENU`, `*PNLGRP`, `*BNDDIR`, `*JOBD`, `*OUTQ`, `*USRSPC`, `*USRIDX`, `*USRQ`, `*SQLPKG`, `*QRYDFN`, `*JRN`, `*JRNRCV`, `*SBSD`, `*CLS`, `*TBL` (plus `*LIB` for delete).
- Names are validated and uppercased; text is limited to 50 characters, quoted for CL, and may not contain control characters.
- Objects in IBM system libraries (`QSYS*`, `QUSRSYS`, `QRECOVERY`, `QSPL`, `QRPLOBJ`, `QHLPSYS`, `QDOC`, `QSRV`, `SYSIBM`, `SYSIBMADM`, `SYSPROC`, `SYSTOOLS`, `SYSCAT`, `SYSFUN`, `SYSSTAT`, `#*`) are never changed, moved, deleted or copied into. Deleting a library and copying into a library (`CPYLIB` target) also refuse every `Q*` name, including `QGPL` and `QTEMP`.
- The built CL command is checked against `allowCommands`/`denyCommands`, and every library involved against `allowLibraries`/`denyLibraries`. A failing command returns a tool error with the IBM i message.
- Member copy and attribute changes drop the cached member snapshot for the affected member.
- IFS copy/move check both paths against `allowPaths`/`denyPaths`. The destination (and the source of a move or recursive copy) gets the same guard as `ibmi.ifs.delete`: no root, top-level directory, `/QSYS.LIB/<lib>.LIB`, second-level `/QOpenSys` or `/QIBM` directory, IBM product directory, `..` or wildcards. The destination may not equal or sit inside the source. An existing destination is refused unless `overwrite=true`; an existing directory then receives the copied or moved entry inside it.

## Bulk Members
- `ibmi.members.downloadAll`
- `ibmi.members.uploadChanged`

### Bulk Members Notes
- `downloadAll` copies every member of `sourceFile` (or `sourceFiles`, or every source file in `library` when neither is given) to `localPath/LIB/FILE/MEMBER.ext`. The extension is the lowercased member type (`mbr` when the type is blank). `memberPrefix` and `sourceTypes` narrow the set; `maxMembers` (default 500, max 5000) caps it and the result reports `truncated`.
- A manifest `.mcp-for-i-members.json` in `localPath` records each member's source type, `version`, `sha256` and last-change timestamp.
- Re-running `downloadAll` keeps local files edited since the last download (reported in `skipped`) unless `overwrite: true`.
- `uploadChanged` walks the tree under `localPath` (filter with `library`, `sourceFile`, `members`). Files whose content still matches the manifest are skipped without contacting the IBM i. A member that changed on the IBM i since download, or exists remotely without a manifest entry, is reported in `conflicts` and not written unless `force: true`. Missing members are created with SRCTYPE from the manifest or the file extension (`createMissing`, default true).
- `uploadChanged` honors the write gate (read-only mode, policy, user confirmation), `denyLibraries`/`allowLibraries` for every library in the tree, and `dryRun`. Written members are dropped from the member snapshot cache and the manifest is updated with their new version.
- Line endings are normalized to LF before hashing and upload.

## Compare
- `ibmi.compare.text`

### Compare Notes
- Compares any two of: a source member (`{ "type": "member", "library", "sourceFile", "member" }`), an IFS stream file (`{ "type": "ifs", "path" }`) or a local file (`{ "type": "local", "path" }`). Member and IFS sides may name their own `connectionName`, so the same member can be compared across two systems.
- Returns a unified diff plus `stats` (`hunks`, `added`, `removed`), `identical`, and size/line count/SHA-256 for each side.
- Options: `context` (default 3), `ignoreTrailingWhitespace` (default true), `ignoreCase` (default false), `maxBytes` per side (default 2 MB, max 16 MB), `maxDiffLines` (default 2000; counts always cover the whole diff and `truncated` says when the text was cut).
- Members are read through the member snapshot reader: only the source text is compared (no sequence numbers or source dates) and the record padding is trimmed. A missing final newline is not reported as a difference.
- Local files must be inside the allowed local roots. IFS and local files must be UTF-8 text. Library and IFS path policies are checked for each side.

## Inspection
- `ibmi.objects.describe`
- `ibmi.members.describe`
- `ibmi.ifs.stat`
- `ibmi.programs.info`
- `ibmi.objects.whereUsed`
- `ibmi.tables.describe`
- `ibmi.routines.describe`

### Inspection Notes
- All inspection tools are read-only, cap their queries with `FETCH FIRST`, and upper-case and validate every name.
- `ibmi.objects.describe` reads `QSYS2.OBJECT_STATISTICS` (owner, size, text, attribute, created/changed/last-used/save dates and source file information when recorded). `objectType` defaults to `*ALL`. If the system rejects the `OBJECT_NAME` argument, the library listing is filtered by name instead. `attributes` holds every non-empty column the service returned.
- `ibmi.members.describe` reads `QSYS2.SYSPARTITIONSTAT` (source type, text, records, data size, created/changed/source-changed/last-used dates) plus the record length and the `SRCDTA` CCSID.
- `ibmi.ifs.stat` reads `QSYS2.IFS_OBJECT_STATISTICS` (type, CCSID, owner, size, dates). On releases without that service it falls back to `ls -ldL` (no CCSID) and adds a warning.
- `ibmi.programs.info` reads `QSYS2.PROGRAM_INFO` for a `*PGM` or `*SRVPGM` (program type, activation group, adopted authority, source location, target release), bound modules from `QSYS2.BOUND_MODULE_INFO`, bound service programs from `QSYS2.BOUND_SRVPGM_INFO`, and exports/imports from `QSYS2.PROGRAM_EXPORT_IMPORT_INFO`. For a service program it returns `binderSource` (`STRPGMEXP PGMLVL(*CURRENT) SIGNATURE(*GEN)` with one `EXPORT` per exported symbol). Check the export order against `DSPSRVPGM DETAIL(*SIGNATURE)` before binding with it. Missing optional services become `warnings`.
- `ibmi.objects.whereUsed` runs `DSPPGMREF` into a uniquely named QTEMP outfile and reads it in the same SQL job. `direction: "uses"` lists what a program references (`library`, `program`, optional `programType`). `direction: "usedBy"` scans every program, service program and module in `library` and returns the references to `object` (optional `objectLibrary`, which also matches `*LIBL` references, and `objectType`), plus a de-duplicated `programs` list. Scanning a large library can take a while.
- `ibmi.tables.describe` accepts system or SQL names and returns the table row from `QSYS2.SYSTABLES`, columns from `QSYS2.SYSCOLUMNS`, constraints with key columns (`SYSCST`/`SYSKEYCST`) and SQL indexes with their keys (`SYSINDEXES`/`SYSKEYS`). Keys of DDS keyed files and logical files are not included.
- `ibmi.routines.describe` returns every overload from `QSYS2.SYSROUTINES` with parameters from `QSYS2.SYSPARMS` and a readable `signature`. `includeDefinition` adds the SQL routine body (capped at 64 KB).

## Compile and errors
- `ibmi.actions.run` (compile against a member or streamfile)
- `ibmi.compile.listing`
- `ibmi.diagnostics.parseEvfevent`

### Compile Notes
- Member targets: pass `targetType: "member"` and `targetPath: "LIB/FILE/MEMBER[.TYPE]"` (or `library`, `sourceFile`, `member`). The action gets `&OPENLIB`, `&OPENSPF`, `&OPENMBR` (and lowercase `&OPENLIBL`, `&OPENSPFL`, `&OPENMBRL`), `&EXT` (member type, looked up when not given), `&EXTL`, `&NAME`, `&NAMEL`, `&BASENAME`, `&SRCFILE` (`LIB/FILE`), `&SRCLIB`, `&SRCPF`.
- Streamfile targets: `targetPath` is an absolute IFS path. The action gets `&FULLPATH`, `&RELATIVEPATH` (relative to the working directory), `&FILEDIR`, `&PARENT`, `&BASENAME`, `&NAME`, `&NAMEL`, `&EXT`, `&EXTL`. The working directory is `cwd`, else `remoteWorkspace`, else the home directory.
- Built-in actions are typed `member` or `streamfile`; running one against the other kind of target is refused, and so is any command that still contains a target variable the target did not set (for example `&RELATIVEPATH` on a member).
- Longer variable names are substituted first and a name only matches as a whole word, so `&EXT` does not corrupt `&EXTL`.
- When the command uses `OPTION(*EVENTF)`, the EVFEVENT member is read from the library and name of the object the command creates (`PGM(`, `MODULE(`, `OBJ(`, `SRVPGM(`, `CMD(`, `FILE(` ...; `*CURLIB`/`*LIBL` resolve to the current library). Override with `evfeventLibrary` / `evfeventMember`. The result has `errors` (grouped by source file, each with `line`, `column`, `endLine`, `endColumn`, `severity`, `severityLevel`, `msgid`, `text`) and `errorSummary`.
- `deployFirst`: with `localWorkspace` and `remoteWorkspace`, the workspace is pushed with `ibmi.deploy.sync` (`overwrite: true`) before the command runs. Without a local workspace the deploy is reported as skipped.
- `postDownload`: listed paths (relative to the working directory, or absolute) are downloaded to `downloadTo` (default `localWorkspace`). Downloaded `.evfevent` files are parsed and merged into `errors`.
- `outputToFile`: the command, exit code, stdout and stderr are written to this local path. `&LOCAL` or a relative path resolves against `localWorkspace`.
- `includeListing: true` returns the compile listing: the newest spooled file named after the object (else `QSYSPRT`, else `QPJOBLOG`) owned by the user and created since the command started.
- A failed command is returned as a tool error that names the first EVFEVENT error.
- `ibmi.compile.listing` (read-only) fetches the same listing on its own: `objectName`, optional `userName`, `since` (IBM i timestamp) and `maxLines`.
- `ibmi.diagnostics.parseEvfevent` parses EVFEVENT text (TIMESTAMP, PROCESSOR, FILEID, FILEEND, EXPANSION, ERROR records). Errors that the compiler reports against a temporary file such as `QTEMP/QSQLTEMP1` are mapped back to the original source line through the precompiler's EXPANSION records.

## System Information
- `ibmi.system.info` (read-only)

Returns, in one call:
- `os`: release (from `SYSIBMADM.ENV_SYS_INFO`), host name, CPUs, memory, plus partition and ASP figures from `QSYS2.SYSTEM_STATUS_INFO`.
- `ptfGroups`: one row per PTF group from `QSYS2.GROUP_PTF_INFO` with the latest level known, its status and the latest installed level. Capped by `ptfGroupLimit` (default 100, max 1000) with `truncated`.
- `authorities`: the current user's class, special authorities, group profiles and limited capabilities from `QSYS2.USER_INFO`.
- `systemValues`: an allow-listed set of system values from `QSYS2.SYSTEM_VALUE_INFO` (security, national language, date/time, library list, model). `systemValues` picks a subset; names outside the allow-list are rejected.
- `pase` and `tools`: `uname`, a few environment variables (PATH, HOME, SHELL, LANG, LC_ALL, TZ, QIBM_CCSID, QIBM_PASE_CCSID) and where pfgrep, openssl, git, bash, python3, node, java and mapepire-server are installed, gathered by one PASE command (`command -v`, then `/QOpenSys/pkgs/bin`).

Pick parts with `sections` (`os`, `ptfGroups`, `authorities`, `systemValues`, `pase`, `tools`). A section that fails is reported under `errors` and the others are still returned.

## Search by Change Date
- `ibmi.search.changedLines` (read-only)

Finds source lines whose `SRCDAT` falls between `from` and `to` (inclusive, `YYYY-MM-DD`; `to` defaults to today). `member` is a member name or a generic name with `*` (`ORD*`, `*ALL`, the default); `memberType` narrows a generic search. Each hit has the member, line number, sequence number, date and text.

- `SRCDAT` stores `YYMMDD`. Years 40-99 are read as 1940-1999 and 00-39 as 2000-2039 (the IBM i two-digit year window). Lines with no date are never returned.
- Each member is read with a `QTEMP` alias created in the same SQL job as the query.
- `maxLines` (default 500, max 5000) and `maxMembers` (default 50, max 500) cap the work; `truncated` and `truncatedReason` say when either was hit. For a generic search, a member that cannot be read is listed under `errors`.

## Library List Tidying
- `ibmi.libl.move`: move a library to a 1-based `position`, or `direction` `up`/`down` by `steps` (default 1), or `top`/`bottom`.
- `ibmi.libl.prune`: remove libraries that no longer exist (checked with `QSYS2.OBJECT_STATISTICS`). `dryRun` only reports. A missing current library is reported, not changed.
- `ibmi.libl.runProfileCommand`: run a profile's `setLibraryListCommand` (the active profile by default, or `profileName`) and store the user library list and current library it produces, read back from `QSYS2.LIBRARY_LIST_INFO` in the same SQL job. `saveToProfile` also stores the result in the profile. Set the command with `ibmi.profiles.save` (`profile.setLibraryListCommand`). The command is checked against the CL command policy.

All three update the stored connection settings the same way `ibmi.libl.set` does, need a writable connection, ask the user first under guarded policies, and run `CHGLIBL`/`CHGCURLIB` when `applyToJob` is true.


### SQL query completeness

ibmi.sql.query requires transport evidence that proves completion. It returns
at most maxRows + 1 rows to the server, including when SQL already has a row
limit. maxRows defaults to 1000 (maximum 20000); pageSize defaults to 200
(maximum 5000). totalRows counts retained rows across all buffered pages, not
all matching rows in the database. Every cursor page repeats totalRows and
truncated. A true truncated flag means an extra row was observed and omitted;
a false flag means the result was exhausted. SQL warnings, malformed completion
metadata and later fetch failures return an MCP error without successful partial
rows.

A statement the database rejects (an unknown column or table, bad syntax)
returns the database's own message and SQLSTATE on both transports, for
example `[SQL0206] Column or global variable X not found. (42703)`. It does not
end the persistent SQL job: QTEMP and session settings are kept. Only a cancel,
a timeout or a transport or cleanup failure discards the job.

QZDFMDB2 adds `FETCH FIRST maxRows + 1 ROWS ONLY` at the end of the statement,
before a trailing isolation (`WITH UR|CS|RS|RR|NC`) or `FOR READ|FETCH ONLY`
clause. The statement is never wrapped in a derived table, which Db2 for i
rejects for `WITH` (common table expressions), `WITH NC` and `FOR READ ONLY`.
A statement that ends in its own row limit, or in a clause the limit cannot
follow (`OPTIMIZE FOR`, `KEEP ... LOCKS`, `SKIP LOCKED DATA` and similar), is
sent as written: its whole result crosses the SSH channel, rows past
maxRows + 1 are dropped, and the result is reported truncated. QZDFMDB2
requires one final selected-row footer whose count exactly matches parsed rows,
a real clean SSH exit and no SQL diagnostics in either output stream. A
diagnostic that arrives with rows still printed (a data mapping error prints a
wrong value) fails with the job's own message. Missing, ambiguous or mismatched
footers fail without returning partial rows; a mismatch usually means a value
contains a line break, which this text transport cannot carry. Cancellation
closes that command's SSH channel and late success is rejected. Internal runSQL
source SELECTs validate the same footer; no-row DDL/CL batches need no SELECT
footer.
Metadata includes completenessProof on both initial and cursor pages: transport,
method, reportedRowCount, parsedRowCount, exitValidated and footerValidated.
Mapepire uses continuation-protocol evidence; QZDFMDB2 uses selected-row-footer.
False exit/footer flags for Mapepire mean those shell/text checks do not apply.

The corrected continuation defect could return exactly 2000 rows: execute
fetched the initial 1000 and fetchMore fetched another 1000, then the adapter
stopped because continuation responses omit has_results. Continuation now
follows the explicit is_done flag, including terminal empty fetches when needed.
Cancellation keeps the SQL job queue occupied until cancellation and cleanup
settle; a cancelled query, or one that failed for a reason other than the
database rejecting the statement, discards its SQL job before the next
statement. A resolved sqlclose failure also rejects the query.

## Test jobs and jobs that wait on a message

A program run to try it out can send an inquiry message that nobody is there to answer. Submitted with `INQMSGRPY(*RQD)` the job waits for ever and holds its job queue. Submitted with `INQMSGRPY(*DFT)`, a message that has no valid default reply can be asked again and again and fill `QSYSOPR`. A program called in the connection's own job (`ibmi.cl.run` with `CALL`, or SQL `CALL`) leaves that shared database server job stuck instead.

### `ibmi.jobs.runTest`

Runs one CL command as a batch job and watches it.

- It submits `SBMJOB CMD(<command>) JOB(<name>) INQMSGRPY(*DFT) LOG(4 00 *SECLVL)`, with `JOBD`, `JOBQ`, `INLLIBL` and `CURLIB` when given. `command` is one CL command without comments or double quotes (`/* */` and `"` are refused: either could close `CMD(` early). The job name always ends in random characters; `jobName` gives its first six. The submit itself is given 30 seconds. Every run leaves a `QPJOBLOG` spooled file.
- With `INQMSGRPY(*DFT)` the system gives a question its default reply and the program carries on until the next look, one to five seconds later. This tool never replies to a message itself.
- Policy: the command is held to `denyCommands` and `allowCommands` as if it were run directly, and the `SBMJOB` as it will run goes through the same approval as `ibmi.cl.run`, so an `allowCommands` list must name `SBMJOB` as well as the command. The libraries of `jobQueue` and `jobDescription` are held to `denyLibraries` and `allowLibraries`. Read-only connections are refused.
- Nothing is submitted when the job services it needs do not answer (`not-available`), or when a job of that name and user entered the system in the same second (`not-started`).
- The job taken for the new one is the job of this user and name that entered the system at or after the submit and, when the connection has a long-lived SQL job, was submitted by that job. When none or more than one fits, no job is adopted and none is ended (`not-found`). A job that runs under another user (a job description with its own `USER`) is therefore not found and not watched.
- It looks at the job every one to five seconds until it ends. A look that fails is retried; after three failures in a row, or when looks still do not work once the time is up, the job is ended and the outcome is `watch-lost`. A look that is only slow (no answer in 15 seconds) is waited out until the time limit.
- If the job asked a question, answered or not, it is ended (`ENDJOB OPTION(*IMMED)`) and the result carries the message. A question is looked for in the job's log and on the two message queues it can land on, `QSYSOPR` and the job user's own; a queue the user may not read is not looked at. Status `MSGW` alone does not end a job early, because a program that waits for work on a message queue shows the same status.
- If the job is still running, or still on its job queue, after `timeoutSeconds` (default 120, at most 3600), it is ended.
- `onInquiry: "report"` and `onTimeout: "report"` leave the job as it is and report it. So does a policy that denies `ENDJOB`.
`outcome` is one of:

| Outcome | Meaning |
|---|---|
| `completed` | Ended normally, and no question from it was found on the operator's queue or the user's own. The note says so when the operator's queue could not be read. The only outcome with `ok: true`. |
| `completed-after-inquiry` | Ended by itself, but it asked a question that got the default reply. Treat its result as unreliable. |
| `failed` | Ended abnormally. |
| `ended-on-inquiry` | Asked a question and was ended. |
| `waiting-on-inquiry` | Asked a question and was left (report mode, a policy that forbids ending, or an end the system refused; the note says which). |
| `ended-on-timeout` | Still running at the time limit and ended. |
| `still-running` | Still running at the time limit and left, or an end was tried and failed; the note says which. |
| `not-started` | The system refused the submit (a CPF or CPD message), a job of that name had just entered the system, or the job never left its job queue. In the last case it is taken off the queue unless `onTimeout` is `report`, the policy forbids ending, or the end fails; the note says which. |
| `not-found` | Submitted, but no single job could be identified as the new one. Not watched. |
| `not-available` | Nothing was submitted: jobs cannot be watched on this system or with this user. |
| `submit-timed-out` | The submit did not answer or its answer was lost. If exactly one job submitted by the connection's job is found from a new job, it is ended. A job found by name alone is named and left. Otherwise it is not known whether one was submitted. |
| `watch-lost` | The job could no longer be watched and was ended; if it could not be ended, the note says it may still be running. |
| `unknown` | The system no longer knows the job. |

The result also has `jobName`, `seconds`, `inquiry`, `ended` (`byWatcher`; `verified: true` only when the job was then seen on the output queue or gone, a job still shown as ending is not verified; completion status and end reason), the last job log messages seen while the job was active, and a `note` that says what to do next.

Limits worth knowing: the watch runs inside the tool call, so `timeoutSeconds` should stay under the client's own time limit for a tool call; if the client gives up first, or the server process stops, the job is no longer watched. On a slow system a look, the end and its check can each take up to tens of seconds, so the call can return well after `timeoutSeconds`. Queries the tool stopped waiting for are not cancelled and can delay the next call on the connection. Every job the server ends by itself is recorded in the audit record of the tool call (`serverEndedJobs`).

### `ibmi.jobs.waiting`

Lists the jobs working for the connection's user that are in `MSGW`, with the message when it can be read, and says which of them were submitted from this server. It includes database server jobs that run under another user (`QZDASOINIT` under `QUSER`) on this user's behalf, and leaves out interactive sessions. On a system without the job services it answers `available: false`.

A narrower look is added to the result of `ibmi.jobs.runTest`, of `ibmi.cl.run` in the ILE environment when the command calls a program or submits a job (`CALL`, `CALLPRC`, `SBMJOB`) or failed, of any `ibmi.cl.run` that timed out, and of a failed `ibmi.sql.execute` `CALL`. It reports only what the call could have caused: a job submitted from here, or a job with a question asked in the last ten minutes (since the call began, after a timeout). When there is one, the result gains `waitingJobs` and `waitingJobsNote`. Other commands cost no extra queries; a successful `CALL` costs two, an `SBMJOB` five. The tool stops waiting for the look after six seconds (after a timeout, see below, up to about a minute), and it never fails the tool. Set `watchWaitingJobs: false` on a connection to switch it off.

### When the connection's own job is the one that is stuck

`ibmi.cl.run` in the ILE environment and SQL statements run in the connection's long-lived job. A command there can ask a question too: a program it calls, a trigger, or a command's validity checking program (which `SBMJOB` also runs, in the submitting job, for the command it is given). The call then times out, and the job, a pooled database server job such as `QZDASOINIT`, keeps waiting on the message after the connection has let go of it.

After a timeout in `ibmi.cl.run` (ILE), `ibmi.sql.execute` or the submit of `ibmi.jobs.runTest`, and only when the statement still running in the connection's job is the one this call started, that job is looked at from a new job. If it is in `MSGW`, still working for this user, and a question it asked since the call began has no reply yet, the result gains `stuckJob` (`jobName`, `message`, `ended`, and `reason` when it was not ended) and `stuckJobNote`.

By default the job is reported and not ended (`stuckConnectionJob: "report"`): the person or an operator ends it or answers the message. With `stuckConnectionJob: "end"` it is ended (`ENDJOB OPTION(*IMMED)`) when the policy does not deny `ENDJOB`; it is checked once more immediately before the end, the end is waited for and reported, and the next call opens a new job. The person is not asked, in any approval mode. A job that is only slow, one that waits on a message queue without such a question (a program waiting for work looks the same), and one the system has handed to another user are left alone. The message stays listed on the operator's queue; it needs no answer once its job has ended.

Limits: on a shared profile, "still working for this user" cannot tell two clients of the same user apart. A call that timed out while it was still waiting behind another call on the connection does not look at the connection's job at all. A call that timed out can return up to about a minute after its `timeoutMs`.

A command's validity checker is resolved through the library list of the job that runs or submits the command. If a site keeps such programs in a library that is not on the connection's library list, compiles and submits fail this way: put that library on the connection's list.

### Jobs submitted from here

A job submitted from this server through `ibmi.jobs.runTest`, or through an `SBMJOB` with `ibmi.cl.run`, is remembered while the server runs, until `ibmi.disconnect` or `ibmi.session.terminate` for that connection (the most recent 200 per connection name; an idle timeout or a reconnect does not forget them). `ibmi.cl.run` returns it as `submittedJob` when it can be identified: on the persistent SQL job, in the ILE environment, from the system's own completion message of that call (its English text), for a job of this user that the connection's job submitted during the call. In host mode, ending a remembered job with `ibmi.jobs.end` is the operation `jobs.endOwn`; ending any other job stays `jobs.end`. In `prompt` and `agent` mode every job is `jobs.end`, as before.
