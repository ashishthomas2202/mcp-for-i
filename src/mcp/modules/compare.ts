import fs from "fs/promises";
import crypto from "crypto";
import { structuredPatch } from "diff";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { checkResourcePolicy } from "../policy.js";
import {
  clampInteger,
  decodeUtf8Text,
  guardLocalPath,
  json,
  requireIfsPath,
  requireQsysName,
  statIfsFileSize
} from "../tools.js";

// tools.ts imports this module, so nothing from tools.ts may be read at load time.
const HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_DIFF_LINES = 2000;
const HARD_MAX_DIFF_LINES = 50000;

const SOURCE_SCHEMA = {
  type: "object",
  description: "One side of the comparison: a source member, an IFS stream file or a local file.",
  properties: {
    type: { type: "string", enum: ["member", "ifs", "local"] },
    library: { type: "string", description: "member: library name." },
    sourceFile: { type: "string", description: "member: source physical file name." },
    member: { type: "string", description: "member: member name." },
    path: { type: "string", description: "ifs: absolute IFS path. local: local file path inside the allowed local roots." },
    connectionName: { type: "string", description: "member/ifs: connection to read from (defaults to the top-level connectionName or the active connection)." }
  },
  required: ["type"],
  additionalProperties: false
};

type TextSide = {
  type: "member" | "ifs" | "local";
  label: string;
  connectionName?: string;
  bytes: number;
  lines: number;
  sha256: string;
  text: string;
};

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.compare.text",
    description:
      "Compare two text sources (source member, IFS stream file or local file, in any combination) and return a unified diff " +
      "with configurable context lines plus added/removed counts. Members are read as source text only, so sequence numbers " +
      "and source dates never show up as changes. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        left: SOURCE_SCHEMA,
        right: SOURCE_SCHEMA,
        context: { type: "number", description: `Context lines around each change (default ${DEFAULT_CONTEXT}, max 1000).` },
        ignoreTrailingWhitespace: { type: "boolean", description: "Ignore trailing blanks and tabs on every line (default true; member lines are always right-trimmed)." },
        ignoreCase: { type: "boolean", description: "Compare lines case-insensitively (default false)." },
        maxBytes: { type: "number", description: `Refuse a side larger than this many bytes (default ${DEFAULT_MAX_BYTES}, max ${HARD_MAX_BYTES}).` },
        maxDiffLines: { type: "number", description: `Truncate the unified diff after this many lines (default ${DEFAULT_MAX_DIFF_LINES}, max ${HARD_MAX_DIFF_LINES}). Counts always cover the whole diff.` },
        connectionName: { type: "string", description: "Saved IBM i connection name used for member/ifs sides that don't name their own." }
      },
      required: ["left", "right"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

async function handle(ctx: McpContext, name: string, args: any) {
  if (name !== "ibmi.compare.text") throw new Error(`Unknown tool: ${name}`);
  const maxBytes = clampInteger(args?.maxBytes, 1, HARD_MAX_BYTES, DEFAULT_MAX_BYTES);
  const context = clampInteger(args?.context, 0, 1000, DEFAULT_CONTEXT);
  const maxDiffLines = clampInteger(args?.maxDiffLines, 1, HARD_MAX_DIFF_LINES, DEFAULT_MAX_DIFF_LINES);
  const ignoreTrailingWhitespace = args?.ignoreTrailingWhitespace !== false;
  const ignoreCase = Boolean(args?.ignoreCase);

  const left = await readSide(ctx, args?.left, "left", args?.connectionName, maxBytes);
  const right = await readSide(ctx, args?.right, "right", args?.connectionName, maxBytes);
  const comparison = compareTexts(left, right, { context, ignoreTrailingWhitespace, ignoreCase, maxDiffLines });

  return json({
    left: describeSide(left),
    right: describeSide(right),
    identical: comparison.identical,
    stats: comparison.stats,
    options: { context, ignoreTrailingWhitespace, ignoreCase, maxBytes, maxDiffLines },
    truncated: comparison.truncated,
    diff: comparison.diff
  });
}

function describeSide(side: TextSide) {
  return {
    type: side.type,
    label: side.label,
    ...(side.connectionName ? { connectionName: side.connectionName } : {}),
    bytes: side.bytes,
    lines: side.lines,
    sha256: side.sha256
  };
}

async function readSide(ctx: McpContext, spec: any, label: string, defaultConnection: unknown, maxBytes: number): Promise<TextSide> {
  if (!spec || typeof spec !== "object") throw new Error(`${label} is required`);
  const type = String(spec.type || "").trim().toLowerCase();
  if (type === "local") {
    const localPath = await guardLocalPath(ctx, spec.path, "read");
    const stat = await fs.stat(localPath);
    if (!stat.isFile()) throw new Error(`${label}: ${localPath} is not a file`);
    if (stat.size > maxBytes) throw new Error(`${label}: ${localPath} is ${stat.size} bytes, more than maxBytes (${maxBytes})`);
    const data = await fs.readFile(localPath);
    return makeSide("local", localPath, undefined, data, label);
  }
  if (type !== "member" && type !== "ifs") throw new Error(`${label}.type must be member, ifs or local`);

  const connectionName = String(spec.connectionName || defaultConnection || "").trim() || undefined;
  const conn: any = await ctx.ensureActive(connectionName);
  if (type === "member") {
    const library = requireQsysName(conn, spec.library, `${label}.library`);
    const sourceFile = requireQsysName(conn, spec.sourceFile, `${label}.sourceFile`);
    const member = requireQsysName(conn, spec.member, `${label}.member`);
    await enforceSidePolicy(ctx, connectionName, { library });
    const snapshot = await conn.content.getMemberSnapshot(library, sourceFile, member);
    // Source records are blank padded to the record length; the padding is
    // never meaningful, so member lines are always right-trimmed.
    const text = String(snapshot.content ?? "").split("\n").map((line: string) => line.replace(/[ \t]+$/, "")).join("\n");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) throw new Error(`${label}: ${library}/${sourceFile}(${member}) is ${bytes} bytes, more than maxBytes (${maxBytes})`);
    return makeSide("member", `${library}/${sourceFile}(${member})`, connectionName, Buffer.from(text, "utf8"), label);
  }

  const remotePath = requireIfsPath(spec.path, `${label}.path`);
  await enforceSidePolicy(ctx, connectionName, { path: remotePath });
  const knownSize = await statIfsFileSize(conn, remotePath);
  if (knownSize !== undefined && knownSize > maxBytes) {
    throw new Error(`${label}: ${remotePath} is ${knownSize} bytes, more than maxBytes (${maxBytes})`);
  }
  const data = Buffer.from(await conn.content.downloadStreamfileRaw(remotePath));
  if (data.length > maxBytes) throw new Error(`${label}: ${remotePath} is ${data.length} bytes, more than maxBytes (${maxBytes})`);
  return makeSide("ifs", remotePath, connectionName, data, label);
}

