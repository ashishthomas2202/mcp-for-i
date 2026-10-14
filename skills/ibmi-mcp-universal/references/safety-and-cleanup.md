# Safety and Cleanup

## Guardrails
- Use read-first workflow before write operations.
- Treat all destructive tools as guarded operations.
- Expect the user to confirm guarded operations; a declined confirmation means stop, not retry.
- Avoid production object edits unless explicitly requested.
- Keep task scope narrow: one library/path/object set per task.

## Temporary Naming Convention
- Library: `MCPQ<5digits>`
- IFS base: `/tmp/mcp-for-i-<timestamp>`
- Profiles/filters/actions: prefix with task library or request id.

## Verification Pattern
1. Execute write.
2. Re-read affected resource with read tool.
3. Confirm expected state.
4. Record evidence payload.

## Cleanup Order
1. Temporary actions/filters/profiles/shortcuts.
2. Temporary members/files.
3. Temporary source files and libraries.
4. Temporary IFS paths.
5. Disconnect session.

## Cleanup Commands (Common)
- `ibmi.ifs.delete` with `recursive: true`.
- `ibmi.qsys.members.delete`.
- `ibmi.cl.run` for `DLTF` and `DLTLIB` when direct delete tools are not sufficient.
- `ibmi.disconnect`.

## Evidence Best Practices
- Save exact error text.
- Save operation response payloads for key writes.
- Export audit/compliance artifacts for regulated tasks.
