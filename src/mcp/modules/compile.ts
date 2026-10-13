import fs from "fs/promises";
import path from "path";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { CompileTools } from "../../ibmi/CompileTools.js";
import { Variables } from "../../ibmi/variables.js";
import { Tools } from "../../ibmi/Tools.js";
import { Action } from "../../ibmi/types.js";
import { EvfParseResult, parseEvfevent } from "../../ibmi/evfevent.js";
import {
  actionCommandGuard,
  clampNumber,
  enforceWritable,
  guardLocalPath,
  handleTool,
  json,
  jsonError,
  mapActionExecution,
  normalizeSpoolEntry,
  normalizeSpoolLine,
  requireQsysName,
  resolveAction
} from "../tools.js";

/** Variables an action may use that this server can leave unset for a target. */
const TARGET_VARIABLES = [
  "RELATIVEPATH", "FULLPATH", "FILEDIR", "PARENT", "BASENAME", "NAME", "NAMEL", "EXT", "EXTL",
  "OPENLIB", "OPENLIBL", "OPENSPF", "OPENSPFL", "OPENMBR", "OPENMBRL", "SRCFILE", "SRCLIB", "SRCPF",
  "LIBRARY", "CURLIB", "BUILDLIB", "LIBLS", "WORKDIR", "HOME", "BRANCH", "USERNAME", "HOST"
];

/** Object parameters that name the object a compile creates. */
const OBJECT_PARAMETERS = ["PGM", "MODULE", "OBJ", "SRVPGM", "CMD", "FILE", "MENU", "PNLGRP", "QRY", "TBL"];

export type ActionTarget = {
  targetType: "member" | "streamfile";
  displayPath: string;
  env: Record<string, string>;
  cwd?: string;
  /** Default EVFEVENT location when the command does not name the object. */
  evfLibrary: string;
  evfMember: string;
  library?: string;
  sourceFile?: string;
  member?: string;
};

/** Split a member target such as LIB/FILE/MBR, LIB/FILE/MBR.TYPE or /QSYS.LIB/LIB.LIB/FILE.FILE/MBR.MBR. */
export function parseMemberTargetPath(value: unknown): { library?: string; sourceFile?: string; member?: string; extension?: string } {
  const text = String(value ?? "").trim();
  if (!text) return {};
  const qsys = text.match(/^\/QSYS\.LIB\/([^/]+)\.LIB\/([^/]+)\.FILE\/([^/]+)\.MBR$/i);
  if (qsys) return { library: qsys[1], sourceFile: qsys[2], member: qsys[3] };
  const parts = text.replace(/^\/+/, "").split("/");
  if (parts.length === 3) {
    const [library, sourceFile, last] = parts;
    const dot = last.lastIndexOf(".");
    return dot > 0
      ? { library, sourceFile, member: last.substring(0, dot), extension: last.substring(dot + 1) }
      : { library, sourceFile, member: last };
  }
  if (parts.length === 1) {
    const dot = text.lastIndexOf(".");
    return dot > 0 ? { member: text.substring(0, dot), extension: text.substring(dot + 1) } : { member: text };
  }
  return {};
}

