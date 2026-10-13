# Agent Execution Contract

Use this format in any coding agent (Codex, Claude, Cursor agents, etc.).

## 1) Request Envelope
- Keep one goal per run.
- Explicitly set:
  - `connectionName`
  - target scope (library/path/object)
  - whether writes are expected
  - cleanup requirements

Template:
```text
Goal: <what to achieve>
Connection: <saved connection name>
Write scope: <library/path/object>
Constraints: guarded policy, approval required for writes
Verification: <which read tools confirm success>
Cleanup: <what must be removed>
```

## 2) Tool Invocation Style
- Call one preflight read before first write.
- Guarded writes wait for the user to confirm them; `approve: true` only counts with `approvalMode: "agent"`.
- Prefer structured identifiers (`library`, `sourceFile`, `member`) over raw CL when dedicated tools exist.

## 3) Response Parsing
Expect either shape:
- Wrapped: `{ "ok": true|false, "data": ... }`
- Plain text/JSON payload from tool content

Rule:
1. If `ok === false`, treat as failure.
2. If text contains known IBM i error id/code, capture exact message.
3. Re-verify with a read tool after successful writes.

## 4) Retry Discipline
- Retry once for transient session/transport issues after reconnect.
- Do not loop on same error class.
- If error repeats, switch to fallback from `error-recovery.md`.

## 5) End-of-Task Report
Always provide:
1. What changed.
2. Verification evidence.
3. Cleanup performed.
4. Remaining risks/open items.
