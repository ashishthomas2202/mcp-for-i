# Playbooks

## 1) Safe Session Preflight
1. `ibmi.connections.list` to confirm configured connection.
2. `ibmi.connect`.
3. `ibmi.session.status`.
4. Optional: `ibmi.libl.get` and `ibmi.libl.set` for task scope.

## 2) Source Member Edit Cycle
1. Create temp library/source file (`ibmi.qsys.libraries.create`, `ibmi.qsys.sourcefiles.create`).
2. Create/write member (`ibmi.qsys.members.create`, `ibmi.qsys.members.write`).
3. Validate content (`ibmi.qsys.members.read`, `ibmi.resolve.path`).
4. Cleanup (`ibmi.qsys.members.delete`, `DLTF`, `DLTLIB` via `ibmi.cl.run`).

## 3) IFS + Deploy Validation
1. Create temp IFS path (`ibmi.ifs.mkdir`).
2. Write/read/list (`ibmi.ifs.write`, `ibmi.ifs.read`, `ibmi.ifs.list`).
3. Compare/sync (`ibmi.deploy.compare`, `ibmi.deploy.sync` with `dryRun` first).
4. Optional uploads (`ibmi.deploy.uploadDirectory`, `ibmi.deploy.uploadFiles`).
5. Cleanup (`ibmi.ifs.delete` recursive).

## 4) SQL/CL Diagnostics Flow
1. Read-only probe (`ibmi.sql.query`).
2. Guarded write (`ibmi.sql.execute` with `approve: true`).
3. Run CL command (`ibmi.cl.run`).
4. Collect evidence (`ibmi.joblog.get`, `ibmi.diagnostics.parseEvfevent`).

## 5) Operations Control Flow
1. Inspect first (`ibmi.jobs.list`, `ibmi.spool.list`, `ibmi.subsystems.list`, `ibmi.msgq.read`).
2. Execute minimal write action with `approve: true`.
3. Re-read affected surface to confirm outcome.
4. Capture errors verbatim when command-level actions fail.

## 6) Audit + Journaling + Compliance Flow
1. Verify audit chain (`ibmi.audit.verify`).
2. Read events (`ibmi.audit.list`, `ibmi.journal.entries.query`, `ibmi.qaudjrn.events.query`).
3. Export evidence (`ibmi.audit.export`, `ibmi.compliance.report.generate`).
4. Apply retention in controlled mode (`dryRun: true`, then approved execution).

## 7) TN5250 Interactive Flow
1. `ibmi.tn5250.connect` (`signOn: true` signs on with the stored credentials).
2. `ibmi.tn5250.readScreen` / `snapshot`: read `text` rows and `fields` (ids like `r6c53`; hidden fields never show their content).
3. `ibmi.tn5250.setField` (or `sendKeys` with `text`), then `sendKeys` with one AID key such as `Enter` or `F3`. AID keys are refused on read-only connections; text on a `===>` command line is checked like `ibmi.cl.run`.
4. `ibmi.tn5250.waitFor` until expected text or the keyboard unlocks.
5. `ibmi.tn5250.disconnect`.
