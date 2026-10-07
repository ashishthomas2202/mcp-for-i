# Tools

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

## Composite Source Inspection

- `ibmi.source.resolve`
- `ibmi.source.inspect`

`ibmi.source.inspect` batches metadata, outline, search, range-read, and dependency extraction over one versioned source snapshot.

## Official IBM i Documentation

- `ibmi.docs.search`
- `ibmi.docs.open`

The documentation catalog is also exposed through MCP resources: `ibmi-docs://catalog` and `ibmi-docs://topic/{ref}`.

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
- `ibmi.deploy.sync` returns execution mapping (`planned`, `applied`, `errors`) for safer automation.

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

## SQL / CL
- `ibmi.sql.query`
- `ibmi.sql.execute`
- `ibmi.cl.run`

### SQL / CL Notes
- `ibmi.sql.query` supports cursor paging (`cursor`), `pageSize`, `maxRows`, `timeoutMs`, and optional `includeMetadata`.
- `ibmi.sql.execute` supports guarded writes with `approve=true` and optional `timeoutMs`.
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
- `ibmi.audit.purge` supports `dryRun`; destructive purge requires `approve=true`.

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
- `ibmi.journal.receivers.retention` supports `dryRun`; destructive cleanup requires `approve=true`.

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
- `ibmi.tn5250.waitFor`
- `ibmi.tn5250.snapshot`
- `ibmi.tn5250.disconnect`

### TN5250 Notes
These tools drive a real 5250 display session over telnet (RFC 1205 / RFC 2877 / RFC 4777): what you see is the actual green screen, and anything an operator can do there (menus, prompts, interactive programs) can be done here.

- **connect**: opens one session per saved connection. The host is the connection's host; the port and TLS come from the connection (or global) settings `tn5250Port` and `tn5250Tls` (default port 23; port 992 or `tn5250Tls: true` means TLS), and can be overridden with `port` / `tls`. `deviceName` (or the `tn5250DeviceName` setting) requests a virtual device name. `screenSize: "27x132"` announces an IBM-3477-FC display; the default is IBM-3179-2 (24x80). Calling connect again while the session is open returns the current screen with `reused: true`.
- **Sign-on**: `signOn: true` uses the connection's saved user and password; a password is never accepted as a tool argument. Over TLS the credentials are offered in the telnet negotiation (RFC 4777 auto sign-on, which needs the `QRMTSIGN` system value to allow it). Otherwise, or if the host still shows a sign-on screen, the user and password fields of the sign-on screen are filled and Enter is pressed. The result reports `signOn.method` and `signOn.stillOnSignOnScreen`. On plain telnet (port 23) the password travels unencrypted, exactly as with any 5250 emulator; use TLS.
- **readScreen** returns `text` (one string per row), `cursor`, `keyboardLocked`, `inputInhibited` (an error message is showing; `errorLine` has it), `readPending` and `fields`. Each field has an `id` such as `r6c53` (row 6, column 53), `index`, `row`, `col`, `length`, a `label` taken from the text to its left, `protected`, `hidden`, `modified`, `numeric` and `commandLine` (labelled `===>`). Hidden (non-display, password-style) fields never include their content, only `hasValue`, and their positions are blank in `text`.
- **setField** fills a field locally by `fieldId` (id, 1-based index, or `"command"` for the command line) or by `row`/`col`. Nothing is sent until an AID key is pressed. `useStoredPassword: true` fills a hidden field with the connection's saved password (for example a re-sign-on prompt).
- **sendKeys** types `text` at the cursor (optionally after moving it with `cursorRow`/`cursorCol`), then presses `keys`: local keys `Tab`, `BackTab`, `Home`, `Reset`, `EraseEOF`, `FieldExit`, and at most one AID key, last: `Enter`, `F1`-`F24`, `PageUp`/`PageDown` (Roll Down/Up), `Clear`, `Help`, `Print`, `Attn`, `SysReq`. After an AID key it waits up to `timeoutMs` for the host to unlock the keyboard and returns the new screen with `settled`. If an error message has inhibited input, `Reset` is pressed automatically (`autoReset: true`).
- **waitFor** waits for `text` to appear on any row and/or for the keyboard to unlock (`keyboardUnlocked`, default true when no text is given). An input-inhibited error state also counts as unlocked, because the host is waiting for the operator.
- **snapshot** returns `plainText` plus the structured screen. **disconnect** closes the session; `ibmi.disconnect` and `ibmi.session.terminate` close it too.
- **Write gate**: every AID key goes through the write gate. Read-only connections (`readOnlyMode` or the `read-only` policy) refuse all AID keys, including Enter and `signOn`, so they can only open and read the first screen. When a recognised command line (`===>`) holds text, pressing a data-sending AID key is checked as `cl.run` with that text (command policy, and approval under the default guarded policy); any other AID key is checked as `tn5250.sendKeys` (add it to `requireApprovalFor` to require `approve=true`).
- Text typed into hidden fields is replaced by `***REDACTED***` in the server log and the audit record.
- Supported: TN5250 negotiation (TERMINAL-TYPE, BINARY, EOR, NEW-ENVIRON with DEVNAME, KBDTYPE, CODEPAGE and CHARSET), TLS with certificate pinning, Write To Display (SOH, SBA, SF with field format words, IC/MC, RA, EA, TD), Clear Unit (and Alternate for 27x132), Clear Format Table, Write Error Code, Read Input Fields / Read MDT Fields / Read Immediate / Read Screen, Save/Restore Screen, Roll and the 5250 Query. Text uses CCSID 37. Windows, pull-down menus and other Write To Display Structured Field constructs are skipped (their text still shows where the host writes it as plain data); a warning is listed in `warnings`.
