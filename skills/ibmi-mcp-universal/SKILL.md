---
name: ibmi-mcp-universal
description: Universal IBM i operations skill pack for any coding agent that uses mcp-for-i MCP tools. Use when an agent needs to connect, inspect, edit source members, run SQL/CL, manage IFS/QSYS objects, perform deploy/diagnostics/operations control, and complete safe cleanup with guarded approvals.
---

# IBM i MCP Universal Operations

Run IBM i work through deterministic, tool-first workflows that work across coding agents.

## Quick Start
1. Connect and verify session.
2. Pick a scoped workspace (temporary library and IFS path).
3. Run only the playbook needed for the task.
4. Verify outcomes with read tools.
5. Cleanup temporary resources and disconnect.

Read these references as needed:
- `references/tool-groups.md`: Tool map by job type.
- `references/playbooks.md`: End-to-end task flows with call order.
- `references/error-recovery.md`: Common IBM i/MCP failures and fixes.
- `references/safety-and-cleanup.md`: Guardrails, approvals, cleanup.
- `references/agent-execution-contract.md`: Portable calling/result conventions for any coding agent.

## Core Rules
- Prefer explicit `connectionName` in calls after connecting.
- Assume guarded policy by default: the user confirms write/destructive operations in their client. If they decline, stop and ask; never retry around it.
- Use read/verify before write whenever possible.
- Use unique temporary names (`MCPQ<5digits>`, `/tmp/mcp-for-i-<timestamp>`).
- Capture exact error text and fix that class of issue before retrying.

## Minimal Preflight Sequence
```json
{"tool":"ibmi.connections.list","arguments":{}}
{"tool":"ibmi.connect","arguments":{"name":"Prism PCR image"}}
{"tool":"ibmi.session.status","arguments":{"connectionName":"Prism PCR image"}}
```

## Completion Checklist
- Required task outputs verified with read tools.
- Temporary libraries/files/profiles/filters/shortcuts removed.
- Session disconnected when task is complete.
