import crypto from "crypto";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { Tools } from "../../ibmi/Tools.js";
import {
  clampInteger,
  json,
  pickFirst,
  requireIfsPath,
  requireObjectTypeValue,
  requireQsysName,
  toolError
} from "../tools.js";

/*
 * Read-only inspection of objects, members, IFS files, programs, tables and
 * SQL routines. Every query is capped with FETCH FIRST and every name is
 * validated and upper-cased before it reaches SQL or CL.
 *
 * Release notes (verify on the target system):
 * - QSYS2.OBJECT_STATISTICS: 7.3+. The third OBJECT_NAME argument is newer;
 *   when it is rejected the query falls back to filtering on OBJNAME.
 * - QSYS2.IFS_OBJECT_STATISTICS: 7.3 TR7 / 7.4 TR1 and later. Older systems
 *   fall back to `ls -ldL` (no CCSID).
 * - QSYS2.PROGRAM_INFO, PROGRAM_EXPORT_IMPORT_INFO, BOUND_MODULE_INFO and
 *   BOUND_SRVPGM_INFO: added by Db2 PTF groups on 7.3/7.4; each part is
 *   optional and reported as a warning when the service is missing.
 */

const OBJECT_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CONNECTION_NAME = { type: "string", description: "Saved IBM i connection name." };
const LIMIT = (fallback: number, max: number) => ({ type: "number", description: `Maximum rows per list (default ${fallback}, max ${max}).` });
const PROGRAM_TYPES = ["*PGM", "*SRVPGM"];
const PGMREF_TYPES = ["*ALL", "*PGM", "*SRVPGM", "*MODULE", "*SQLPKG", "*QRYDFN"];

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.objects.describe",
    description:
      "Describe an object from QSYS2.OBJECT_STATISTICS: type, attribute, owner, size, text, created/changed/last-used dates, " +
      "save/restore dates and, when the system records it, the source file/member it was created from.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: "Library name." },
        object: { type: "string", description: "Object name." },
        objectType: { type: "string", description: "Object type such as *PGM or *FILE (default *ALL: every object with that name)." },
        connectionName: CONNECTION_NAME
      },
      required: ["library", "object"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.members.describe",
    description:
      "Describe a member from QSYS2.SYSPARTITIONSTAT: source type, text, record count, created/changed/source-changed/last-used dates, " +
      "data size, record length and the source CCSID.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        sourceFile: { type: "string", description: "File (usually a source physical file) that holds the member." },
        member: { type: "string" },
        connectionName: CONNECTION_NAME
      },
      required: ["library", "sourceFile", "member"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.ifs.stat",
    description:
      "Describe an IFS object from QSYS2.IFS_OBJECT_STATISTICS: object type, CCSID, owner, size and created/accessed/changed dates. " +
      "Falls back to `ls -ldL` on releases without that service.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute IFS path." },
        connectionName: CONNECTION_NAME
      },
      required: ["path"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.programs.info",
    description:
      "Describe a *PGM or *SRVPGM from QSYS2.PROGRAM_INFO (program type, activation group, owner/adopted authority, source location, " +
      "target release), with its bound modules (BOUND_MODULE_INFO), bound service programs (BOUND_SRVPGM_INFO) and exports/imports " +
      "(PROGRAM_EXPORT_IMPORT_INFO). For a service program it also generates binder source from the exports.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        program: { type: "string" },
        objectType: { type: "string", enum: PROGRAM_TYPES, description: "Required only when a *PGM and a *SRVPGM share the name." },
        includeModules: { type: "boolean", description: "Include bound modules (default true)." },
        includeServicePrograms: { type: "boolean", description: "Include bound service programs (default true)." },
        includeExports: { type: "boolean", description: "Include exports, imports and binder source (default true)." },
        limit: LIMIT(500, 5000),
        connectionName: CONNECTION_NAME
      },
      required: ["library", "program"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.objects.whereUsed",
    description:
      "Program cross-reference from DSPPGMREF (written to a temporary QTEMP outfile in the same SQL job). " +
      "direction=uses lists the objects a program references; direction=usedBy scans every program, service program and module " +
      "in a library and lists the ones that reference a given object.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["uses", "usedBy"] },
        library: { type: "string", description: "uses: library of the program. usedBy: library whose programs are scanned." },
        program: { type: "string", description: "uses: program, service program or module name." },
        programType: { type: "string", enum: PGMREF_TYPES, description: "uses: object type of the program (default *ALL)." },
        object: { type: "string", description: "usedBy: name of the referenced object." },
        objectLibrary: { type: "string", description: "usedBy: library of the referenced object; references through *LIBL also match." },
        objectType: { type: "string", description: "usedBy: only references of this object type, such as *FILE or *PGM." },
        limit: LIMIT(1000, 10000),
        connectionName: CONNECTION_NAME
      },
      required: ["direction", "library"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.tables.describe",
    description:
      "Describe a table, view or physical file: columns from QSYS2.SYSCOLUMNS, constraints with their key columns from " +
      "QSYS2.SYSCST/SYSKEYCST, and SQL indexes with their keys from QSYS2.SYSINDEXES/SYSKEYS. Accepts system or SQL names.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: "Library (system name) or SQL schema." },
        table: { type: "string", description: "System name or SQL name of the table, view or file." },
        includeKeys: { type: "boolean", description: "Include constraints and their key columns (default true)." },
        includeIndexes: { type: "boolean", description: "Include SQL indexes over the table (default true)." },
        limit: LIMIT(1000, 8000),
        connectionName: CONNECTION_NAME
      },
      required: ["library", "table"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  },
  {
    name: "ibmi.routines.describe",
    description:
      "Describe SQL procedures and functions from QSYS2.SYSROUTINES with their parameters from QSYS2.SYSPARMS, " +
      "including a readable signature for every overload.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: "Routine schema." },
        routine: { type: "string", description: "Routine name or specific name." },
        routineType: { type: "string", enum: ["PROCEDURE", "FUNCTION"] },
        includeDefinition: { type: "boolean", description: "Include the routine body text for SQL routines (default false, capped at 64 KB)." },
        limit: LIMIT(50, 500),
        connectionName: CONNECTION_NAME
      },
      required: ["library", "routine"],
      additionalProperties: false
    },
    annotations: OBJECT_ANNOTATIONS
  }
];

