# IBM i MCP Skills (Unified Runbook)

This is a single portable runbook for coding agents using `mcp-for-i`.
Goal: execute IBM i work with minimal guesswork, minimal retries, and predictable safety.

## 1) Operating Model

### 1.1 Task Levels
- `L0 Read-Only`: inspect/list/query only.
- `L1 Scoped Write`: write in owned temp scope (`MCPQxxxxx`, `/tmp/...`).
- `L2 Shared Write`: write in shared non-prod libraries/paths.
- `L3 Production-Risk`: subsystem/job/end/delete/move/security or prod object changes.

Default to lowest level that can complete the task.

### 1.2 Approval Rule
- Under the guarded policy the user confirms write/destructive operations in the MCP client; you cannot approve them yourself.
- `approve: true` only counts when the connection's `approvalMode` is `"agent"`.
- If the user declines, stop and ask what they want instead. Do not retry or route around the policy.

### 1.3 Verification Tiers (Avoid Over-Testing)
- `Tier A` (default): pre-check + one post-check on touched objects only.
- `Tier B` (high risk): Tier A + dependent surface check (joblog/spool/msgq/audit).
- `Tier C` (full regression): only when user requests full validation or after infrastructure change.

Do not run full E2E every task. Use `Tier A` by default.

## 2) Deterministic Defaults

- Temporary library: `MCPQ<5digits>`
- Temporary IFS path: `/tmp/mcp-for-i-<yyyymmddhhmmss>`
- Always include explicit `connectionName` after connect.
- Prefer typed tools first; use `ibmi.cl.run` only for operations not covered by typed tools.

## 3) Session Boot Sequence

Run once per task:
1. `ibmi.connections.list`
2. `ibmi.connect`
3. `ibmi.session.status`
4. Optional `ibmi.libl.get` and `ibmi.libl.set` (if compile/object resolution is task-critical)

Example:
```json
{"tool":"ibmi.connect","arguments":{"name":"Prism PCR image"}}
{"tool":"ibmi.session.status","arguments":{"connectionName":"Prism PCR image"}}
```

If session drops:
1. reconnect
2. status check
3. retry failed call once

## 4) IBM i Navigation Algorithm (No Guessing)

When target is unclear, resolve in this exact order:
1. If library unknown: `ibmi.qsys.libraries.list` (with filter if available).
2. If source file unknown: `ibmi.qsys.sourcefiles.list`; fallback `ibmi.qsys.objects.list` type `*FILE`.
3. If member unknown: `ibmi.qsys.members.list`.
4. Confirm precise object/member path with `ibmi.resolve.path`.
5. Only then read/write/rename/delete.

For IFS targets:
1. `ibmi.resolve.path` (if known path)
2. `ibmi.ifs.list` parent
3. `ibmi.search.ifs` / `ibmi.find.ifs` for discovery
4. then write/upload/sync

## 5) Task Playbooks

### 5.1 Edit a Source Member Safely
1. Pre-check: list/resolve library, source file, member.
2. Read current member (`ibmi.qsys.members.read`) and preserve baseline in report.
3. Write updated source (`ibmi.qsys.members.write` with `approve: true`).
4. Verify by re-reading member and (optional) searching for expected marker text.
5. If compile requested, run compile CL via `ibmi.cl.run`, then inspect `ibmi.joblog.get`.
6. Post-check Tier A complete.

### 5.2 Create New Object in Temp Scope
1. Create temp library/source file/member.
2. Write content.
3. Resolve path + read back.
4. Return exact created names and cleanup plan.

### 5.3 IFS Change / Deploy
1. `ibmi.ifs.mkdir` temp or target path.
2. Use `ibmi.deploy.compare` first.
3. Run `ibmi.deploy.sync` with `dryRun: true`.
4. Apply real sync only if dry run is expected.
5. Verify with `ibmi.ifs.list` or `ibmi.ifs.read`.

### 5.4 SQL + CL Operation
1. Use `ibmi.sql.query` for read probes.
2. Use `ibmi.sql.execute` for writes with `approve: true`.
3. For CL, use `ibmi.cl.run` with explicit command and timeout.
4. Validate side effects with one read tool on affected surface.

### 5.5 Operations Control (Jobs/Spool/Subsystems/Queues)
1. Read current state first (`jobs.list`, `spool.list`, `subsystems.list`, `msgq.read`).
2. Apply single minimal control action.
3. Re-read same surface to confirm state transition.
4. Capture command response and any CPF/SQL code.

### 5.6 Audit/Journaling/Compliance
1. `ibmi.audit.verify`
2. query event surfaces (`audit.list`, `journal.entries.query`, `qaudjrn.events.query`)
3. export/report (`audit.export`, `compliance.report.generate`)
4. for retention, run `dryRun` first, then approved execution

## 6) Tool Selection Rules

- Use typed tool when it exists (`ibmi.qsys.members.write`) instead of raw CL.
- Use `ibmi.cl.run` for:
  - commands without typed tool coverage
  - targeted cleanup (`DLTF`, `DLTLIB`) when needed
  - known operational CL actions
- Use `ibmi.resolve.path` before destructive actions on ambiguous targets.

## 7) Error Handling Matrix

### 7.1 Guarded Policy
Errors:
- `was not confirmed by the user`: stop, tell the user what you were trying to do, and ask how to proceed.
- `cannot show confirmation prompts`: tell the user the client can't confirm guarded operations; they can use a client with MCP elicitation or set `approvalMode: "agent"` in config.json.
- `requires approve=true under 'guarded' policy` (only with `approvalMode: "agent"`): rerun with `approve: true` if the user asked for the change.
Action:
- do not bypass via alternate command patterns

### 7.2 Object Listing Compatibility
Errors:
- `OBJTYPELIST ARGUMENT NOT VALID (42616)`
- `FILE_STATUS not found (42703)`
Action:
1. rely on tool fallback behavior
2. if still failing, restart stale MCP process and retry once
3. record host/version context

### 7.3 Authority Failures
Action:
1. verify authority with read tools or object authority tool
2. switch to owned temp scope for implementation proof
3. do not repeatedly retry same unauthorized operation

### 7.4 Transport/Session Failures
Action:
1. reconnect
2. session status check
3. single retry
4. if repeat, stop and report infrastructure issue

## 8) What Not To Do

- Do not run full tool validation suites for routine task edits.
- Do not run destructive controls without explicit target confirmation.
- Do not modify production scope when user asked for exploratory/debug work.
- Do not loop retries on same error without changing approach.

## 9) Cleanup Protocol

Cleanup in this order:
1. temp actions/filters/profiles/shortcuts
2. temp members/files
3. temp source files/libraries
4. temp IFS paths
5. disconnect

Typical cleanup calls:
- `ibmi.ifs.delete` (`recursive: true`)
- `ibmi.qsys.members.delete`
- `ibmi.cl.run` (`DLTF`, `DLTLIB`)
- `ibmi.disconnect`

## 10) Output Contract (Required)

For each task completion, return:
1. `Changes`: what was changed (or no-change).
2. `Verification`: exact read-back evidence used.
3. `Cleanup`: what was removed and what was retained.
4. `Issues`: remaining errors/risks and next needed action.

## 11) Universal Prompt Template

```text
Goal: <single objective>
Connection: <saved connection name>
Scope: <library/path/object>
Risk level: <L0/L1/L2/L3>
Verification tier: <Tier A/B/C>
Constraints: guarded policy, approve writes, no broad regression tests
Deliverable: changes + evidence + cleanup + issues
```
