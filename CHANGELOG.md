# Changelog

## 0.4.0

- New `approvalMode: "host"` for MCP clients that run their own approval layer. Routine guarded operations run without a prompt and without `approve`. Critical ones still ask the person every time, with an empty form: operations in the new `alwaysConfirm` list, CL commands in `confirmClCommands`, SQL statements in `confirmSqlVerbs`, and, when `trustedLibraries` is set, writes to any other library or to a library that cannot be determined. All other policy checks still apply. `"prompt"` stays the default, and `"prompt"` and `"agent"` behave as before.
- Delete, rename, move and end tools have their own operation names (`members.delete`, `members.rename`, `objects.delete`, `objects.move`, `objects.rename`, `jobs.end`, `subsystems.end`, `spool.delete`, `spool.move`, `journal.end`, `debug.end`, `dataqueue.remove`). `requireApprovalFor` and the prompt text still know them as `qsys.write`.
- Every confirmation prompt carries `_meta` (`mcp-for-i/operation`, `mcp-for-i/tool`, `mcp-for-i/connection`, `mcp-for-i/libraries`, `mcp-for-i/critical`, `mcp-for-i/reason`).
- Audit records carry `approvedBy` (`"host"` or `"person"`) in host mode, and the CSV export has an `approvedBy` column.
- The control plane refuses invalid policies, and saving a connection in the web UI no longer drops policy settings it does not show (such as `approvalMode`).
- The `approve` parameter descriptions say it is ignored in host mode.

## 0.3.1

- Fix `ibmi.cl.run` in the ILE environment on Mapepire connections failing with "query.execute is not a function" under `@ibm/mapepire-js` 1.1.0, where `SQLJob.clcommand` returns the result instead of a query. Both library shapes are handled, and job log messages are read from both the 1.1.0 (`id`, `type`, `text`) and the older (`MESSAGE_ID`, `MESSAGE_TYPE`, `MESSAGE_TEXT`) field names.
- `ibmi.spool.read` and compile listings fall back to `SYSTOOLS.SPOOLED_FILE_DATA` when `QSYS2.DISPLAY_SPOOLED_FILE_DATA` does not exist on the system (SQLSTATE 42704 or 42884).
- `ibmi.cl.run` in the qsh environment now sets the connection's current library and library list in the same job before the command, so compiles resolve `/COPY` members and other `*LIBL` lookups the way the connection says.