async function handle(ctx: McpContext, name: string, args: any) {
  const conn: any = await ctx.ensureActive(args?.connectionName);
  switch (name) {
    case "ibmi.objects.describe": return describeObject(conn, args);
    case "ibmi.members.describe": return describeMember(conn, args);
    case "ibmi.ifs.stat": return statIfs(conn, args);
    case "ibmi.programs.info": return programInfo(conn, args);
    case "ibmi.objects.whereUsed": return whereUsed(conn, args);
    case "ibmi.tables.describe": return describeTable(conn, args);
    case "ibmi.routines.describe": return describeRoutine(conn, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- objects.describe ----

async function describeObject(conn: any, args: any) {
  const library = requireQsysName(conn, args?.library, "library");
  const object = requireQsysName(conn, args?.object, "object");
  const objectType = args?.objectType ? requireObjectTypeValue(args.objectType, "objectType") : "*ALL";
  const lib = Tools.sqlString(library);
  const types = Tools.sqlString(objectType);
  const obj = Tools.sqlString(object);
  let rows: Record<string, unknown>[];
  try {
    rows = await conn.runSQL(`select * from table(QSYS2.OBJECT_STATISTICS(${lib}, ${types}, ${obj})) X fetch first 50 rows only`);
  } catch {
    // Releases without the OBJECT_NAME argument: filter the library listing instead.
    rows = await conn.runSQL(`select * from table(QSYS2.OBJECT_STATISTICS(${lib}, ${types})) X where X.OBJNAME = ${obj} fetch first 50 rows only`);
  }
  if (rows.length === 0) {
    return toolError(`Object ${library}/${object} ${objectType} not found`, { library, object, objectType });
  }
  return json({ library, object, objectType, objects: rows.map(shapeObjectRow) });
}

export function shapeObjectRow(row: Record<string, unknown>) {
  return compact({
    library: str(row, "OBJLIB", "OBJECT_SCHEMA"),
    name: str(row, "OBJNAME"),
    type: str(row, "OBJTYPE"),
    attribute: str(row, "OBJATTRIBUTE"),
    text: str(row, "OBJTEXT"),
    owner: str(row, "OBJOWNER"),
    definer: str(row, "OBJDEFINER"),
    size: num(row, "OBJSIZE"),
    created: str(row, "OBJCREATED"),
    changed: str(row, "CHANGE_TIMESTAMP"),
    lastUsed: str(row, "LAST_USED_TIMESTAMP"),
    daysUsed: num(row, "DAYS_USED_COUNT"),
    saved: str(row, "SAVE_TIMESTAMP"),
    restored: str(row, "RESTORE_TIMESTAMP"),
    source: compactOrUndefined({
      library: str(row, "SOURCE_LIBRARY"),
      file: str(row, "SOURCE_FILE"),
      member: str(row, "SOURCE_MEMBER"),
      changed: str(row, "SOURCE_TIMESTAMP")
    }),
    sqlObjectType: str(row, "SQL_OBJECT_TYPE"),
    longName: str(row, "OBJLONGNAME"),
    domain: str(row, "OBJECT_DOMAIN"),
    createdSystem: str(row, "CREATED_SYSTEM"),
    createdSystemVersion: str(row, "CREATED_SYSTEM_VERSION"),
    licensedProgram: str(row, "LICENSED_PROGRAM"),
    journaled: str(row, "JOURNALED"),
    attributes: allColumns(row)
  });
}

// ---- members.describe ----

async function describeMember(conn: any, args: any) {
  const library = requireQsysName(conn, args?.library, "library");
  const sourceFile = requireQsysName(conn, args?.sourceFile, "sourceFile");
  const member = requireQsysName(conn, args?.member, "member");
  const rows = await conn.runSQL(
    `select P.*, T.ROW_LENGTH as FILE_RECORD_LENGTH, T.TABLE_TEXT as FILE_TEXT, ` +
    `(select C.CCSID from QSYS2.SYSCOLUMNS C where C.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA ` +
    `and C.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME and C.SYSTEM_COLUMN_NAME = 'SRCDTA' fetch first 1 row only) as SOURCE_CCSID ` +
    `from QSYS2.SYSPARTITIONSTAT P left join QSYS2.SYSTABLES T ` +
    `on T.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA and T.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME ` +
    `where P.SYSTEM_TABLE_SCHEMA = ${Tools.sqlString(library)} and P.SYSTEM_TABLE_NAME = ${Tools.sqlString(sourceFile)} ` +
    `and P.SYSTEM_TABLE_MEMBER = ${Tools.sqlString(member)} fetch first 1 row only`
  );
  const row = rows[0];
  if (!row) return toolError(`Member ${library}/${sourceFile}(${member}) not found`, { library, sourceFile, member });
  return json(compact({
    library,
    sourceFile,
    member: str(row, "SYSTEM_TABLE_MEMBER") || member,
    type: str(row, "SOURCE_TYPE"),
    text: str(row, "PARTITION_TEXT"),
    records: num(row, "NUMBER_ROWS"),
    deletedRecords: num(row, "NUMBER_DELETED_ROWS"),
    dataSize: num(row, "DATA_SIZE"),
    recordLength: num(row, "FILE_RECORD_LENGTH"),
    ccsid: num(row, "SOURCE_CCSID"),
    created: str(row, "CREATE_TIMESTAMP"),
    changed: str(row, "LAST_CHANGE_TIMESTAMP"),
    sourceChanged: str(row, "LAST_SOURCE_UPDATE_TIMESTAMP"),
    lastUsed: str(row, "LAST_USED_TIMESTAMP"),
    daysUsed: num(row, "DAYS_USED_COUNT"),
    saved: str(row, "LAST_SAVE_TIMESTAMP"),
    restored: str(row, "LAST_RESTORE_TIMESTAMP"),
    fileText: str(row, "FILE_TEXT")
  }));
}

// ---- ifs.stat ----

async function statIfs(conn: any, args: any) {
  let path = requireIfsPath(args?.path, "path");
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const literal = Tools.sqlString(path);
  let rows: Record<string, unknown>[] | undefined;
  let serviceError: string | undefined;
  try {
    rows = await conn.runSQL(
      `select * from table(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${literal}, SUBTREE_DIRECTORIES => 'NO')) X ` +
      `where X.PATH_NAME = ${literal} fetch first 1 row only`
    );
  } catch (error: any) {
    serviceError = String(error?.message || error);
  }
  const row = rows?.[0];
  if (row) {
    return json(compact({
      path: str(row, "PATH_NAME") || path,
      source: "QSYS2.IFS_OBJECT_STATISTICS",
      objectType: str(row, "OBJECT_TYPE"),
      symbolicLink: str(row, "SYMBOLIC_LINK"),
      ccsid: num(row, "CCSID"),
      codePage: num(row, "CODE_PAGE"),
      owner: str(row, "OBJECT_OWNER"),
      group: str(row, "PRIMARY_GROUP"),
      size: num(row, "DATA_SIZE"),
      allocatedSize: num(row, "ALLOCATED_SIZE"),
      created: str(row, "CREATE_TIMESTAMP"),
      accessed: str(row, "ACCESS_TIMESTAMP"),
      dataChanged: str(row, "DATA_CHANGE_TIMESTAMP"),
      objectChanged: str(row, "OBJECT_CHANGE_TIMESTAMP"),
      lastUsed: str(row, "LAST_USED_TIMESTAMP"),
      attributes: allColumns(row)
    }));
  }
  // Fallback for releases without IFS_OBJECT_STATISTICS (or a path it did not return).
  const res = await conn.sendCommand({ command: `ls -ldL ${Tools.escapePath(path)}` });
  if (!res || res.code !== 0) {
    return toolError(`IFS object ${path} not found`, {
      path,
      ...(serviceError ? { serviceError } : {}),
      stderr: String(res?.stderr || "").trim()
    });
  }
  const parsed = parseLsLine(String(res.stdout || ""));
  return json(compact({
    path,
    source: "ls",
    ...parsed,
    ...(serviceError ? { warnings: [`QSYS2.IFS_OBJECT_STATISTICS unavailable: ${serviceError}`] } : {})
  }));
}

function parseLsLine(output: string) {
  const line = output.trim().split(/\r?\n/)[0] || "";
  const parts = line.split(/\s+/);
  if (parts.length < 8) return { raw: line };
  const mode = parts[0];
  return {
    objectType: mode.startsWith("d") ? "*DIR" : mode.startsWith("l") ? "*SYMLNK" : "*STMF",
    permissions: mode,
    owner: parts[2],
    group: parts[3],
    size: Number(parts[4]),
    modified: parts.slice(5, 8).join(" "),
    raw: line
  };
}

// ---- programs.info ----

async function programInfo(conn: any, args: any) {
  const library = requireQsysName(conn, args?.library, "library");
  const program = requireQsysName(conn, args?.program, "program");
  const requestedType = args?.objectType ? String(args.objectType).trim().toUpperCase() : undefined;
  if (requestedType && !PROGRAM_TYPES.includes(requestedType)) throw new Error("objectType must be *PGM or *SRVPGM");
  const limit = clampInteger(args?.limit, 1, 5000, 500);
  const where = `PROGRAM_LIBRARY = ${Tools.sqlString(library)} and PROGRAM_NAME = ${Tools.sqlString(program)}`;

  const infoRows: Record<string, unknown>[] = await conn.runSQL(
    `select * from QSYS2.PROGRAM_INFO where ${where}` +
    (requestedType ? ` and OBJECT_TYPE = ${Tools.sqlString(requestedType)}` : "") +
    ` fetch first 2 rows only`
  );
  if (infoRows.length === 0) {
    return toolError(`Program ${library}/${program}${requestedType ? ` ${requestedType}` : ""} not found`, { library, program, objectType: requestedType });
  }
  if (infoRows.length > 1) {
    throw new Error(`${library}/${program} exists as both *PGM and *SRVPGM; pass objectType`);
  }
  const info = infoRows[0];
  const objectType = str(info, "OBJECT_TYPE") || requestedType || "*PGM";
  const typedWhere = `${where} and OBJECT_TYPE = ${Tools.sqlString(objectType)}`;
  const warnings: string[] = [];
  const optional = async (label: string, sql: string) => {
    try {
      return await conn.runSQL(sql) as Record<string, unknown>[];
    } catch (error: any) {
      warnings.push(`${label} unavailable: ${String(error?.message || error)}`);
      return undefined;
    }
  };

  const payload: Record<string, unknown> = { library, program, objectType, ...shapeProgramInfo(info) };

  if (args?.includeModules !== false) {
    const rows = await optional("QSYS2.BOUND_MODULE_INFO",
      `select * from QSYS2.BOUND_MODULE_INFO where ${typedWhere} fetch first ${limit} rows only`);
    if (rows) payload.modules = rows.map(shapeModuleRow);
  }
  if (args?.includeServicePrograms !== false) {
    const rows = await optional("QSYS2.BOUND_SRVPGM_INFO",
      `select * from QSYS2.BOUND_SRVPGM_INFO where ${typedWhere} fetch first ${limit} rows only`);
    if (rows) payload.servicePrograms = rows.map(row => compact({
      library: str(row, "BOUND_SERVICE_PROGRAM_LIBRARY"),
      name: str(row, "BOUND_SERVICE_PROGRAM"),
      signature: str(row, "BOUND_SERVICE_PROGRAM_SIGNATURE"),
      activation: str(row, "BOUND_SERVICE_PROGRAM_ACTIVATION")
    }));
  }
  if (args?.includeExports !== false) {
    const rows = await optional("QSYS2.PROGRAM_EXPORT_IMPORT_INFO",
      `select * from QSYS2.PROGRAM_EXPORT_IMPORT_INFO where ${typedWhere} fetch first ${limit} rows only`);
    if (rows) {
      const symbols = rows.map(row => compact({
        symbol: str(row, "SYMBOL_NAME"),
        usage: str(row, "SYMBOL_USAGE"),
        argumentOptimization: str(row, "ARGUMENT_OPTIMIZATION"),
        dataItemSize: num(row, "DATA_ITEM_SIZE")
      })) as Array<{ symbol?: string; usage?: string }>;
      const exports = symbols.filter(item => /EXP/.test(String(item.usage || "")));
      const imports = symbols.filter(item => /IMP/.test(String(item.usage || "")));
      payload.exports = exports;
      payload.imports = imports;
      if (rows.length >= limit) warnings.push(`Exports/imports truncated at ${limit} rows; raise limit.`);
      if (objectType === "*SRVPGM") payload.binderSource = buildBinderSource(library, program, exports);
    }
  }
  if (warnings.length > 0) payload.warnings = warnings;
  return json(payload);
}

function shapeProgramInfo(row: Record<string, unknown>) {
  return compact({
    programType: str(row, "PROGRAM_TYPE"),
    attribute: str(row, "PROGRAM_ATTRIBUTE"),
    text: str(row, "TEXT_DESCRIPTION"),
    owner: str(row, "PROGRAM_OWNER"),
    created: str(row, "CREATE_TIMESTAMP"),
    activationGroup: str(row, "ACTIVATION_GROUP"),
    userProfile: str(row, "USER_PROFILE"),
    useAdoptedAuthority: str(row, "USE_ADOPTED_AUTHORITY"),
    state: str(row, "PROGRAM_STATE"),
    domain: str(row, "PROGRAM_DOMAIN"),
    targetRelease: str(row, "TARGET_RELEASE"),
    source: compactOrUndefined({
      library: str(row, "SOURCE_FILE_LIBRARY"),
      file: str(row, "SOURCE_FILE"),
      member: str(row, "SOURCE_FILE_MEMBER"),
      changed: str(row, "SOURCE_FILE_CHANGE_TIMESTAMP")
    }),
    entryModule: compactOrUndefined({
      library: str(row, "PROGRAM_ENTRY_PROCEDURE_MODULE_LIBRARY"),
      name: str(row, "PROGRAM_ENTRY_PROCEDURE_MODULE")
    }),
    counts: compactOrUndefined({
      modules: num(row, "MODULES"),
      servicePrograms: num(row, "SERVICE_PROGRAMS"),
      procedureExports: num(row, "PROCEDURE_EXPORTS"),
      dataExports: num(row, "DATA_EXPORTS")
    }),
    attributes: allColumns(row)
  });
}

function shapeModuleRow(row: Record<string, unknown>) {
  return compact({
    library: str(row, "BOUND_MODULE_LIBRARY"),
    name: str(row, "BOUND_MODULE"),
    attribute: str(row, "MODULE_ATTRIBUTE"),
    created: str(row, "MODULE_CREATE_TIMESTAMP"),
    source: compactOrUndefined({
      library: str(row, "SOURCE_FILE_LIBRARY"),
      file: str(row, "SOURCE_FILE"),
      member: str(row, "SOURCE_FILE_MEMBER"),
      streamFile: str(row, "SOURCE_STREAM_FILE_PATH"),
      changed: str(row, "SOURCE_CHANGE_TIMESTAMP")
    }),
    debugData: str(row, "DEBUG_DATA"),
    optimization: str(row, "OPTIMIZATION_LEVEL")
  });
}

export function buildBinderSource(library: string, program: string, exports: Array<{ symbol?: string }>) {
  const lines = [
    `/* Binder source for ${library}/${program}, generated from its current exports.          */`,
    `/* Keep the export order: appending new exports at the end preserves compatibility. */`,
    "STRPGMEXP PGMLVL(*CURRENT) SIGNATURE(*GEN)"
  ];
  const skipped: string[] = [];
  for (const item of exports) {
    const symbol = String(item.symbol || "");
    if (!symbol) continue;
    if (/["\r\n]/.test(symbol)) {
      skipped.push(symbol);
      continue;
    }
    lines.push(`  EXPORT SYMBOL("${symbol}")`);
  }
  lines.push("ENDPGMEXP");
  return {
    text: lines.join("\n"),
    exportCount: exports.length - skipped.length,
    note: "Export order is the order the system returned. Confirm it matches the existing signature (DSPSRVPGM DETAIL(*SIGNATURE)) before binding with this source.",
    ...(skipped.length > 0 ? { skipped } : {})
  };
}

// ---- objects.whereUsed ----

const FILE_USAGE_BITS: Array<[number, string]> = [[1, "input"], [2, "output"], [4, "update"], [8, "unspecified"]];

async function whereUsed(conn: any, args: any) {
  const direction = String(args?.direction || "").trim();
  if (direction !== "uses" && direction !== "usedBy") throw new Error("direction must be uses or usedBy");
  const library = requireQsysName(conn, args?.library, "library");
  const limit = clampInteger(args?.limit, 1, 10000, 1000);
  const outfile = uniqueOutfileName();

  let command: string;
  const filters: string[] = [];
  let target: Record<string, unknown>;
  if (direction === "uses") {
    const program = requireQsysName(conn, args?.program, "program");
    const programType = String(args?.programType || "*ALL").trim().toUpperCase();
    if (!PGMREF_TYPES.includes(programType)) throw new Error(`programType must be one of ${PGMREF_TYPES.join(", ")}`);
    command = `DSPPGMREF PGM(${library}/${program}) OUTPUT(*OUTFILE) OBJTYPE(${programType}) OUTFILE(QTEMP/${outfile})`;
    target = { library, program, programType };
  } else {
    const object = requireQsysName(conn, args?.object, "object");
    command = `DSPPGMREF PGM(${library}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*ALL) OUTFILE(QTEMP/${outfile})`;
    filters.push(`WHFNAM = ${Tools.sqlString(object)}`);
    target = { library, object };
    if (args?.objectLibrary) {
      const objectLibrary = requireQsysName(conn, args.objectLibrary, "objectLibrary");
      filters.push(`WHLNAM in (${Tools.sqlString(objectLibrary)}, '*LIBL')`);
      target.objectLibrary = objectLibrary;
    }
    if (args?.objectType) {
      const objectType = requireObjectTypeValue(args.objectType, "objectType");
      filters.push(`WHOTYP = ${Tools.sqlString(objectType)}`);
      target.objectType = objectType;
    }
  }

  // QTEMP belongs to the SQL job, so the CL command and the SELECT must run in
  // the same runSQL call.
  const rows: Record<string, unknown>[] = await conn.runSQL(
    `call QSYS2.QCMDEXC(${Tools.sqlString(command)});\n` +
    `select * from QTEMP.${outfile}` +
    (filters.length > 0 ? ` where ${filters.join(" and ")}` : "") +
    ` order by WHLIB, WHPNAM, WHLNAM, WHFNAM fetch first ${limit + 1} rows only`
  );
  const hasMore = rows.length > limit;
  const references = rows.slice(0, limit).map(shapeProgramReference);
  const payload: Record<string, unknown> = { direction, ...target, command, returned: references.length, hasMore, references };
  if (direction === "usedBy") {
    const programs = new Map<string, { library: string; program: string; programType?: string }>();
    for (const ref of references) {
      const key = `${ref.programLibrary}/${ref.program}/${ref.programType || ""}`;
      if (!programs.has(key)) programs.set(key, compact({ library: ref.programLibrary, program: ref.program, programType: ref.programType }) as any);
    }
    payload.programs = [...programs.values()];
  }
  return json(payload);
}

function uniqueOutfileName() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(6);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `MCPR${suffix}`;
}

// WHSPKG in the DSPPGMREF outfile (QADSPPGM) holds the referencing program's type.
const PROGRAM_TYPE_CODES: Record<string, string> = { P: "*PGM", V: "*SRVPGM", M: "*MODULE", S: "*SQLPKG", Q: "*QRYDFN" };

export function shapeProgramReference(row: Record<string, unknown>) {
  const usageCode = num(row, "WHFUSG");
  const typeCode = str(row, "WHSPKG");
  return compact({
    programLibrary: str(row, "WHLIB") || "",
    program: str(row, "WHPNAM") || "",
    programType: typeCode ? PROGRAM_TYPE_CODES[typeCode] || typeCode : undefined,
    programText: str(row, "WHTEXT"),
    objectLibrary: str(row, "WHLNAM"),
    object: str(row, "WHFNAM"),
    objectType: str(row, "WHOTYP"),
    fileUsage: usageCode !== undefined && usageCode > 0
      ? FILE_USAGE_BITS.filter(([bit]) => (usageCode & bit) !== 0).map(([, label]) => label)
      : undefined,
    recordFormat: str(row, "WHRFNM"),
    formatLevel: str(row, "WHRFSN")
  }) as { programLibrary: string; program: string; programType?: string; [key: string]: unknown };
}

// ---- tables.describe ----

async function describeTable(conn: any, args: any) {
  const library = requireSqlName(args?.library, "library");
  const table = requireSqlName(args?.table, "table");
  const limit = clampInteger(args?.limit, 1, 8000, 1000);
  const lib = Tools.sqlString(library);
  const tbl = Tools.sqlString(table);
  const tableRows: Record<string, unknown>[] = await conn.runSQL(
    `select * from QSYS2.SYSTABLES where (TABLE_SCHEMA = ${lib} or SYSTEM_TABLE_SCHEMA = ${lib}) ` +
    `and (TABLE_NAME = ${tbl} or SYSTEM_TABLE_NAME = ${tbl}) fetch first 1 row only`
  );
  const tableRow = tableRows[0];
  if (!tableRow) return toolError(`Table ${library}/${table} not found`, { library, table });
  const schema = str(tableRow, "TABLE_SCHEMA") || library;
  const name = str(tableRow, "TABLE_NAME") || table;
  const tableFilter = (alias: string) =>
    `${alias}TABLE_SCHEMA = ${Tools.sqlString(schema)} and ${alias}TABLE_NAME = ${Tools.sqlString(name)}`;

  const columnRows: Record<string, unknown>[] = await conn.runSQL(
    `select * from QSYS2.SYSCOLUMNS where ${tableFilter("")} order by ORDINAL_POSITION fetch first ${limit} rows only`
  );
  const payload: Record<string, unknown> = compact({
    schema,
    name,
    systemSchema: str(tableRow, "SYSTEM_TABLE_SCHEMA"),
    systemName: str(tableRow, "SYSTEM_TABLE_NAME"),
    tableType: str(tableRow, "TABLE_TYPE"),
    fileType: str(tableRow, "FILE_TYPE"),
    text: str(tableRow, "TABLE_TEXT"),
    rowLength: num(tableRow, "ROW_LENGTH"),
    columnCount: num(tableRow, "COLUMN_COUNT"),
    columns: columnRows.map(shapeColumnRow)
  });
  const warnings: string[] = [];

  if (args?.includeKeys !== false) {
    try {
      const rows: Record<string, unknown>[] = await conn.runSQL(
        `select C.CONSTRAINT_SCHEMA, C.CONSTRAINT_NAME, C.CONSTRAINT_TYPE, K.COLUMN_NAME, K.ORDINAL_POSITION ` +
        `from QSYS2.SYSCST C left join QSYS2.SYSKEYCST K ` +
        `on K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA and K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
        `where ${tableFilter("C.")} ` +
        `order by C.CONSTRAINT_NAME, K.ORDINAL_POSITION fetch first ${limit} rows only`
      );
      payload.constraints = groupRows(rows, row => `${str(row, "CONSTRAINT_SCHEMA")}.${str(row, "CONSTRAINT_NAME")}`, (first, group) => ({
        schema: str(first, "CONSTRAINT_SCHEMA"),
        name: str(first, "CONSTRAINT_NAME"),
        type: str(first, "CONSTRAINT_TYPE"),
        columns: group.map(row => str(row, "COLUMN_NAME")).filter(Boolean)
      }));
    } catch (error: any) {
      warnings.push(`Constraints unavailable: ${String(error?.message || error)}`);
    }
  }
  if (args?.includeIndexes !== false) {
    try {
      const rows: Record<string, unknown>[] = await conn.runSQL(
        `select I.INDEX_SCHEMA, I.INDEX_NAME, I.SYSTEM_INDEX_NAME, I.IS_UNIQUE, K.COLUMN_NAME, K.ORDINAL_POSITION, K.ORDERING ` +
        `from QSYS2.SYSINDEXES I left join QSYS2.SYSKEYS K on K.INDEX_SCHEMA = I.INDEX_SCHEMA and K.INDEX_NAME = I.INDEX_NAME ` +
        `where ${tableFilter("I.")} ` +
        `order by I.INDEX_NAME, K.ORDINAL_POSITION fetch first ${limit} rows only`
      );
      payload.indexes = groupRows(rows, row => `${str(row, "INDEX_SCHEMA")}.${str(row, "INDEX_NAME")}`, (first, group) => compact({
        schema: str(first, "INDEX_SCHEMA"),
        name: str(first, "INDEX_NAME"),
        systemName: str(first, "SYSTEM_INDEX_NAME"),
        unique: str(first, "IS_UNIQUE"),
        keys: group
          .filter(row => str(row, "COLUMN_NAME"))
          .map(row => compact({ column: str(row, "COLUMN_NAME"), ordering: str(row, "ORDERING") }))
      }));
    } catch (error: any) {
      warnings.push(`Indexes unavailable: ${String(error?.message || error)}`);
    }
  }
  if (columnRows.length >= limit) warnings.push(`Columns truncated at ${limit}; raise limit.`);
  if (warnings.length > 0) payload.warnings = warnings;
  return json(payload);
}

function shapeColumnRow(row: Record<string, unknown>) {
  const dataType = str(row, "DATA_TYPE");
  return compact({
    name: str(row, "COLUMN_NAME"),
    systemName: str(row, "SYSTEM_COLUMN_NAME"),
    position: num(row, "ORDINAL_POSITION"),
    type: formatSqlType(dataType, num(row, "LENGTH", "CHARACTER_MAXIMUM_LENGTH"), num(row, "NUMERIC_PRECISION"), num(row, "NUMERIC_SCALE")),
    dataType,
    length: num(row, "LENGTH"),
    scale: num(row, "NUMERIC_SCALE"),
    nullable: yesNo(str(row, "IS_NULLABLE")),
    default: str(row, "COLUMN_DEFAULT"),
    identity: yesNo(str(row, "IS_IDENTITY")),
    ccsid: num(row, "CCSID"),
    text: str(row, "COLUMN_TEXT"),
    heading: str(row, "COLUMN_HEADING")
  });
}

// ---- routines.describe ----

async function describeRoutine(conn: any, args: any) {
  const library = requireSqlName(args?.library, "library");
  const routine = requireSqlName(args?.routine, "routine");
  const routineType = args?.routineType ? String(args.routineType).trim().toUpperCase() : undefined;
  if (routineType && routineType !== "PROCEDURE" && routineType !== "FUNCTION") throw new Error("routineType must be PROCEDURE or FUNCTION");
  const limit = clampInteger(args?.limit, 1, 500, 50);
  const lib = Tools.sqlString(library);
  const name = Tools.sqlString(routine);
  const routines: Record<string, unknown>[] = await conn.runSQL(
    `select * from QSYS2.SYSROUTINES where ROUTINE_SCHEMA = ${lib} and (ROUTINE_NAME = ${name} or SPECIFIC_NAME = ${name})` +
    (routineType ? ` and ROUTINE_TYPE = ${Tools.sqlString(routineType)}` : "") +
    ` order by SPECIFIC_NAME fetch first ${limit} rows only`
  );
  if (routines.length === 0) return toolError(`Routine ${library}.${routine} not found`, { library, routine, routineType });

  const specifics = [...new Set(routines.map(row => str(row, "SPECIFIC_NAME")).filter(Boolean) as string[])];
  const specificSchema = str(routines[0], "SPECIFIC_SCHEMA") || library;
  const parmRows: Record<string, unknown>[] = specifics.length === 0 ? [] : await conn.runSQL(
    `select * from QSYS2.SYSPARMS where SPECIFIC_SCHEMA = ${Tools.sqlString(specificSchema)} ` +
    `and SPECIFIC_NAME in (${specifics.map(value => Tools.sqlString(value)).join(", ")}) ` +
    `order by SPECIFIC_NAME, ORDINAL_POSITION fetch first ${Math.min(limit * 1000, 20000)} rows only`
  );

  return json({
    library,
    routine,
    routines: routines.map(row => shapeRoutine(row, parmRows.filter(parm => str(parm, "SPECIFIC_NAME") === str(row, "SPECIFIC_NAME")), Boolean(args?.includeDefinition)))
  });
}

export function shapeRoutine(row: Record<string, unknown>, parms: Record<string, unknown>[], includeDefinition: boolean) {
  const schema = str(row, "ROUTINE_SCHEMA") || "";
  const name = str(row, "ROUTINE_NAME") || "";
  const type = str(row, "ROUTINE_TYPE");
  const functionType = str(row, "FUNCTION_TYPE");
  const parameters = parms
    .filter(parm => (str(parm, "ROW_TYPE") || "P") === "P")
    .map(parm => compact({
      position: num(parm, "ORDINAL_POSITION"),
      mode: str(parm, "PARAMETER_MODE"),
      name: str(parm, "PARAMETER_NAME"),
      type: parmType(parm),
      nullable: yesNo(str(parm, "IS_NULLABLE")),
      default: str(parm, "DEFAULT"),
      ccsid: num(parm, "CCSID"),
      text: str(parm, "LONG_COMMENT")
    }));
  const results = parms
    .filter(parm => str(parm, "ROW_TYPE") === "R" || str(parm, "ROW_TYPE") === "C")
    .map(parm => compact({ name: str(parm, "PARAMETER_NAME"), type: parmType(parm) }));

  const parameterText = parameters
    .map(p => [type === "PROCEDURE" ? p.mode : undefined, p.name, p.type].filter(Boolean).join(" "))
    .join(", ");
  let returns = "";
  if (type === "FUNCTION" && results.length > 0) {
    returns = functionType === "T"
      ? ` RETURNS TABLE (${results.map(r => [r.name, r.type].filter(Boolean).join(" ")).join(", ")})`
      : ` RETURNS ${results[results.length - 1].type}`;
  }
  let definition = includeDefinition ? str(row, "ROUTINE_DEFINITION") : undefined;
  if (definition && definition.length > 65536) definition = `${definition.slice(0, 65536)}\n... (truncated)`;

  return compact({
    schema,
    name,
    specificName: str(row, "SPECIFIC_NAME"),
    type,
    functionType,
    signature: `${schema}.${name}(${parameterText})${returns}`,
    body: str(row, "ROUTINE_BODY"),
    language: str(row, "EXTERNAL_LANGUAGE"),
    externalName: str(row, "EXTERNAL_NAME"),
    parameterStyle: str(row, "PARAMETER_STYLE"),
    deterministic: yesNo(str(row, "IS_DETERMINISTIC")),
    sqlDataAccess: str(row, "SQL_DATA_ACCESS"),
    resultSets: num(row, "RESULT_SETS", "MAX_DYNAMIC_RESULT_SETS"),
    created: str(row, "ROUTINE_CREATED"),
    altered: str(row, "LAST_ALTERED"),
    text: str(row, "LONG_COMMENT"),
    parameters,
    ...(results.length > 0 ? { returns: results } : {}),
    ...(definition ? { definition } : {})
  });
}

function parmType(parm: Record<string, unknown>) {
  return formatSqlType(
    str(parm, "DATA_TYPE"),
    num(parm, "CHARACTER_MAXIMUM_LENGTH", "LENGTH"),
    num(parm, "NUMERIC_PRECISION"),
    num(parm, "NUMERIC_SCALE")
  );
}

// ---- shared helpers ----

const LENGTH_TYPES = new Set(["CHAR", "CHARACTER", "VARCHAR", "CHARACTER VARYING", "GRAPHIC", "VARGRAPHIC", "BINARY", "VARBINARY", "CLOB", "BLOB", "DBCLOB", "NCHAR", "NVARCHAR"]);
const DECIMAL_TYPES = new Set(["DECIMAL", "NUMERIC", "DEC"]);

export function formatSqlType(dataType: string | undefined, length?: number, precision?: number, scale?: number) {
  if (!dataType) return undefined;
  const upper = dataType.toUpperCase();
  if (DECIMAL_TYPES.has(upper)) {
    const digits = precision ?? length;
    return digits !== undefined ? `${upper}(${digits}, ${scale ?? 0})` : upper;
  }
  if (LENGTH_TYPES.has(upper) && length !== undefined) return `${upper}(${length})`;
  return upper;
}

function requireSqlName(value: unknown, label: string) {
  const name = String(value || "").trim().toUpperCase();
  if (!name) throw new Error(`${label} is required`);
  if (!/^[A-Z_#@$][A-Z0-9_#@$]{0,127}$/.test(name)) throw new Error(`Invalid ${label}: ${value}`);
  return name;
}

function str(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = pickFirst(row, keys);
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 && text !== "-" ? text : undefined;
}

function num(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  const text = str(row, ...keys);
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function yesNo(value: string | undefined) {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  if (upper === "Y" || upper === "YES") return true;
  if (upper === "N" || upper === "NO") return false;
  return undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

function compactOrUndefined(obj: Record<string, unknown>) {
  const result = compact(obj);
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Every non-empty column, trimmed, so values this module does not map are still visible. */
function allColumns(row: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text && text !== "-") out[key] = text;
  }
  return out;
}

function groupRows<T>(rows: Record<string, unknown>[], keyOf: (row: Record<string, unknown>) => string, build: (first: Record<string, unknown>, group: Record<string, unknown>[]) => T): T[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].map(group => build(group[0], group));
}

export const inspectModule: ToolModule = { tools, handle };
