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

## Object, Member and IFS Operations
- `ibmi.objects.copy` - `CRTDUPOBJ` to `toLibrary` (default: same library) as `newObject` (default: same name); `data=true` adds `DATA(*YES)` for `*FILE`.
- `ibmi.objects.move` - `MOVOBJ` to `toLibrary`.
- `ibmi.objects.rename` - `RNMOBJ` to `newObject`.
- `ibmi.objects.delete` - runs the delete command for the type (`DLTPGM`, `DLTSRVPGM`, `DLTF`, `DLTDTAARA`, ...). `objectType: "*LIB"` deletes the library named in `library` with `DLTLIB` and needs `approve=true` plus `confirmName` repeating the library name.
- `ibmi.objects.changeDescription` - `CHGOBJD TEXT(...)`; an empty `text` sets `*BLANK`.
- `ibmi.libraries.copy` - `CPYLIB FROMLIB TOLIB CRTLIB(*YES|*NO) DATA(*YES|*NO)`; `createLibrary` and `data` default to true; `timeoutMs` defaults to 10 minutes.
- `ibmi.qsys.members.copy` - `CPYSRCF ... MBROPT(*REPLACE)` to `toLibrary`/`toSourceFile`/`toMember` (each defaults to the source value). Refuses an existing target member unless `replace=true`.
- `ibmi.qsys.members.changeText` - `CHGPFM TEXT(...)`.
- `ibmi.qsys.members.changeType` - `CHGPFM SRCTYPE(...)`.
- `ibmi.ifs.copy` - `cp`, or `cp -R` with `recursive=true`.
- `ibmi.ifs.move` - `mv`.

### Object, Member and IFS Operation Notes
- All of these tools change the system: they are refused in read-only mode and by the read-only policy profile, and need `approve=true` when the guarded profile lists their operation (`qsys.write`; IFS tools use `ifs.write` or `qsys.write` for the destination, and `ibmi.ifs.move` also `ifs.delete`).
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
- `uploadChanged` honors the write gate (read-only mode, policy, `approve`), `denyLibraries`/`allowLibraries` for every library in the tree, and `dryRun`. Written members are dropped from the member snapshot cache and the manifest is updated with their new version.
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
