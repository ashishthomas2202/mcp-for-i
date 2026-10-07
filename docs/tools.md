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
- Sessions are stateful per IBM i connection.
- `setField` supports `fieldId: "command"` (or `"1"` alias), then `sendKeys: "Enter"` to execute.
- `sendKeys` supports guardrails through policy checks and optional `approve=true` for guarded operations.

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
