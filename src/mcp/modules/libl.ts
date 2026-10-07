import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { applyLibraryList, enforceWritable, getConnectionName, json, updateConnectionSettings } from "../tools.js";

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

async function storedLibraryList(ctx: McpContext, name: string, active: any) {
  const stored = await ctx.store.getConnection(name);
  if (!stored) throw new Error(`Connection ${name} not found`);
  let config: any = {};
  try {
    config = active.getConfig() || {};
  } catch {
    config = {};
  }
  const list: string[] = (stored.settings?.libraryList ?? config.libraryList ?? []).map((lib: string) => String(lib).toUpperCase());
  const currentLibrary: string | undefined = stored.settings?.currentLibrary ?? config.currentLibrary;
  return { stored, list, currentLibrary };
}

/** Returns a copy of `list` with `library` moved; positions are 1-based. */
export function moveLibrary(list: string[], library: string, options: { position?: number; direction?: string; steps?: number }) {
  const index = list.indexOf(library);
  if (index < 0) throw new Error(`${library} is not in the library list`);
  const hasPosition = options.position !== undefined && options.position !== null;
  if (hasPosition === Boolean(options.direction)) throw new Error("Give either position or direction");
  let target: number;
  if (hasPosition) {
    const position = Number(options.position);
    if (!Number.isInteger(position) || position < 1) throw new Error("position must be a whole number from 1");
    target = Math.min(position, list.length) - 1;
  } else {
    const steps = options.steps === undefined ? 1 : Number(options.steps);
    if (!Number.isInteger(steps) || steps < 1) throw new Error("steps must be a whole number from 1");
    switch (options.direction) {
      case "up": target = Math.max(0, index - steps); break;
      case "down": target = Math.min(list.length - 1, index + steps); break;
      case "top": target = 0; break;
      case "bottom": target = list.length - 1; break;
      default: throw new Error("direction must be up, down, top or bottom");
    }
  }
  const next = list.filter((_lib, i) => i !== index);
  next.splice(target, 0, library);
  return next;
}

function requireLibraryName(conn: any, value: unknown, label = "library") {
  const lib = String(value ?? "").trim().toUpperCase();
  if (!lib) throw new Error(`${label} is required`);
  if (!conn.validQsysName(lib)) throw new Error(`Invalid ${label}: ${lib}`);
  return lib;
}

async function move(ctx: McpContext, args: any) {
  const name = getConnectionName(ctx, args);
  const active = await ctx.ensureActive(name);
  const library = requireLibraryName(active, args?.library);
  const { list, currentLibrary } = await storedLibraryList(ctx, name, active);
  const next = moveLibrary(list, library, { position: args?.position, direction: args?.direction, steps: args?.steps });
  enforceWritable(ctx, active, "qsys.write", args);
  await updateConnectionSettings(ctx, name, { libraryList: next });
  const applied = args?.applyToJob ? await applyLibraryList(active, next, currentLibrary) : undefined;
  return json({
    library,
    from: list.indexOf(library) + 1,
    to: next.indexOf(library) + 1,
    libraryList: next,
    ...(applied?.warning ? { warning: applied.warning } : {})
  });
}

/** Libraries in `names` that exist, checked with QSYS2.OBJECT_STATISTICS. */
export async function existingLibraries(conn: any, names: string[]) {
  if (names.length === 0) return new Set<string>();
  const inList = names.map(lib => `'${lib.replace(/'/g, "''")}'`).join(", ");
  let rows: any[];
  try {
    rows = await conn.runSQL(
      `select OBJNAME from table(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB', '*ALLSIMPLE')) X where OBJNAME in (${inList})`
    );
  } catch {
    // Older releases do not know *ALLSIMPLE.
    rows = await conn.runSQL(`select OBJNAME from table(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB')) X where OBJNAME in (${inList})`);
  }
  return new Set(rows.map((row: any) => String(row.OBJNAME ?? "").trim().toUpperCase()));
}

async function prune(ctx: McpContext, args: any) {
  const name = getConnectionName(ctx, args);
  const active = await ctx.ensureActive(name);
  const { list, currentLibrary } = await storedLibraryList(ctx, name, active);
  const valid = list.filter(lib => active.validQsysName(lib));
  const invalidNames = list.filter(lib => !active.validQsysName(lib));
  const checkNames = [...new Set([...valid, ...(currentLibrary ? [String(currentLibrary).toUpperCase()] : [])])]
    .filter(lib => active.validQsysName(lib));
  const existing = await existingLibraries(active, checkNames);
  const removed = [...list.filter(lib => !existing.has(lib))];
  const kept = list.filter(lib => existing.has(lib));
  const currentLibraryMissing = Boolean(currentLibrary) && !existing.has(String(currentLibrary).toUpperCase());
  const dryRun = Boolean(args?.dryRun);
  let applied: { warning?: string } | undefined;
  if (!dryRun && removed.length > 0) {
    enforceWritable(ctx, active, "qsys.write", args);
    await updateConnectionSettings(ctx, name, { libraryList: kept });
    if (args?.applyToJob) applied = await applyLibraryList(active, kept, currentLibraryMissing ? undefined : currentLibrary);
  }
  return json({
    dryRun,
    removed,
    ...(invalidNames.length ? { invalidNames } : {}),
    libraryList: dryRun ? list : kept,
    ...(dryRun ? { wouldBecome: kept } : {}),
    currentLibrary: currentLibrary ?? null,
    ...(currentLibraryMissing ? { warning: `Current library ${currentLibrary} does not exist; it was left unchanged. Use ibmi.libl.setCurrent.` } : {}),
    ...(applied?.warning ? { applyWarning: applied.warning } : {})
  });
}

