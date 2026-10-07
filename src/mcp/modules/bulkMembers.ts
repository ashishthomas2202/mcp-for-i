import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { Tools } from "../../ibmi/Tools.js";
import { checkLibrary } from "../policy.js";
import { clampNumber, enforceWritable, guardLocalPath, json, jsonError } from "../tools.js";

/**
 * Bulk source member download/upload between a library's source files and a
 * local LIB/FILE/MEMBER.ext tree. A manifest in the tree root records each
 * member's version and SHA-256 at download time, so uploads only send members
 * edited locally and refuse to overwrite members that changed on the IBM i
 * since they were downloaded (unless force is true).
 */

export const MEMBER_MANIFEST_NAME = ".mcp-for-i-members.json";
const MANIFEST_FORMAT = "mcp-for-i-members";
const DEFAULT_MAX_MEMBERS = 500;
const HARD_MAX_MEMBERS = 5000;

type ManifestEntry = {
  library: string;
  sourceFile: string;
  member: string;
  sourceType: string;
  text?: string;
  path: string;
  sha256: string;
  version: string;
  lastChanged?: string;
  syncedAt: string;
};

type Manifest = {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  connectionName?: string;
  updatedAt: string;
  members: Record<string, ManifestEntry>;
};

const ANNOTATIONS_DOWNLOAD = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ANNOTATIONS_UPLOAD = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const bulkMembersModule: ToolModule = {
  tools: [
    {
      name: "ibmi.members.downloadAll",
      description:
        "Download every member of a source file (or of all source files in a library) to a local LIB/FILE/MEMBER.ext tree. " +
        "The extension is the lowercased member type. Writes a manifest (" + MEMBER_MANIFEST_NAME + ") with each member's version " +
        "and SHA-256 so ibmi.members.uploadChanged can detect conflicts. Local files edited since the last download are kept unless overwrite is true.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          localPath: { type: "string", description: "Local root directory of the LIB/FILE/MEMBER.ext tree." },
          library: { type: "string" },
          sourceFile: { type: "string", description: "One source file. Omit to download all source files in the library." },
          sourceFiles: { type: "array", items: { type: "string" }, description: "Several source files." },
          memberPrefix: { type: "string" },
          sourceTypes: { type: "array", items: { type: "string" } },
          maxMembers: { type: "number", default: DEFAULT_MAX_MEMBERS, description: `Member cap (1-${HARD_MAX_MEMBERS}).` },
          overwrite: { type: "boolean", default: false, description: "Replace local files that were edited since the last download." }
        },
        required: ["localPath", "library"],
        additionalProperties: false
      },
      annotations: ANNOTATIONS_DOWNLOAD
    },
    {
      name: "ibmi.members.uploadChanged",
      description:
        "Upload members from a local LIB/FILE/MEMBER.ext tree (as written by ibmi.members.downloadAll) that changed locally since download. " +
        "Unchanged files are skipped without contacting the IBM i. A member that changed on the IBM i since download (or has no manifest entry " +
        "and differs) is refused as a conflict unless force is true. Missing members are created with SRCTYPE from the manifest or file extension.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          localPath: { type: "string", description: "Local root directory of the LIB/FILE/MEMBER.ext tree." },
          library: { type: "string", description: "Only upload members of this library." },
          sourceFile: { type: "string", description: "Only upload members of this source file." },
          members: { type: "array", items: { type: "string" }, description: "Only upload these member names." },
          force: { type: "boolean", default: false, description: "Overwrite members that changed on the IBM i since download." },
          createMissing: { type: "boolean", default: true },
          dryRun: { type: "boolean", default: false },
          maxMembers: { type: "number", default: DEFAULT_MAX_MEMBERS, description: `Cap on members uploaded (1-${HARD_MAX_MEMBERS}).` },
          approve: { type: "boolean" }
        },
        required: ["localPath"],
        additionalProperties: false
      },
      annotations: ANNOTATIONS_UPLOAD
    }
  ],
  async handle(ctx: McpContext, name: string, args: any) {
    switch (name) {
      case "ibmi.members.downloadAll":
        return downloadAll(ctx, args || {});
      case "ibmi.members.uploadChanged":
        return uploadChanged(ctx, args || {});
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
};

function qsysName(conn: any, value: unknown, label: string) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) throw new Error(`${label} is required`);
  if (!conn.validQsysName(raw)) throw new Error(`Invalid ${label}: ${value}`);
  return raw;
}

