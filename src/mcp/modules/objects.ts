import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { checkClCommand, checkResourcePolicy } from "../policy.js";
import { clampNumber, commandOutcome, enforceWritable, quoteClString, runClCommand, toolError } from "../tools.js";

/**
 * Object and library operations (copy, move, rename, delete, describe).
 * Every tool changes the IBM i, so each one passes the write gate, checks the
 * built CL command against the command policy and every library it touches
 * against the library policy, and reports a failing command as a tool error.
 */

/** Object types these tools accept, with the command and keyword that delete each one. */
export const OBJECT_DELETE_COMMANDS: Record<string, { command: string; keyword: string }> = {
  "*PGM": { command: "DLTPGM", keyword: "PGM" },
  "*SRVPGM": { command: "DLTSRVPGM", keyword: "SRVPGM" },
  "*MODULE": { command: "DLTMOD", keyword: "MODULE" },
  "*FILE": { command: "DLTF", keyword: "FILE" },
  "*DTAARA": { command: "DLTDTAARA", keyword: "DTAARA" },
  "*DTAQ": { command: "DLTDTAQ", keyword: "DTAQ" },
  "*CMD": { command: "DLTCMD", keyword: "CMD" },
  "*MSGF": { command: "DLTMSGF", keyword: "MSGF" },
  "*MENU": { command: "DLTMNU", keyword: "MENU" },
  "*PNLGRP": { command: "DLTPNLGRP", keyword: "PNLGRP" },
  "*BNDDIR": { command: "DLTBNDDIR", keyword: "BNDDIR" },
  "*JOBD": { command: "DLTJOBD", keyword: "JOBD" },
  "*OUTQ": { command: "DLTOUTQ", keyword: "OUTQ" },
  "*USRSPC": { command: "DLTUSRSPC", keyword: "USRSPC" },
  "*USRIDX": { command: "DLTUSRIDX", keyword: "USRIDX" },
  "*USRQ": { command: "DLTUSRQ", keyword: "USRQ" },
  "*SQLPKG": { command: "DLTSQLPKG", keyword: "SQLPKG" },
  "*QRYDFN": { command: "DLTQRY", keyword: "QRY" },
  "*JRN": { command: "DLTJRN", keyword: "JRN" },
  "*JRNRCV": { command: "DLTJRNRCV", keyword: "JRNRCV" },
  "*SBSD": { command: "DLTSBSD", keyword: "SBSD" },
  "*CLS": { command: "DLTCLS", keyword: "CLS" },
  "*TBL": { command: "DLTTBL", keyword: "TBL" }
};

export const OBJECT_TYPES = Object.keys(OBJECT_DELETE_COMMANDS);

/** Libraries whose objects these tools never change, move, delete or copy into. */
const PROTECTED_LIBRARIES = new Set([
  "QSYS", "QSYS2", "QSYSINC", "QUSRSYS", "QRECOVERY", "QSPL", "QRPLOBJ", "QHLPSYS", "QDOC", "QSRV",
  "SYSIBM", "SYSIBMADM", "SYSPROC", "SYSTOOLS", "SYSCAT", "SYSFUN", "SYSSTAT"
]);

/** True for IBM system libraries whose contents these tools must not change. */
export function isProtectedLibrary(name: string) {
  const upper = String(name || "").toUpperCase();
  return PROTECTED_LIBRARIES.has(upper) || upper.startsWith("QSYS") || upper.startsWith("#");
}

/**
 * True for library names reserved for the system: the protected libraries
 * plus every name starting with Q (QGPL, QTEMP, QUSRSYS, ...), which IBM
 * reserves for its own libraries. Used for deleting or creating whole libraries.
 */
export function isReservedLibraryName(name: string) {
  const upper = String(name || "").toUpperCase();
  return isProtectedLibrary(upper) || upper.startsWith("Q");
}

const NAME_PATTERN = /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/;

