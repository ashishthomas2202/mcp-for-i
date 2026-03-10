---
name: ibmi-mcp-operations
description: Use when working with IBM i through mcp-for-i to connect, create filters, resolve members (including dotted names), copy source safely, compile RPGLE or SQLRPGLE, diagnose build failures, and call exported procedures.
---

# IBM i MCP Operations

## Overview
Use this skill for repeatable IBM i workflows that should avoid trial-and-error: connection setup, source discovery, compile strategy, and procedure invocation.

## Sample Situations
- Compile a copied source member in your own library without touching the original.
- Build a filter for a specific library and source type.
- Diagnose why SQLRPGLE compile fails after copy.
- Call procedures exported from a service program.

## Workflow
1. Establish clean session context.
2. Resolve the exact object or member path.
3. Verify source type before compiling.
4. Compile with the correct object target (`*PGM`, `*MODULE`, or `*SRVPGM`).
5. Invoke exported procedures with a compatible wrapper if needed.

## 1) Session Context
- Reconnect explicitly before changes.
- Set library list and current library before compile attempts.
- Prefer saved connection names so filters and settings apply to the right profile.

Tool pattern:
```json
{"tool":"ibmi.connect","arguments":{"name":"<saved-connection-name>"}}
{"tool":"ibmi.libl.set","arguments":{"connectionName":"<saved-connection-name>","libraryList":["<target>","<deps>","QGPL"],"currentLibrary":"<target>","applyToJob":true}}
```

## 2) Resolve Members Reliably
- Do not assume member names from display labels.
- For dotted names (`J.PRODUCTS`), verify by IFS path:
`/QSYS.LIB/<LIB>.LIB/<SRCFILE>.FILE/<MEMBER>.MBR`.
- If member-list/search APIs are empty or timing out, use direct path resolution first.

Tool pattern:
```json
{"tool":"ibmi.resolve.path","arguments":{"path":"/QSYS.LIB/<LIB>.LIB/<SRCFILE>.FILE/<MEMBER>.MBR"}}
```

## 3) Create Useful Filters
- Use one filter per library and source type.
- Set `memberType` to the real source type (`RPGLE`, `SQLRPGLE`, etc), not a guess.

Tool pattern:
```json
{
  "tool":"ibmi.filters.save",
  "arguments":{
    "connectionName":"<saved-connection-name>",
    "filter":{
      "name":"<LIB> SQLRPGLE",
      "filterType":"simple",
      "library":"<LIB>",
      "object":"QRPGLESRC",
      "types":["*FILE"],
      "member":"*",
      "memberType":"SQLRPGLE"
    }
  }
}
```

## 4) Copy Without Touching Original
- Keep source unchanged in origin library.
- For dotted member names, `CPYSRCF` may reject member names.
- Use QSYS path copy as fallback:
`cp /QSYS.LIB/<FROM>.LIB/<SRC>.FILE/<MEMBER>.MBR /QSYS.LIB/<TO>.LIB/<SRC>.FILE/<MEMBER>.MBR`
- After copy, verify source type. If missing, set it with `CHGPFM ... SRCTYPE(...)`.

## 5) Compile Decision Rules
- First read source intent:
  - If `CTL-OPT NOMAIN` exists, do not expect `*PGM` output from that module alone.
- Detect source type before compile:
  - Query `QSYS2.SYSPARTITIONSTAT` for `SOURCE_TYPE`.

Compile map:
1. `RPGLE` with main procedure:
   - `CRTBNDRPG` to `*PGM`
2. `RPGLE` or `SQLRPGLE` with `NOMAIN`:
   - Compile to `*MODULE`
   - Create `*SRVPGM` from module
3. `SQLRPGLE`:
   - Use `CRTSQLRPGI`
   - For nested `/COPY`, use `RPGPPOPT(*LVL2)` when required

## 6) Diagnose Failures Fast
- Authority failures:
  - If not authorized to target library, compile to `QTEMP` or your own library.
- `*LIBL` lookup failures for external files:
  - Add dependency libraries to `LIBL`.
  - Use `QSYS2.SYSTABLES` and `QSYS2.SYSROUTINES` to discover where missing objects live.
- Binding failures after module compile:
  - Verify bind directory or bound service programs are reachable on `LIBL`.
- Avoid repeating full compile loops before fixing the first concrete missing dependency.

## 7) Calling Exported Procedures
- List exported procedures with `DSPSRVPGM DETAIL(*PROCEXP)`.
- Router-style procedures may need runtime context and can return empty in direct SQL tests.
- For SQL wrapper tests:
  - Create external function wrappers with practical parameter sizes (for example `VARCHAR(32000)`).
  - Use matching `EXTERNAL NAME '<LIB>/<SRVPGM>(<PROC>)'`.

## Guardrails
- Never include or persist credentials in skill content or logs.
- Never edit production source until path, type, and dependency checks pass.
- Prefer one diagnostic change at a time and re-test.
- Record the exact failing message and fix that class of issue before the next compile attempt.
