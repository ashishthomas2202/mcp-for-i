# MCP-for-i Capabilities (Current)

This document summarizes what `mcp-for-i` can do today across the MCP server and local control-plane workflow.

Version context: `0.1.8` codebase.

## 1) Platform Capabilities

### 1.1 Secure Onboarding and Connection Management
- Local control plane for adding/updating/deleting saved IBM i connections.
- Credential handling via OS keychain flow (no plaintext password arguments in MCP connection tools).
- Connection policies per profile (`read-only`, `guarded`, `power-user`).
- Connection profiles for per-user/per-context library and variable settings.

### 1.2 Runtime Safety and Policy Guardrails
- Strict tool input schemas (`additionalProperties: false`) with runtime validation.
- Guarded approval model (`approve=true`) for sensitive operations.
- Read-only mode enforcement.
- Validation for critical identifiers (QSYS names, journaling object names, etc.).

### 1.3 Session Lifecycle
- Multi-session tracking.
- Session status/list/keepalive/terminate operations.
- Sliding inactivity timeout.
- Heartbeat and reconnect behavior.

### 1.4 Agent-Safe Structured Results
- Tool responses expose structured payloads for automation.
- SQL/CL/diagnostic outputs normalized where applicable.
- TN5250 state model includes machine-readable fields/history.

### 1.5 Auditing and Compliance Foundations
- Tamper-evident hash-chain audit record for tool calls.
- Audit verification, export, and retention purge controls.
- Compliance report generation with optional signed evidence bundle.

### 1.6 IBM i Operations Control (Phase 7)
- Spool lifecycle controls (hold/release/delete/move by job/file/number).
- Job lifecycle controls (list/hold/release/end).
- Subsystem lifecycle controls (list/status/start/end).
- Message queue operations (read/send/reply).
- Preflight operational visibility (lock contention + object authority lookup).
- Data queue and data area operations for integration and runbook workflows.

## 2) Complete MCP Tool Catalog

### Connection and Session
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

### QSYS and Source Management
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

### IFS Operations
- `ibmi.ifs.list`
- `ibmi.ifs.read`
- `ibmi.ifs.write`
- `ibmi.ifs.mkdir`
- `ibmi.ifs.delete`
- `ibmi.ifs.upload`
- `ibmi.ifs.download`

### Search and Resolution
- `ibmi.search.members`
- `ibmi.search.ifs`
- `ibmi.find.ifs`
- `ibmi.resolve.path`

### Actions, Filters, Profiles, Library List
- `ibmi.actions.list`
- `ibmi.actions.run`
- `ibmi.actions.save`
- `ibmi.actions.delete`
- `ibmi.filters.list`
- `ibmi.filters.save`
- `ibmi.filters.delete`
- `ibmi.profiles.list`
- `ibmi.profiles.save`
- `ibmi.profiles.delete`
- `ibmi.profiles.activate`
- `ibmi.libl.get`
- `ibmi.libl.set`
- `ibmi.libl.add`
- `ibmi.libl.remove`
- `ibmi.libl.setCurrent`
- `ibmi.libl.validate`
- `ibmi.ifs.shortcuts.list`
- `ibmi.ifs.shortcuts.add`
- `ibmi.ifs.shortcuts.delete`

### Deploy and File Sync
- `ibmi.deploy.compare`
- `ibmi.deploy.sync`
- `ibmi.deploy.uploadDirectory`
- `ibmi.deploy.uploadFiles`
- `ibmi.deploy.setCcsid`

### SQL, CL, Diagnostics, Spool, Debug
- `ibmi.sql.query`
- `ibmi.sql.execute`
- `ibmi.cl.run`
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
- `ibmi.debug.status`
- `ibmi.debug.startService`
- `ibmi.debug.stopService`

### Audit and Compliance
- `ibmi.audit.list`
- `ibmi.audit.verify`
- `ibmi.audit.export`
- `ibmi.audit.purge`
- `ibmi.compliance.report.generate`

### Journaling
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

### TN5250 Command Session
- `ibmi.tn5250.connect`
- `ibmi.tn5250.readScreen`
- `ibmi.tn5250.setField`
- `ibmi.tn5250.sendKeys`
- `ibmi.tn5250.waitFor`
- `ibmi.tn5250.snapshot`
- `ibmi.tn5250.disconnect`

## 3) High-Value Behaviors Users Often Miss

### 3.1 Guarded Approvals
- Many destructive/risky tools accept `approve=true`.
- In guarded policy, write operations may be blocked until approved.

### 3.2 Audit Data Lifecycle
- Verify chain integrity with `ibmi.audit.verify`.
- Export evidence using `ibmi.audit.export` (`jsonl`, `json`, `csv`).
- Use `ibmi.audit.purge` for retention cleanup (`dryRun` supported).

### 3.3 Journaling and QAUDJRN
- PF and IFS journaling lifecycle operations are supported.
- `ibmi.journal.entries.query` supports advanced filters (`journalCode`, `entryType`, `userName`, `jobName`, `programName`).
- `ibmi.qaudjrn.events.query` provides normalized QAUDJRN security/compliance event access.

### 3.4 Compliance Report Bundles
- `ibmi.compliance.report.generate` can return in-memory report payload or write to `outputPath`.
- Optional signing creates:
  - `<outputPath>.sig`
  - `<outputPath>.sha256`

## 4) Useful Local Paths and Env Knobs

### 4.1 Config and Audit Storage
- Config base directory: from local MCP-for-i config store (`~/.mcp-for-i` on typical setups).
- Default audit log path:
  - `<configDir>/audit/tool-audit.jsonl`

### 4.2 Audit Environment Variables
- `MCP_FOR_I_AUDIT_ENABLED=0` disables audit append.
- `MCP_FOR_I_AUDIT_LOG_PATH=<path>` overrides default audit file location.

### 4.3 Logging Environment Variables
- `MCP_FOR_I_LOG_ENABLED`
- `MCP_FOR_I_LOG_LEVEL`
- `MCP_FOR_I_LOG`
- `MCP_FOR_I_LOG_STDERR`

## 5) Current Scope Boundary

Implemented through Phase 7.  
Next roadmap items begin at Phase 8 (reliability/recovery/change assurance), then autonomy/distribution phases.
