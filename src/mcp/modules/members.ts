import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { Tools } from "../../ibmi/Tools.js";
import { commandOutcome, enforceWritable, toolError } from "../tools.js";
import { clTextValue, enforceLibraryPolicy, optionalName, refuseProtectedLibrary, requireName, runCheckedCl } from "./objects.js";

/**
 * Source member copy and attribute changes. Each tool passes the write gate,
 * reports a failing CL command as a tool error, and drops the cached member
 * snapshot for every member it may have changed.
 */

const CONNECTION_NAME = { type: "string", description: "Saved IBM i connection name." };
const APPROVE = { type: "boolean", description: "Set true to approve guarded-policy operations." };

function annotations(destructive: boolean, idempotent: boolean) {
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

const MEMBER_PROPERTIES = {
  library: { type: "string" },
  sourceFile: { type: "string" },
  member: { type: "string" }
};

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.qsys.members.copy",
    description:
      "Copy a source member with CPYSRCF. The target defaults to the same library, source file and member name; " +
      "at least one must differ. An existing target member is only replaced when replace=true.",
    inputSchema: {
      type: "object",
      properties: {
        ...MEMBER_PROPERTIES,
        toLibrary: { type: "string" },
        toSourceFile: { type: "string" },
        toMember: { type: "string" },
        replace: { type: "boolean", description: "Replace the target member if it exists. Default false." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "sourceFile", "member"],
      additionalProperties: false
    },
    annotations: annotations(true, false)
  },
  {
    name: "ibmi.qsys.members.changeText",
    description: "Change a member's text description with CHGPFM TEXT(...). An empty text sets *BLANK.",
    inputSchema: {
      type: "object",
      properties: {
        ...MEMBER_PROPERTIES,
        text: { type: "string", description: "Up to 50 characters." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "sourceFile", "member", "text"],
      additionalProperties: false
    },
    annotations: annotations(false, true)
  },
  {
    name: "ibmi.qsys.members.changeType",
    description: "Change a member's source type with CHGPFM SRCTYPE(...), for example RPGLE or SQLRPGLE.",
    inputSchema: {
      type: "object",
      properties: {
        ...MEMBER_PROPERTIES,
        srctype: { type: "string", description: "New source type (up to 10 characters) or *NONE." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["library", "sourceFile", "member", "srctype"],
      additionalProperties: false
    },
    annotations: annotations(false, true)
  }
];

export function requireSourceType(value: unknown) {
  const type = String(value ?? "").trim().toUpperCase();
  if (!type) throw new Error("srctype is required");
  if (type !== "*NONE" && !/^[A-Z0-9#@$_.]{1,10}$/.test(type)) throw new Error(`Invalid srctype: ${value}`);
  return type;
}

function invalidate(conn: any, library: string, sourceFile: string, member: string) {
  if (typeof conn?.content?.invalidateMemberSnapshot === "function") {
    conn.content.invalidateMemberSnapshot(library, sourceFile, member);
  }
}

async function memberExists(conn: any, library: string, sourceFile: string, member: string) {
  const rows = await conn.runSQL(
    `select SYSTEM_TABLE_MEMBER from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA = ${Tools.sqlString(library)} ` +
    `and SYSTEM_TABLE_NAME = ${Tools.sqlString(sourceFile)} and SYSTEM_TABLE_MEMBER = ${Tools.sqlString(member)} ` +
    `fetch first 1 rows only`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function handle(ctx: McpContext, name: string, args: any) {
  args = args || {};
  const conn = await ctx.ensureActive(args.connectionName);
  enforceWritable(ctx, conn, "qsys.write", args);
  const library = requireName(args.library, "library");
  const sourceFile = requireName(args.sourceFile, "sourceFile");
  const member = requireName(args.member, "member");

  switch (name) {
    case "ibmi.qsys.members.copy": {
      const toLibrary = optionalName(args.toLibrary, "toLibrary", library);
      const toSourceFile = optionalName(args.toSourceFile, "toSourceFile", sourceFile);
      const toMember = optionalName(args.toMember, "toMember", member);
      if (toLibrary === library && toSourceFile === sourceFile && toMember === member) {
        throw new Error("Copy target is the same as the source: set toLibrary, toSourceFile or toMember");
      }
      refuseProtectedLibrary(toLibrary, "copying members");
      enforceLibraryPolicy(ctx, name, args, [library, toLibrary]);
      if (args.replace !== true && await memberExists(conn, toLibrary, toSourceFile, toMember)) {
        return toolError(
          `Member ${toLibrary}/${toSourceFile}(${toMember}) already exists. Pass replace=true to overwrite it.`,
          { library: toLibrary, sourceFile: toSourceFile, member: toMember }
        );
      }
      const command =
        `CPYSRCF FROMFILE(${library}/${sourceFile}) TOFILE(${toLibrary}/${toSourceFile}) ` +
        `FROMMBR(${member}) TOMBR(${toMember}) MBROPT(*REPLACE)`;
      try {
        return commandOutcome(await runCheckedCl(ctx, conn, args, command));
      } finally {
        invalidate(conn, toLibrary, toSourceFile, toMember);
      }
    }
    case "ibmi.qsys.members.changeText": {
      const text = clTextValue(args.text);
      refuseProtectedLibrary(library, "changing members");
      enforceLibraryPolicy(ctx, name, args, [library]);
      try {
        return commandOutcome(await runCheckedCl(ctx, conn, args, `CHGPFM FILE(${library}/${sourceFile}) MBR(${member}) TEXT(${text})`));
      } finally {
        invalidate(conn, library, sourceFile, member);
      }
    }
    case "ibmi.qsys.members.changeType": {
      const srctype = requireSourceType(args.srctype);
      refuseProtectedLibrary(library, "changing members");
      enforceLibraryPolicy(ctx, name, args, [library]);
      try {
        return commandOutcome(await runCheckedCl(ctx, conn, args, `CHGPFM FILE(${library}/${sourceFile}) MBR(${member}) SRCTYPE(${srctype})`));
      } finally {
        invalidate(conn, library, sourceFile, member);
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const membersModule: ToolModule = { tools, handle };