/** Build the variables for a member or streamfile target, as Code for IBM i does. */
export async function buildActionTarget(conn: any, args: any, remoteWorkspace?: string): Promise<ActionTarget> {
  const config = conn.getConfig();
  const curlib = String(config.currentLibrary || "QGPL").toUpperCase();
  const targetType = String(args?.targetType || "");

  if (targetType === "member") {
    const parsed = parseMemberTargetPath(args.targetPath);
    const lib = requireQsysName(conn, args.library || parsed.library, "library");
    const src = requireQsysName(conn, args.sourceFile || parsed.sourceFile, "sourceFile");
    const mbr = requireQsysName(conn, args.member || parsed.member, "member");
    let ext = String(args.extension || parsed.extension || "").trim();
    if (!ext && conn.content?.getMemberInfo) {
      try {
        ext = String((await conn.content.getMemberInfo(lib, src, mbr))?.extension || "");
      } catch {
        ext = "";
      }
    }
    if (ext && !/^[A-Za-z0-9#@$_]{1,10}$/.test(ext)) throw new Error(`Invalid extension: ${ext}`);
    const env: Record<string, string> = {
      "&OPENLIB": lib,
      "&OPENLIBL": lib.toLowerCase(),
      "&OPENSPF": src,
      "&OPENSPFL": src.toLowerCase(),
      "&OPENMBR": mbr,
      "&OPENMBRL": mbr.toLowerCase(),
      "&EXT": ext.toUpperCase(),
      "&EXTL": ext.toLowerCase(),
      "&NAME": mbr,
      "&NAMEL": mbr.toLowerCase(),
      "&BASENAME": ext ? `${mbr}.${ext.toUpperCase()}` : mbr,
      "&LIBRARY": lib,
      "&SRCLIB": lib,
      "&SRCPF": src,
      "&SRCFILE": `${lib}/${src}`,
      "&FULLPATH": `/QSYS.LIB/${lib}.LIB/${src}.FILE/${mbr}.MBR`
    };
    return {
      targetType: "member",
      displayPath: `${lib}/${src}/${mbr}${ext ? `.${ext.toUpperCase()}` : ""}`,
      env,
      evfLibrary: lib,
      evfMember: mbr,
      library: lib,
      sourceFile: src,
      member: mbr
    };
  }

  if (targetType === "streamfile") {
    const target = CompileTools.validateStreamfilePath(args.targetPath);
    const cwd = args.cwd
      ? CompileTools.validateStreamfilePath(args.cwd).replace(/(.)\/+$/, "$1")
      : remoteWorkspace || String(config.homeDirectory || "").replace(/(.)\/+$/, "$1") || undefined;
    const base = path.posix.basename(target);
    const dot = base.lastIndexOf(".");
    const name = dot > 0 ? base.substring(0, dot) : base;
    const ext = dot > 0 ? base.substring(dot + 1) : "";
    const dir = path.posix.dirname(target);
    const relative = cwd && (target === cwd || target.startsWith(`${cwd === "/" ? "" : cwd}/`))
      ? path.posix.relative(cwd, target)
      : target;
    const env: Record<string, string> = {
      "&FULLPATH": target,
      "&FILEDIR": dir,
      "&PARENT": path.posix.basename(dir),
      "&RELATIVEPATH": relative || target,
      "&BASENAME": base,
      "{filename}": base,
      "&NAME": name,
      "&NAMEL": name.toLowerCase(),
      "&EXT": ext,
      "&EXTL": ext.toLowerCase(),
      "&SRCLIB": curlib,
      "&SRCPF": "QTMPSRC",
      "&SRCFILE": `${curlib}/QTMPSRC`
    };
    return {
      targetType: "streamfile",
      displayPath: target,
      env,
      cwd,
      evfLibrary: curlib,
      evfMember: name.toUpperCase()
    };
  }

  if (targetType === "file") {
    throw new Error("Local file actions are not supported in this MCP server (use streamfile or member).");
  }
  throw new Error("targetType must be member or streamfile");
}

/** Refuse a command that still holds a target variable this target did not set. */
export function assertNoUnresolvedVariables(command: string, targetType: string) {
  const left = new Set<string>();
  for (const match of command.matchAll(/&([A-Za-z]+)(?![A-Za-z0-9_#@$])/g)) {
    const name = match[1].toUpperCase();
    if (TARGET_VARIABLES.includes(name)) left.add(`&${name}`);
  }
  if (left.size > 0) {
    throw new Error(`Action uses ${Array.from(left).join(", ")}, which is not set for ${targetType} targets`);
  }
}

/** Find the object a compile command creates, for the EVFEVENT lookup. */
export function findCompiledObject(command: string, currentLibrary: string): { library: string; object: string } | undefined {
  const firstLine = String(command || "").split(/\r?\n/).find(line => /\*EVENTF/i.test(line)) || String(command || "");
  // The first object parameter in the command is the object it creates
  // (CRTCMD CMD(...) PGM(...) creates the command, not the program).
  const match = firstLine.match(new RegExp(`\\b(?:${OBJECT_PARAMETERS.join("|")})\\(\\s*(?:([^\\s/()]+)\\/)?([^\\s/()]+)\\s*\\)`, "i"));
  if (match) {
    let library = (match[1] || "*LIBL").toUpperCase();
    if (library === "*CURLIB" || library === "*LIBL") library = currentLibrary.toUpperCase();
    return { library, object: match[2].toUpperCase() };
  }
  return undefined;
}

export type EvfeventRead = {
  library: string;
  member: string;
  found: boolean;
  records?: number;
  error?: string;
  result?: EvfParseResult;
};

/** Read LIB/EVFEVENT(member) through a QTEMP alias and parse it. */
export async function readEvfeventMember(conn: any, library: string, member: string): Promise<EvfeventRead> {
  const lib = requireQsysName(conn, library, "EVFEVENT library");
  const mbr = requireQsysName(conn, member, "EVFEVENT member");
  try {
    const rows: Array<Record<string, unknown>> = await conn.runSQL(
      `create or replace alias QTEMP.MCP_EVFEVENT for "${lib}"."EVFEVENT"("${mbr}");\n` +
      // EVFEVENT is CCSID 65535, so the bytes come back raw unless cast to EBCDIC text.
      `select rtrim(cast(E.EVFEVENT as varchar(400) ccsid 37)) as EVFEVENT from QTEMP.MCP_EVFEVENT as E order by rrn(E)`
    );
    const lines = (rows || []).map(row => {
      const value = row.EVFEVENT ?? Object.values(row)[0];
      return String(value ?? "");
    });
    return { library: lib, member: mbr, found: true, records: lines.length, result: parseEvfevent(lines) };
  } catch (err: any) {
    return { library: lib, member: mbr, found: false, error: err?.message || String(err) };
  }
}

export type CompileListing = {
  found: boolean;
  jobName?: string;
  spooledFileName?: string;
  spooledFileNumber?: number | null;
  createdAt?: string | null;
  lines?: string[];
  truncated?: boolean;
  error?: string;
};

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[- T]\d{2}[.:]\d{2}[.:]\d{2}(?:\.\d{1,12})?$/;

/**
 * Fetch the most recent compile listing: a spooled file named after the
 * object, else QSYSPRT, else QPJOBLOG, owned by the user and created at or
 * after `since`.
 */
export async function fetchCompileListing(
  conn: any,
  options: { objectName: string; userName?: string; since?: string; maxLines?: number }
): Promise<CompileListing> {
  const object = requireQsysName(conn, options.objectName, "objectName");
  const user = requireQsysName(conn, options.userName || conn.currentUser, "userName");
  const since = options.since ? String(options.since).trim() : "";
  if (since && !TIMESTAMP_PATTERN.test(since)) throw new Error(`Invalid since timestamp: ${options.since}`);
  const maxLines = clampNumber(options.maxLines, 2000, 1, 20000);
  const names = Array.from(new Set([object, "QSYSPRT", "QPJOBLOG"]));
  const where = [
    `user_name = ${Tools.sqlString(user)}`,
    `spooled_file_name in (${names.map(n => Tools.sqlString(n)).join(", ")})`,
    ...(since ? [`create_timestamp >= timestamp(${Tools.sqlString(since)})`] : [])
  ].join(" and ");
  const order = `order by case spooled_file_name ${names.map((n, i) => `when ${Tools.sqlString(n)} then ${i}`).join(" ")} else 9 end, create_timestamp desc fetch first 1 rows only`;

  let entry: ReturnType<typeof normalizeSpoolEntry> | undefined;
  let lastError: unknown;
  for (const view of ["qsys2.output_queue_entries_basic", "qsys2.output_queue_entries"]) {
    try {
      const rows = await conn.runSQL(`select * from ${view} where ${where} ${order}`);
      entry = rows?.[0] ? normalizeSpoolEntry(rows[0]) : undefined;
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) return { found: false, error: (lastError as any)?.message || String(lastError) };
  if (!entry || !entry.jobName || !entry.spooledFileName) return { found: false };

  const number = entry.spooledFileNumber ?? 1;
  const rows = await conn.runSQL(
    `select ordinal_position, spooled_data from table(qsys2.display_spooled_file_data(` +
    `${Tools.sqlString(entry.jobName)}, ${Tools.sqlString(entry.spooledFileName)}, ${Number(number)})) ` +
    `order by ordinal_position fetch first ${maxLines + 1} rows only`
  );
  const lines = (rows || []).map((row: Record<string, unknown>) => normalizeSpoolLine(row).text);
  return {
    found: true,
    jobName: entry.jobName,
    spooledFileName: entry.spooledFileName,
    spooledFileNumber: entry.spooledFileNumber,
    createdAt: entry.createdAt,
    lines: lines.slice(0, maxLines),
    truncated: lines.length > maxLines
  };
}

async function remoteTimestamp(conn: any): Promise<string | undefined> {
  try {
    const rows = await conn.runSQL(`select varchar(current timestamp) as TS from sysibm.sysdummy1`);
    const value = String(rows?.[0]?.TS ?? "").trim();
    return TIMESTAMP_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function mergeEvfResults(results: EvfParseResult[]): EvfParseResult | undefined {
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  const diagnostics = results.flatMap(r => r.diagnostics);
  const files = new Map<string, EvfParseResult["files"][number]>();
  for (const group of results.flatMap(r => r.files)) {
    const existing = files.get(group.file);
    if (!existing) {
      files.set(group.file, { ...group, errors: [...group.errors], counts: { ...group.counts } });
      continue;
    }
    existing.errors.push(...group.errors);
    existing.counts.errors += group.counts.errors;
    existing.counts.warnings += group.counts.warnings;
    existing.counts.infos += group.counts.infos;
  }
  return {
    timestamp: results.find(r => r.timestamp)?.timestamp,
    processors: results.reduce((sum, r) => sum + r.processors, 0),
    files: Array.from(files.values()),
    diagnostics,
    summary: {
      total: diagnostics.length,
      errors: diagnostics.filter(d => d.severity === "ERROR").length,
      warnings: diagnostics.filter(d => d.severity === "WARN").length,
      infos: diagnostics.filter(d => d.severity === "INFO").length,
      highestSeverity: diagnostics.reduce((max, d) => Math.max(max, d.severityLevel), 0)
    },
    unparsedLines: results.reduce((sum, r) => sum + r.unparsedLines, 0)
  };
}

async function listLocalFilesRecursive(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat) return [];
  if (stat.isFile()) return [root];
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listLocalFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

type DownloadOutcome = { remotePath: string; localPath?: string; kind?: "file" | "directory"; ok: boolean; error?: string };

async function postDownload(
  ctx: McpContext,
  conn: any,
  entries: string[],
  remoteBase: string | undefined,
  localBase: string
): Promise<DownloadOutcome[]> {
  const outcomes: DownloadOutcome[] = [];
  for (const rawEntry of entries) {
    const entry = String(rawEntry || "").trim();
    if (!entry) continue;
    let remotePath = "";
    try {
      const relative = !entry.startsWith("/");
      if (relative && !remoteBase) throw new Error("a relative postDownload path needs cwd or remoteWorkspace");
      remotePath = relative ? path.posix.join(remoteBase!, entry) : entry;
      remotePath = CompileTools.validateStreamfilePath(remotePath.replace(/(.)\/+$/, "$1"));
      const localRelative = relative ? entry.replace(/\/+$/, "") : path.posix.basename(remotePath);
      if (localRelative.split("/").some(part => part === "..")) throw new Error("postDownload path must not contain '..'");
      const localPath = await guardLocalPath(ctx, path.join(localBase, ...localRelative.split("/")), "write");
      const isDirectory = (await conn.sendCommand({ command: `test -d ${Tools.escapePath(remotePath)}` }))?.code === 0;
      if (isDirectory) {
        await fs.mkdir(localPath, { recursive: true });
        await conn.client!.getDirectory(localPath, remotePath, { recursive: true, concurrency: 5 });
      } else {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await conn.client!.getFile(localPath, remotePath);
      }
      outcomes.push({ remotePath, localPath, kind: isDirectory ? "directory" : "file", ok: true });
    } catch (err: any) {
      outcomes.push({ remotePath: remotePath || entry, ok: false, error: err?.message || String(err) });
    }
  }
  return outcomes;
}

function formatCommandOutput(command: string, result: any) {
  return [
    `Command: ${command}`,
    `Exit code: ${result?.code}`,
    "",
    "STDOUT:",
    String(result?.stdout || ""),
    "",
    "STDERR:",
    String(result?.stderr || ""),
    ""
  ].join("\n");
}

/** ibmi.actions.run: run an action against a member or streamfile and collect its errors. */
export async function runActionTool(ctx: McpContext, args: any) {
  const conn: any = await ctx.ensureActive(args?.connectionName);
  await enforceWritable(ctx, conn, "qsys.write", args);
  const action: Action | undefined = await resolveAction(ctx, args);
  if (!action) throw new Error("Action not found");

  const targetType = String(args?.targetType || "");
  if (action.type && action.type !== targetType && targetType !== "file") {
    throw new Error(`Action "${action.name}" runs against ${action.type} targets, not ${targetType} targets`);
  }

  const remoteWorkspace = args?.remoteWorkspace
    ? CompileTools.validateStreamfilePath(args.remoteWorkspace).replace(/(.)\/+$/, "$1")
    : undefined;
  const target = await buildActionTarget(conn, args, remoteWorkspace);
  const config = conn.getConfig();
  const curlib = String(config.currentLibrary || "QGPL").toUpperCase();

  // deployFirst: push the local workspace before running (streamfile targets).
  let deploy: unknown;
  if (action.deployFirst && target.targetType === "streamfile") {
    if (args?.localWorkspace) {
      if (!remoteWorkspace) throw new Error("remoteWorkspace is required with localWorkspace");
      const deployResult: any = await handleTool(ctx, "ibmi.deploy.sync", {
        connectionName: args.connectionName,
        approve: args.approve,
        localPath: args.localWorkspace,
        remotePath: remoteWorkspace,
        overwrite: true
      });
      deploy = deployResult?.structuredContent?.data;
      if (deployResult?.isError) {
        return jsonError(`Deploy before "${action.name}" failed; the action was not run`, { action: action.name, deploy });
      }
    } else {
      deploy = { skipped: true, reason: "deployFirst is set but no localWorkspace was given" };
    }
  }

  const listingSince = args?.includeListing ? await remoteTimestamp(conn) : undefined;
  const guard = actionCommandGuard(ctx, action.environment, args);
  const commandResult: any = await CompileTools.runCommand(conn, {
    command: action.command,
    environment: action.environment,
    env: target.env,
    cwd: target.cwd
  }, {
    commandConfirm: async (expanded: string) => {
      assertNoUnresolvedVariables(expanded, target.targetType);
      return guard(expanded);
    }
  });
  const expandedCommand = String(commandResult.command || action.command);
  const payload: any = mapActionExecution(action, target.targetType, target.displayPath, commandResult);
  if (target.cwd) payload.cwd = target.cwd;
  if (deploy !== undefined) payload.deploy = deploy;

  // EVFEVENT from the object's library, as written by OPTION(*EVENTF).
  const evfResults: EvfParseResult[] = [];
  const environment = action.environment || "ile";
  if (environment === "ile" && /\*EVENTF\b/i.test(expandedCommand)) {
    const object = findCompiledObject(expandedCommand, curlib);
    const library = String(args?.evfeventLibrary || object?.library || target.evfLibrary).toUpperCase();
    const member = String(args?.evfeventMember || object?.object || target.evfMember).toUpperCase();
    if (conn.validQsysName(library) && conn.validQsysName(member)) {
      const read = await readEvfeventMember(conn, library, member);
      payload.evfevent = { library: read.library, member: read.member, found: read.found, records: read.records, error: read.error };
      if (read.result) evfResults.push(read.result);
    } else {
      payload.evfevent = { library, member, found: false, error: "EVFEVENT library or member is not a valid object name" };
    }
  }

  // postDownload: copy build outputs back to the local workspace.
  const downloads = (action.postDownload || []).filter(Boolean);
  if (downloads.length > 0) {
    const localBase = args?.downloadTo || args?.localWorkspace;
    if (!localBase) {
      payload.postDownload = { skipped: true, reason: "postDownload is set but neither downloadTo nor localWorkspace was given" };
    } else {
      const base = await guardLocalPath(ctx, localBase, "write");
      const outcomes = await postDownload(ctx, conn, downloads, target.cwd || remoteWorkspace, base);
      payload.postDownload = outcomes;
      for (const outcome of outcomes) {
        if (!outcome.ok || !outcome.localPath || !/\.evfevent/i.test(outcome.remotePath)) continue;
        for (const file of await listLocalFilesRecursive(outcome.localPath)) {
          try {
            evfResults.push(parseEvfevent(await fs.readFile(file, "utf8")));
          } catch {
            // Not readable as text: skip it.
          }
        }
      }
    }
  }

  const evf = mergeEvfResults(evfResults);
  if (evf) {
    payload.errors = evf.files;
    payload.errorSummary = evf.summary;
    if (payload.ok && evf.summary.errors > 0) payload.status = "warning";
  }

  if (args?.includeListing) {
    const object = findCompiledObject(expandedCommand, curlib);
    const objectName = object?.object || target.evfMember;
    try {
      payload.listing = conn.validQsysName(objectName)
        ? await fetchCompileListing(conn, { objectName, since: listingSince, maxLines: args?.listingMaxLines })
        : { found: false, error: `No valid object name for the listing: ${objectName}` };
    } catch (err: any) {
      payload.listing = { found: false, error: err?.message || String(err) };
    }
  }

  // outputToFile: save the command output locally.
  if (action.outputToFile) {
    try {
      let outputPath = new Variables(undefined, target.env).expand(action.outputToFile);
      if (/^&LOCAL\b/i.test(outputPath) || !path.isAbsolute(outputPath)) {
        if (!args?.localWorkspace) throw new Error("a relative outputToFile path needs localWorkspace");
        outputPath = path.join(args.localWorkspace, outputPath.replace(/^&LOCAL[\\/]?/i, ""));
      }
      const resolved = await guardLocalPath(ctx, outputPath, "write");
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, formatCommandOutput(expandedCommand, commandResult), "utf8");
      payload.outputFile = resolved;
    } catch (err: any) {
      payload.outputFile = { ok: false, error: err?.message || String(err) };
    }
  }

  if (!payload.ok) {
    const errorCount = evf?.summary.errors || 0;
    const firstError = evf?.diagnostics.find(d => d.severity === "ERROR");
    const detail = firstError
      ? `${errorCount} error(s); first: ${firstError.msgid} line ${firstError.line}: ${firstError.text}`
      : (Array.isArray(payload.diagnostics) ? payload.diagnostics.find((d: any) => d.severity === "ERROR")?.message : undefined)
        || String(commandResult.stderr || commandResult.stdout || "").trim().split(/\r?\n/)[0] || `exit ${commandResult.code}`;
    return jsonError(`Action "${action.name}" failed (${detail})`, payload);
  }
  return json(payload);
}

export const compileModule: ToolModule = {
  tools: [
    {
      name: "ibmi.compile.listing",
      description:
        "Read the most recent compile listing for an object: the newest spooled file named after the object " +
        "(falling back to QSYSPRT, then QPJOBLOG) owned by the user, optionally created at or after a timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string", description: "Saved IBM i connection name." },
          objectName: { type: "string", description: "Object (program, module, file) the compile created." },
          userName: { type: "string", description: "Spooled file owner. Defaults to the connection user." },
          since: { type: "string", description: "Only listings created at or after this IBM i timestamp (YYYY-MM-DD-HH.MM.SS[.ffffff])." },
          maxLines: { type: "number", description: "Maximum listing lines to return (default 2000)." }
        },
        required: ["objectName"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ],
  async handle(ctx, name, args) {
    if (name !== "ibmi.compile.listing") throw new Error(`Unknown tool: ${name}`);
    const conn: any = await ctx.ensureActive(args?.connectionName);
    const listing = await fetchCompileListing(conn, {
      objectName: args?.objectName,
      userName: args?.userName,
      since: args?.since,
      maxLines: args?.maxLines
    });
    if (listing.error) return jsonError(`Could not read the compile listing: ${listing.error}`, listing);
    return json(listing);
  }
};
