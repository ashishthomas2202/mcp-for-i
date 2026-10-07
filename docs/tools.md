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

All three update the stored connection settings the same way `ibmi.libl.set` does, need a writable connection, accept `approve` for guarded policies, and run `CHGLIBL`/`CHGCURLIB` when `applyToJob` is true.