export function extensionForSourceType(sourceType: unknown) {
  const ext = String(sourceType ?? "").trim().toLowerCase();
  return /^[a-z0-9#@$_]{1,10}$/.test(ext) ? ext : "mbr";
}

export function sourceTypeForExtension(ext: string) {
  const type = String(ext || "").trim().toUpperCase();
  if (!type || type === "MBR") return undefined;
  return /^[A-Z0-9#@$_]{1,10}$/.test(type) ? type : undefined;
}

function normalizeContent(content: string) {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function memberKey(library: string, sourceFile: string, member: string) {
  return `${library}/${sourceFile}/${member}`;
}

function emptyManifest(connectionName?: string): Manifest {
  return { format: MANIFEST_FORMAT, version: 1, connectionName, updatedAt: new Date().toISOString(), members: {} };
}

async function readManifest(ctx: McpContext, root: string): Promise<{ manifest: Manifest; existed: boolean }> {
  const manifestPath = await guardLocalPath(ctx, path.join(root, MEMBER_MANIFEST_NAME), "read");
  let text: string;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { manifest: emptyManifest(), existed: false };
    throw err;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Member manifest ${manifestPath} is not valid JSON`);
  }
  if (parsed?.format !== MANIFEST_FORMAT || typeof parsed?.members !== "object" || parsed.members === null) {
    throw new Error(`Member manifest ${manifestPath} has an unknown format`);
  }
  return { manifest: parsed as Manifest, existed: true };
}

async function writeManifest(ctx: McpContext, root: string, manifest: Manifest) {
  const manifestPath = await guardLocalPath(ctx, path.join(root, MEMBER_MANIFEST_NAME), "write");
  manifest.updatedAt = new Date().toISOString();
  const sorted: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(manifest.members).sort()) sorted[key] = manifest.members[key];
  manifest.members = sorted;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function readLocalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

async function listSourceFiles(conn: any, library: string): Promise<string[]> {
  const rows = await conn.runSQL(
    `select SYSTEM_TABLE_NAME from QSYS2.SYSTABLES where SYSTEM_TABLE_SCHEMA=${Tools.sqlString(library)} ` +
    `and FILE_TYPE='S' order by SYSTEM_TABLE_NAME`
  );
  return rows
    .map((row: any) => String(row?.SYSTEM_TABLE_NAME || "").trim().toUpperCase())
    .filter((name: string) => name && conn.validQsysName(name));
}

function entryFromSnapshot(snapshot: any, sourceType: string, text: string | undefined, relPath: string): ManifestEntry {
  return {
    library: snapshot.identity.library,
    sourceFile: snapshot.identity.sourceFile,
    member: snapshot.identity.member,
    sourceType,
    ...(text ? { text } : {}),
    path: relPath,
    sha256: snapshot.sha256,
    version: snapshot.version,
    ...(snapshot.metadata?.lastChanged ? { lastChanged: snapshot.metadata.lastChanged } : {}),
    syncedAt: new Date().toISOString()
  };
}

async function downloadAll(ctx: McpContext, args: any) {
  const conn = await ctx.ensureActive(args.connectionName);
  const library = qsysName(conn, args.library, "library");
  const root = await guardLocalPath(ctx, args.localPath, "write");
  const maxMembers = clampNumber(args.maxMembers, DEFAULT_MAX_MEMBERS, 1, HARD_MAX_MEMBERS);
  const overwrite = Boolean(args.overwrite);

  let sourceFiles: string[];
  if (args.sourceFile) sourceFiles = [qsysName(conn, args.sourceFile, "sourceFile")];
  else if (Array.isArray(args.sourceFiles) && args.sourceFiles.length > 0) {
    sourceFiles = Array.from(new Set<string>(args.sourceFiles.map((value: unknown) => qsysName(conn, value, "sourceFile"))));
  } else sourceFiles = await listSourceFiles(conn, library);

  // Collect the member list first so the cap applies across all files.
  const members: Array<{ sourceFile: string; name: string; sourceType: string; text: string }> = [];
  let truncated = false;
  for (const sourceFile of sourceFiles) {
    let cursor: string | undefined;
    do {
      const page = await conn.content.getMemberListPage({
        library,
        sourceFile,
        memberPrefix: args.memberPrefix,
        sourceTypes: args.sourceTypes,
        limit: 500,
        cursor
      });
      for (const item of page.items || []) {
        if (members.length >= maxMembers) {
          truncated = true;
          break;
        }
        members.push({ sourceFile, name: String(item.name).toUpperCase(), sourceType: String(item.extension || ""), text: String(item.text || "") });
      }
      cursor = !truncated && page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
    if (truncated) break;
  }

  const { manifest } = await readManifest(ctx, root);
  manifest.connectionName = conn.currentConnectionName || args.connectionName || manifest.connectionName;

  const downloaded: string[] = [];
  const unchanged: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const failed: Array<{ member: string; message: string }> = [];

  for (const item of members) {
    const key = memberKey(library, item.sourceFile, item.name);
    const relPath = `${library}/${item.sourceFile}/${item.name}.${extensionForSourceType(item.sourceType)}`;
    try {
      const target = await guardLocalPath(ctx, path.join(root, ...relPath.split("/")), "write");
      const snapshot = await conn.content.getMemberSnapshot(library, item.sourceFile, item.name, true);
      const existing = await readLocalText(target);
      const prior = manifest.members[key];
      if (existing !== undefined) {
        const localSha = sha256(normalizeContent(existing));
        if (localSha === snapshot.sha256) {
          manifest.members[key] = entryFromSnapshot(snapshot, item.sourceType, item.text, relPath);
          unchanged.push(relPath);
          continue;
        }
        const editedLocally = prior ? localSha !== prior.sha256 : true;
        if (editedLocally && !overwrite) {
          skipped.push({ path: relPath, reason: prior ? "local file edited since last download" : "local file exists and is not in the manifest" });
          continue;
        }
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, snapshot.content, "utf8");
      manifest.members[key] = entryFromSnapshot(snapshot, item.sourceType, item.text, relPath);
      downloaded.push(relPath);
    } catch (err: any) {
      failed.push({ member: key, message: err?.message || String(err) });
    }
  }

  const manifestPath = await writeManifest(ctx, root, manifest);
  const payload = {
    ok: failed.length === 0,
    localRoot: root,
    library,
    sourceFiles,
    manifestPath,
    truncated,
    ...(truncated ? { hint: `Stopped at maxMembers=${maxMembers}; narrow with sourceFile/memberPrefix or raise maxMembers.` } : {}),
    summary: {
      members: members.length,
      downloaded: downloaded.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      failed: failed.length
    },
    downloaded,
    unchanged,
    skipped,
    failed
  };
  if (failed.length > 0) return jsonError(`members.downloadAll finished with ${failed.length} failed member(s)`, payload);
  return json(payload);
}

type LocalMember = { library: string; sourceFile: string; member: string; ext: string; relPath: string; fullPath: string };

async function walkMemberTree(conn: any, root: string, skipped: Array<{ path: string; reason: string }>): Promise<LocalMember[]> {
  const out: LocalMember[] = [];
  const dirents = async (dir: string) => (await fs.readdir(dir, { withFileTypes: true })).filter(entry => !entry.name.startsWith("."));
  for (const libEntry of await dirents(root)) {
    if (!libEntry.isDirectory()) continue;
    const library = libEntry.name.toUpperCase();
    if (!conn.validQsysName(library)) {
      skipped.push({ path: libEntry.name, reason: "directory name is not a valid library name" });
      continue;
    }
    for (const fileEntry of await dirents(path.join(root, libEntry.name))) {
      if (!fileEntry.isDirectory()) continue;
      const sourceFile = fileEntry.name.toUpperCase();
      const fileDir = `${libEntry.name}/${fileEntry.name}`;
      if (!conn.validQsysName(sourceFile)) {
        skipped.push({ path: fileDir, reason: "directory name is not a valid source file name" });
        continue;
      }
      for (const memberEntry of await dirents(path.join(root, libEntry.name, fileEntry.name))) {
        if (!memberEntry.isFile()) continue;
        const relPath = `${fileDir}/${memberEntry.name}`;
        const dot = memberEntry.name.lastIndexOf(".");
        const member = (dot > 0 ? memberEntry.name.substring(0, dot) : memberEntry.name).toUpperCase();
        const ext = dot > 0 ? memberEntry.name.substring(dot + 1) : "";
        if (!conn.validQsysName(member)) {
          skipped.push({ path: relPath, reason: "file name is not a valid member name" });
          continue;
        }
        out.push({ library, sourceFile, member, ext, relPath, fullPath: path.join(root, libEntry.name, fileEntry.name, memberEntry.name) });
      }
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function uploadChanged(ctx: McpContext, args: any) {
  const conn = await ctx.ensureActive(args.connectionName);
  const root = await guardLocalPath(ctx, args.localPath, "read");
  const dryRun = Boolean(args.dryRun);
  const force = Boolean(args.force);
  const createMissing = args.createMissing !== false;
  const maxMembers = clampNumber(args.maxMembers, DEFAULT_MAX_MEMBERS, 1, HARD_MAX_MEMBERS);
  const libraryFilter = args.library ? qsysName(conn, args.library, "library") : undefined;
  const fileFilter = args.sourceFile ? qsysName(conn, args.sourceFile, "sourceFile") : undefined;
  const memberFilter = Array.isArray(args.members) && args.members.length > 0
    ? new Set<string>(args.members.map((value: unknown) => qsysName(conn, value, "member")))
    : undefined;
  if (!dryRun) enforceWritable(ctx, conn, "qsys.write", args);

  const { manifest, existed: manifestExisted } = await readManifest(ctx, root);
  const skipped: Array<{ path: string; reason: string }> = [];
  const candidates = (await walkMemberTree(conn, root, skipped)).filter(item =>
    (!libraryFilter || item.library === libraryFilter) &&
    (!fileFilter || item.sourceFile === fileFilter) &&
    (!memberFilter || memberFilter.has(item.member))
  );

  const policy = ctx.getPolicy(args.connectionName);
  const deniedLibraries = new Map<string, string>();
  for (const library of new Set(candidates.map(item => item.library))) {
    const reason = checkLibrary(policy, library);
    if (reason) deniedLibraries.set(library, reason);
  }

  const unchanged: string[] = [];
  const inSync: string[] = [];
  const conflicts: Array<{ path: string; reason: string; expectedVersion?: string; actualVersion?: string }> = [];
  const planned: Array<{ path: string; action: "update" | "create"; sourceType?: string }> = [];
  const uploaded: Array<{ path: string; action: "update" | "create"; version?: string }> = [];
  const failed: Array<{ path: string; message: string }> = [];
  let truncated = false;

  for (const item of candidates) {
    const key = memberKey(item.library, item.sourceFile, item.member);
    const denied = deniedLibraries.get(item.library);
    if (denied) {
      skipped.push({ path: item.relPath, reason: `blocked by policy: ${denied}` });
      continue;
    }
    try {
      const localFile = await guardLocalPath(ctx, item.fullPath, "read");
      const content = normalizeContent(await fs.readFile(localFile, "utf8"));
      const localSha = sha256(content);
      const entry = manifest.members[key];
      if (entry && entry.sha256 === localSha) {
        unchanged.push(item.relPath);
        continue;
      }

      const metadata = await conn.content.getMemberMetadata(item.library, item.sourceFile, item.member);
      let action: "update" | "create";
      const sourceType = entry?.sourceType || sourceTypeForExtension(item.ext);
      if (!metadata) {
        if (!createMissing) {
          skipped.push({ path: item.relPath, reason: "member does not exist on the IBM i (createMissing is false)" });
          continue;
        }
        action = "create";
      } else {
        action = "update";
        // Same last-change timestamp as at download means the remote member
        // is unchanged; otherwise compare content hashes.
        const remoteUnchanged = Boolean(entry?.lastChanged && metadata.lastChanged && entry.lastChanged === metadata.lastChanged);
        if (!remoteUnchanged) {
          const snapshot = await conn.content.getMemberSnapshot(item.library, item.sourceFile, item.member, true);
          if (snapshot.sha256 === localSha) {
            manifest.members[key] = entryFromSnapshot(snapshot, metadata.extension || sourceType || "", metadata.text, item.relPath);
            inSync.push(item.relPath);
            continue;
          }
          const remoteChanged = entry ? snapshot.sha256 !== entry.sha256 : true;
          if (remoteChanged && !force) {
            conflicts.push({
              path: item.relPath,
              reason: entry ? "member changed on the IBM i since download" : "member exists on the IBM i but is not in the manifest",
              ...(entry ? { expectedVersion: entry.version } : {}),
              actualVersion: snapshot.version
            });
            continue;
          }
        }
      }

      if (planned.length >= maxMembers) {
        truncated = true;
        break;
      }
      planned.push({ path: item.relPath, action, ...(action === "create" ? { sourceType: sourceType || "*NONE" } : {}) });
      if (dryRun) continue;

      if (action === "create") {
        await conn.content.createMember(item.library, item.sourceFile, item.member, sourceType);
      }
      try {
        await conn.content.uploadMemberContent(item.library, item.sourceFile, item.member, content);
      } finally {
        conn.content.invalidateMemberSnapshot?.(item.library, item.sourceFile, item.member);
      }
      let version: string | undefined;
      try {
        const after = await conn.content.getMemberSnapshot(item.library, item.sourceFile, item.member, true);
        manifest.members[key] = entryFromSnapshot(after, metadata?.extension || sourceType || "", metadata?.text || entry?.text, item.relPath);
        version = after.version;
      } catch {
        // The upload worked; record the local hash so the next run treats it as unchanged.
        manifest.members[key] = {
          library: item.library,
          sourceFile: item.sourceFile,
          member: item.member,
          sourceType: metadata?.extension || sourceType || "",
          path: item.relPath,
          sha256: localSha,
          version: `unknown:${localSha.slice(0, 16)}`,
          syncedAt: new Date().toISOString()
        };
      }
      uploaded.push({ path: item.relPath, action, ...(version ? { version } : {}) });
    } catch (err: any) {
      failed.push({ path: item.relPath, message: err?.message || String(err) });
    }
  }

  let manifestPath: string | undefined;
  if (!dryRun && (uploaded.length > 0 || inSync.length > 0)) {
    manifest.connectionName = conn.currentConnectionName || args.connectionName || manifest.connectionName;
    manifestPath = await writeManifest(ctx, root, manifest);
  }

  const payload = {
    ok: failed.length === 0 && conflicts.length === 0,
    localRoot: root,
    dryRun,
    force,
    manifestFound: manifestExisted,
    ...(manifestPath ? { manifestPath } : {}),
    truncated,
    summary: {
      candidates: candidates.length,
      planned: planned.length,
      uploaded: uploaded.length,
      unchanged: unchanged.length,
      alreadyInSync: inSync.length,
      conflicts: conflicts.length,
      skipped: skipped.length,
      failed: failed.length
    },
    planned,
    uploaded,
    conflicts,
    skipped,
    failed,
    unchanged,
    alreadyInSync: inSync
  };
  if (failed.length > 0 || conflicts.length > 0) {
    const parts = [
      failed.length > 0 ? `${failed.length} failed` : "",
      conflicts.length > 0 ? `${conflicts.length} conflict(s); re-download or pass force:true to overwrite` : ""
    ].filter(Boolean);
    return jsonError(`members.uploadChanged: ${parts.join(", ")}`, payload);
  }
  return json(payload);
}
