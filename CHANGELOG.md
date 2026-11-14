# Changelog

## 0.3.1

- Fix `ibmi.cl.run` in the ILE environment on Mapepire connections failing with "query.execute is not a function" under `@ibm/mapepire-js` 1.1.0, where `SQLJob.clcommand` returns the result instead of a query. Both library shapes are handled, and job log messages are read from both the 1.1.0 (`id`, `type`, `text`) and the older (`MESSAGE_ID`, `MESSAGE_TYPE`, `MESSAGE_TEXT`) field names.
- `ibmi.spool.read` and compile listings fall back to `SYSTOOLS.SPOOLED_FILE_DATA` when `QSYS2.DISPLAY_SPOOLED_FILE_DATA` does not exist on the system (SQLSTATE 42704 or 42884).
- `ibmi.cl.run` in the qsh environment now sets the connection's current library and library list in the same job before the command, so compiles resolve `/COPY` members and other `*LIBL` lookups the way the connection says.