/** Validate and uppercase an IBM i object, library, file or member name. */
export function requireName(value: unknown, label: string) {
  const name = String(value ?? "").trim().toUpperCase();
  if (!name) throw new Error(`${label} is required`);
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid ${label}: ${value}`);
  return name;
}

export function optionalName(value: unknown, label: string, fallback: string) {
  return value === undefined || value === null || String(value).trim() === "" ? fallback : requireName(value, label);
}

export function requireObjectType(value: unknown) {
  const objectType = String(value ?? "").trim().toUpperCase();
  if (!objectType) throw new Error("objectType is required");
  if (!OBJECT_DELETE_COMMANDS[objectType]) {
    throw new Error(`Unsupported objectType ${value}. Use one of: ${OBJECT_TYPES.join(", ")}`);
  }
  return objectType;
}

/**
 * Validate a TEXT value (at most 50 characters, no control characters) and
 * return it as a CL parameter value: a quoted string, or *BLANK when empty.
 */
export function clTextValue(value: unknown, label = "text") {
  if (value === undefined || value === null) throw new Error(`${label} is required`);
  const text = String(value);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`Invalid ${label}: control characters are not allowed`);
  if (text.length > 50) throw new Error(`Invalid ${label}: at most 50 characters (got ${text.length})`);
  return text.trim() === "" ? "*BLANK" : quoteClString(text);
}

export function refuseProtectedLibrary(library: string, action: string) {
  if (isProtectedLibrary(library)) {
    throw new Error(`Refused: ${action} in system library ${library} is not allowed`);
  }
}

/** Apply the library policy (allowLibraries/denyLibraries) to every library a call touches. */
export function enforceLibraryPolicy(ctx: McpContext, toolName: string, args: any, libraries: string[]) {
  const policy = ctx.getPolicy(args?.connectionName);
  for (const library of libraries) {
    const reason = checkResourcePolicy(policy, toolName, { library });
    if (reason) throw new Error(`Blocked by policy: ${toolName} (${reason})`);
  }
}

/** Check a built CL command against the command policy, run it, and return the outcome. */
export async function runCheckedCl(ctx: McpContext, conn: any, args: any, command: string, timeoutMs = 120000) {
  const reason = checkClCommand(ctx.getPolicy(args?.connectionName), command);
  if (reason) throw new Error(`Blocked by policy: ${reason}`);
  const res = await runClCommand(conn, command, "ile", undefined, timeoutMs);
  return { ...res, ok: res.code === 0, command };
}

const CONNECTION_NAME = { type: "string", description: "Saved IBM i connection name." };
const APPROVE = { type: "boolean", description: "Set true to approve guarded-policy operations." };
const OBJECT_TYPE = { type: "string", enum: OBJECT_TYPES, description: "Object type, for example *PGM or *FILE." };

function annotations(destructive: boolean, idempotent = false) {
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.objects.copy",
    description: "Duplicate an object with CRTDUPOBJ. Copies to toLibrary (default: same library) as newObject (default: same name). data=true also copies file data.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        object: { type: "string" },
        objectType: OBJECT_TYPE,
        toLibrary: { type: "string" },
        newObject: { type: "string" },
        data: { type: "boolean", description: "Copy the data of a *FILE (DATA(*YES)). Default false." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "object", "objectType"],
      additionalProperties: false
    },
    annotations: annotations(false)
  },
  {
    name: "ibmi.objects.move",
    description: "Move an object to another library with MOVOBJ.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        object: { type: "string" },
        objectType: OBJECT_TYPE,
        toLibrary: { type: "string" },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "object", "objectType", "toLibrary"],
      additionalProperties: false
    },
    annotations: annotations(true)
  },
  {
    name: "ibmi.objects.rename",
    description: "Rename an object in its library with RNMOBJ.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        object: { type: "string" },
        objectType: OBJECT_TYPE,
        newObject: { type: "string" },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "object", "objectType", "newObject"],
      additionalProperties: false
    },
    annotations: annotations(true)
  },
  {
    name: "ibmi.objects.delete",
    description:
      "Delete an object with the delete command for its type (DLTPGM, DLTF, ...). To delete a whole library, " +
      "set objectType=*LIB, put the library in `library`, and pass approve=true and confirmName equal to the library name. " +
      "System libraries (Q*, #*, SYS*) are refused.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: "Library holding the object, or the library to delete when objectType is *LIB." },
        object: { type: "string", description: "Object name. Not used when objectType is *LIB." },
        objectType: { type: "string", enum: [...OBJECT_TYPES, "*LIB"] },
        confirmName: { type: "string", description: "Required for *LIB: repeat the library name exactly." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "objectType"],
      additionalProperties: false
    },
    annotations: annotations(true)
  },
  {
    name: "ibmi.objects.changeDescription",
    description: "Change an object's text description with CHGOBJD TEXT(...). An empty text sets *BLANK.",
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string" },
        object: { type: "string" },
        objectType: OBJECT_TYPE,
        text: { type: "string", description: "Up to 50 characters." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "object", "objectType", "text"],
      additionalProperties: false
    },
    annotations: annotations(false, true)
  },
  {
    name: "ibmi.libraries.copy",
    description: "Copy a library with CPYLIB. createLibrary (default true) creates toLibrary; data (default true) copies file data.",
    inputSchema: {
      type: "object",
      properties: {
        fromLibrary: { type: "string" },
        toLibrary: { type: "string" },
        createLibrary: { type: "boolean", description: "CRTLIB(*YES) when true (default), CRTLIB(*NO) to copy into an existing library." },
        data: { type: "boolean", description: "DATA(*YES) when true (default)." },
        timeoutMs: { type: "number", description: "How long to wait for CPYLIB (default 600000, max 3600000)." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["fromLibrary", "toLibrary"],
      additionalProperties: false
    },
    annotations: annotations(false)
  }
];

async function handle(ctx: McpContext, name: string, args: any) {
  args = args || {};
  const conn = await ctx.ensureActive(args.connectionName);
  enforceWritable(ctx, conn, "qsys.write", args);

  switch (name) {
    case "ibmi.objects.copy": {
      const library = requireName(args.library, "library");
      const object = requireName(args.object, "object");
      const objectType = requireObjectType(args.objectType);
      const toLibrary = optionalName(args.toLibrary, "toLibrary", library);
      const newObject = optionalName(args.newObject, "newObject", object);
      if (toLibrary === library && newObject === object) {
        throw new Error("Copy target is the same as the source: set toLibrary or newObject");
      }
      refuseProtectedLibrary(toLibrary, "copying objects");
      enforceLibraryPolicy(ctx, name, args, [library, toLibrary]);
      let command = `CRTDUPOBJ OBJ(${object}) FROMLIB(${library}) OBJTYPE(${objectType}) TOLIB(${toLibrary}) NEWOBJ(${newObject})`;
      if (objectType === "*FILE") command += ` DATA(${args.data ? "*YES" : "*NO"})`;
      return commandOutcome(await runCheckedCl(ctx, conn, args, command));
    }
    case "ibmi.objects.move": {
      const library = requireName(args.library, "library");
      const object = requireName(args.object, "object");
      const objectType = requireObjectType(args.objectType);
      const toLibrary = requireName(args.toLibrary, "toLibrary");
      if (toLibrary === library) throw new Error("toLibrary must differ from library");
      refuseProtectedLibrary(library, "moving objects");
      refuseProtectedLibrary(toLibrary, "moving objects");
      enforceLibraryPolicy(ctx, name, args, [library, toLibrary]);
      const command = `MOVOBJ OBJ(${library}/${object}) OBJTYPE(${objectType}) TOLIB(${toLibrary})`;
      return commandOutcome(await runCheckedCl(ctx, conn, args, command));
    }
    case "ibmi.objects.rename": {
      const library = requireName(args.library, "library");
      const object = requireName(args.object, "object");
      const objectType = requireObjectType(args.objectType);
      const newObject = requireName(args.newObject, "newObject");
      if (newObject === object) throw new Error("newObject must differ from object");
      refuseProtectedLibrary(library, "renaming objects");
      enforceLibraryPolicy(ctx, name, args, [library]);
      const command = `RNMOBJ OBJ(${library}/${object}) OBJTYPE(${objectType}) NEWOBJ(${newObject})`;
      return commandOutcome(await runCheckedCl(ctx, conn, args, command));
    }
    case "ibmi.objects.delete": {
      const objectType = String(args.objectType ?? "").trim().toUpperCase();
      const library = requireName(args.library, "library");
      if (objectType === "*LIB") {
        if (args.object !== undefined && requireName(args.object, "object") !== library) {
          throw new Error("For objectType *LIB put the library to delete in `library` and leave `object` out");
        }
        if (isReservedLibraryName(library)) {
          throw new Error(`Refused: ${library} is a system library and cannot be deleted`);
        }
        if (args.approve !== true) {
          return toolError(`Deleting library ${library} needs approve=true and confirmName="${library}".`, { library });
        }
        if (String(args.confirmName ?? "").trim().toUpperCase() !== library) {
          return toolError(`confirmName must repeat the library name exactly (${library}) to delete it.`, { library });
        }
        enforceLibraryPolicy(ctx, name, args, [library]);
        return commandOutcome(await runCheckedCl(ctx, conn, args, `DLTLIB LIB(${library})`, 600000));
      }
      const type = requireObjectType(objectType);
      const object = requireName(args.object, "object");
      refuseProtectedLibrary(library, "deleting objects");
      enforceLibraryPolicy(ctx, name, args, [library]);
      const { command: dlt, keyword } = OBJECT_DELETE_COMMANDS[type];
      return commandOutcome(await runCheckedCl(ctx, conn, args, `${dlt} ${keyword}(${library}/${object})`));
    }
    case "ibmi.objects.changeDescription": {
      const library = requireName(args.library, "library");
      const object = requireName(args.object, "object");
      const objectType = requireObjectType(args.objectType);
      const text = clTextValue(args.text);
      refuseProtectedLibrary(library, "changing objects");
      enforceLibraryPolicy(ctx, name, args, [library]);
      const command = `CHGOBJD OBJ(${library}/${object}) OBJTYPE(${objectType}) TEXT(${text})`;
      return commandOutcome(await runCheckedCl(ctx, conn, args, command));
    }
    case "ibmi.libraries.copy": {
      const fromLibrary = requireName(args.fromLibrary, "fromLibrary");
      const toLibrary = requireName(args.toLibrary, "toLibrary");
      if (fromLibrary === toLibrary) throw new Error("toLibrary must differ from fromLibrary");
      if (isReservedLibraryName(toLibrary)) {
        throw new Error(`Refused: cannot copy into system library ${toLibrary}`);
      }
      enforceLibraryPolicy(ctx, name, args, [fromLibrary, toLibrary]);
      const createLibrary = args.createLibrary === undefined ? true : Boolean(args.createLibrary);
      const data = args.data === undefined ? true : Boolean(args.data);
      const timeoutMs = clampNumber(args.timeoutMs, 600000, 1000, 3600000);
      const command = `CPYLIB FROMLIB(${fromLibrary}) TOLIB(${toLibrary}) CRTLIB(${createLibrary ? "*YES" : "*NO"}) DATA(${data ? "*YES" : "*NO"})`;
      return commandOutcome(await runCheckedCl(ctx, conn, args, command, timeoutMs));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const objectsModule: ToolModule = { tools, handle };
