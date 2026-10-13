import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { Tools } from "../../ibmi/Tools.js";
import { assertSafeIfsTargetPath, checkResourcePolicy, normalizeIfsPath } from "../policy.js";
import { commandOutcome, enforceWritable, resolveIfsWriteOperation, toolError } from "../tools.js";

/**
 * IFS copy and move. Paths are checked like ibmi.ifs.delete (no root,
 * top-level or system directories, no '..' or wildcards), against the path
 * policy, and are single-quoted for the shell. An existing destination is
 * only overwritten when overwrite=true.
 */

const CONNECTION_NAME = { type: "string", description: "Saved IBM i connection name." };
const APPROVE = { type: "boolean", description: "Set true to approve guarded-policy operations." };
const ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.ifs.copy",
    description:
      "Copy an IFS file with cp, or a directory tree with recursive=true (cp -R). " +
      "Refuses an existing destination unless overwrite=true (an existing directory then receives the copy inside it).",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "Absolute IFS path to copy." },
        destinationPath: { type: "string", description: "Absolute IFS path to create." },
        recursive: { type: "boolean", description: "Copy a directory and everything under it." },
        overwrite: { type: "boolean", description: "Allow an existing destination. Default false." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false
    },
    annotations: ANNOTATIONS
  },
  {
    name: "ibmi.ifs.move",
    description:
      "Move or rename an IFS file or directory with mv. " +
      "Refuses an existing destination unless overwrite=true (an existing directory then receives the entry inside it).",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "Absolute IFS path to move." },
        destinationPath: { type: "string", description: "Absolute IFS path to move it to." },
        overwrite: { type: "boolean", description: "Allow an existing destination. Default false." },
        connectionName: CONNECTION_NAME,
        approve: APPROVE
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false
    },
    annotations: ANNOTATIONS
  }
];

/** Basic checks for a path that is only read (a non-recursive copy source). */
function requireReadablePath(value: unknown, operation: string) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${operation} refused: sourcePath is empty`);
  if (/[\0\r\n]/.test(raw)) throw new Error(`${operation} refused: path contains control characters`);
  if (!raw.startsWith("/")) throw new Error(`${operation} refused: path must be absolute`);
  if (raw.split(/[\\/]/).some(segment => segment === "..")) throw new Error(`${operation} refused: path must not contain '..'`);
  if (/[*?[\]]/.test(raw)) throw new Error(`${operation} refused: wildcards are not allowed`);
  const normalized = normalizeIfsPath(raw);
  if (normalized === "/") throw new Error(`${operation} refused: cannot copy the root directory`);
  return normalized;
}

function enforcePathPolicy(ctx: McpContext, toolName: string, args: any, paths: string[]) {
  const policy = ctx.getPolicy(args?.connectionName);
  for (const ifsPath of paths) {
    const reason = checkResourcePolicy(policy, toolName, { path: ifsPath });
    if (reason) throw new Error(`Blocked by policy: ${toolName} (${reason})`);
  }
}

function refuseSameOrNested(source: string, destination: string, operation: string) {
  const src = source.toLowerCase();
  const dest = destination.toLowerCase();
  if (src === dest) throw new Error(`${operation} refused: sourcePath and destinationPath are the same`);
  if (dest.startsWith(`${src}/`)) throw new Error(`${operation} refused: destinationPath is inside sourcePath`);
}

async function pathExists(conn: any, ifsPath: string) {
  const res = await conn.sendCommand({ command: `test -e ${Tools.shellQuote(ifsPath)}` });
  return res?.code === 0;
}

async function handle(ctx: McpContext, name: string, args: any) {
  args = args || {};
  const conn = await ctx.ensureActive(args.connectionName);
  const operation = name.replace(/^ibmi\./, "");
  const destination = assertSafeIfsTargetPath(args.destinationPath, operation, "write to");
  const source = name === "ibmi.ifs.move" || args.recursive
    ? assertSafeIfsTargetPath(args.sourcePath, operation, name === "ibmi.ifs.move" ? "move" : "recursively copy")
    : requireReadablePath(args.sourcePath, operation);
  refuseSameOrNested(source, destination, operation);

  await enforceWritable(ctx, conn, resolveIfsWriteOperation(destination), args);
  if (name === "ibmi.ifs.move") await enforceWritable(ctx, conn, "ifs.delete", args);
  enforcePathPolicy(ctx, name, args, [source, destination]);

  if (args.overwrite !== true && await pathExists(conn, destination)) {
    return toolError(`${destination} already exists. Pass overwrite=true to replace it or copy into it.`, {
      sourcePath: source,
      destinationPath: destination
    });
  }

  let command: string;
  switch (name) {
    case "ibmi.ifs.copy":
      command = `cp ${args.recursive ? "-R " : ""}${Tools.shellQuote(source)} ${Tools.shellQuote(destination)}`;
      break;
    case "ibmi.ifs.move":
      command = `mv ${Tools.shellQuote(source)} ${Tools.shellQuote(destination)}`;
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  const res = await conn.sendCommand({ command });
  return commandOutcome({ ...res, ok: res?.code === 0, command, sourcePath: source, destinationPath: destination });
}

export const ifsOpsModule: ToolModule = { tools, handle };