/** Parses QSYS2.LIBRARY_LIST_INFO rows into the user portion and the current library. */
export function libraryListFromRows(rows: any[]) {
  const libraryList: string[] = [];
  let currentLibrary: string | undefined;
  for (const row of rows) {
    const lib = String(row.SYSTEM_SCHEMA_NAME ?? "").trim().toUpperCase();
    const type = String(row.TYPE ?? "").trim().toUpperCase();
    if (!lib) continue;
    if (type === "USER" && !libraryList.includes(lib)) libraryList.push(lib);
    if (type === "CURRENT") currentLibrary = lib;
  }
  return { libraryList, currentLibrary };
}

async function runProfileCommand(ctx: McpContext, args: any) {
  const name = getConnectionName(ctx, args);
  const active = await ctx.ensureActive(name);
  const stored = await ctx.store.getConnection(name);
  if (!stored) throw new Error(`Connection ${name} not found`);
  const profileName = args?.profileName ? String(args.profileName) : stored.currentProfile;
  if (!profileName) throw new Error("No active profile; pass profileName or activate a profile first");
  const profile: any = (stored.profiles || []).find(item => item.name === profileName);
  if (!profile) throw new Error(`Profile ${profileName} not found`);
  const command = String(profile.setLibraryListCommand || "").trim();
  if (!command) throw new Error(`Profile ${profileName} has no setLibraryListCommand`);
  if (command.startsWith("?") || /[\r\n]/.test(command)) throw new Error("setLibraryListCommand must be a single CL command without prompting");

  // The command runs as CL, so CL command policy applies; storing the result is a settings write.
  enforceWritable(ctx, active, "cl.run", { ...args, command });
  enforceWritable(ctx, active, "qsys.write", args);

  // Run the command and read the resulting library list in the same database job.
  const rows = await active.runSQL(
    `CALL QSYS2.QCMDEXC('${command.replace(/'/g, "''")}');\n` +
    "select ORDINAL_POSITION, SYSTEM_SCHEMA_NAME, TYPE from QSYS2.LIBRARY_LIST_INFO order by ORDINAL_POSITION"
  );
  const { libraryList, currentLibrary } = libraryListFromRows(rows);
  if (libraryList.length === 0 && !currentLibrary) {
    throw new Error("The command ran but no library list could be read back from QSYS2.LIBRARY_LIST_INFO");
  }
  await updateConnectionSettings(ctx, name, { libraryList, currentLibrary });
  if (args?.saveToProfile) {
    await ctx.store.saveProfile(name, { ...profile, libraryList, ...(currentLibrary ? { currentLibrary } : {}) });
  }
  const applied = args?.applyToJob ? await applyLibraryList(active, libraryList, currentLibrary) : undefined;
  return json({
    profile: profileName,
    command,
    libraryList,
    currentLibrary: currentLibrary ?? null,
    savedToProfile: Boolean(args?.saveToProfile),
    ...(applied?.warning ? { warning: applied.warning } : {})
  });
}

const COMMON_PROPERTIES = {
  connectionName: { type: "string", description: "Saved IBM i connection name." },
  applyToJob: { type: "boolean", default: false, description: "Also run CHGLIBL/CHGCURLIB now." },
  approve: { type: "boolean", description: "Set true to approve guarded-policy operations." }
};

export const liblModule: ToolModule = {
  tools: [
    {
      name: "ibmi.libl.move",
      description: "Move a library within the connection's library list: to a 1-based position, or up/down by steps, or to the top/bottom.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          library: { type: "string" },
          position: { type: "number", description: "New 1-based position." },
          direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
          steps: { type: "number", description: "How far to move up or down (default 1)." }
        },
        required: ["library"],
        additionalProperties: false
      },
      annotations: WRITE_ANNOTATIONS
    },
    {
      name: "ibmi.libl.prune",
      description: "Remove libraries that no longer exist from the connection's library list (checked with QSYS2.OBJECT_STATISTICS). dryRun only reports.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          dryRun: { type: "boolean", default: false }
        },
        additionalProperties: false
      },
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true }
    },
    {
      name: "ibmi.libl.runProfileCommand",
      description:
        "Run a profile's setLibraryListCommand (the active profile by default) and store the resulting library list and current " +
        "library in the connection settings. The command runs as CL, so CL command policy applies.",
      inputSchema: {
        type: "object",
        properties: {
          ...COMMON_PROPERTIES,
          profileName: { type: "string", description: "Profile to use (default: the active profile)." },
          saveToProfile: { type: "boolean", default: false, description: "Also save the result into the profile." }
        },
        additionalProperties: false
      },
      annotations: WRITE_ANNOTATIONS
    }
  ],
  handle: async (ctx, name, args) => {
    switch (name) {
      case "ibmi.libl.move": return move(ctx, args);
      case "ibmi.libl.prune": return prune(ctx, args);
      case "ibmi.libl.runProfileCommand": return runProfileCommand(ctx, args);
    }
    throw new Error(`Unknown tool: ${name}`);
  }
};
