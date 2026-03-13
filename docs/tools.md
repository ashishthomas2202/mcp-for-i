# Tools

## Connection
- `ibmi.connect`
- `ibmi.disconnect`
- `ibmi.session.list`
- `ibmi.session.status`
- `ibmi.session.keepalive`
- `ibmi.session.terminate`
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