function makeSide(type: TextSide["type"], name: string, connectionName: string | undefined, data: Buffer, label: string): TextSide {
  const text = decodeUtf8Text(data);
  if (text === undefined) throw new Error(`${label}: ${name} is not UTF-8 text and can't be compared`);
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    type,
    label: connectionName && type !== "local" ? `${connectionName}:${name}` : name,
    connectionName,
    bytes: data.length,
    lines: splitLines(normalized).length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    text: normalized
  };
}

/** The tool's own top-level policy check can't see nested sides, so each side is checked here. */
async function enforceSidePolicy(ctx: McpContext, connectionName: string | undefined, resource: Record<string, string>) {
  const resolver = ctx as Partial<McpContext>;
  const policy = typeof resolver.resolvePolicy === "function"
    ? await resolver.resolvePolicy(connectionName)
    : typeof resolver.getPolicy === "function" ? resolver.getPolicy(connectionName) : undefined;
  if (!policy) return;
  const reason = checkResourcePolicy(policy, "ibmi.compare.text", resource);
  if (reason) throw new Error(`Blocked by policy: ibmi.compare.text (${reason})`);
}

function splitLines(text: string) {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type CompareOptions = {
  context: number;
  ignoreTrailingWhitespace: boolean;
  ignoreCase: boolean;
  maxDiffLines: number;
};

export function compareTexts(left: { label: string; text: string }, right: { label: string; text: string }, options: CompareOptions) {
  const prepare = (text: string) => {
    let lines = splitLines(text);
    if (options.ignoreTrailingWhitespace) lines = lines.map(line => line.replace(/[ \t]+$/, ""));
    // A missing final newline is not treated as a difference.
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  };
  const patch = structuredPatch(left.label, right.label, prepare(left.text), prepare(right.text), "", "", {
    context: options.context,
    ignoreCase: options.ignoreCase
  } as any);

  let added = 0;
  let removed = 0;
  const out: string[] = [`--- ${left.label}`, `+++ ${right.label}`];
  for (const hunk of patch.hunks) {
    out.push(`@@ -${rangeText(hunk.oldStart, hunk.oldLines)} +${rangeText(hunk.newStart, hunk.newLines)} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      out.push(line);
    }
  }
  const identical = patch.hunks.length === 0;
  const truncated = out.length > options.maxDiffLines;
  return {
    identical,
    stats: { hunks: patch.hunks.length, added, removed },
    truncated,
    diff: identical ? "" : (truncated ? out.slice(0, options.maxDiffLines) : out).join("\n")
  };
}

function rangeText(start: number, count: number) {
  return count === 1 ? String(start) : `${start},${count}`;
}

export const compareModule: ToolModule = { tools, handle };
