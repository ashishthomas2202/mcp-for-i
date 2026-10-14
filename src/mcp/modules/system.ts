import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { clampInteger, json } from "../tools.js";

const SECTIONS = ["os", "ptfGroups", "authorities", "systemValues", "pase", "tools"] as const;
type Section = typeof SECTIONS[number];

/**
 * System values an agent may read through ibmi.system.info. Kept to values
 * that describe the system's behaviour; nothing here is a secret.
 */
export const SYSTEM_VALUE_ALLOW_LIST = [
  "QSECURITY", "QPWDLVL", "QALWOBJRST", "QAUDCTL", "QAUDLVL", "QCRTAUT", "QMAXSIGN", "QINACTITV",
  "QCCSID", "QCHRID", "QLANGID", "QCNTRYID", "QKBDTYPE", "QCURSYM",
  "QDATFMT", "QDATSEP", "QTIMSEP", "QDECFMT", "QTIMZON", "QUTCOFFSET", "QLEAPADJ",
  "QSYSLIBL", "QUSRLIBL", "QMODEL", "QPRCFEAT", "QSRLNBR", "QIPLTYPE", "QAUTOVRT", "QJOBMSGQFL"
];

/** Helper tools looked up in PASE: on PATH first, then in the IBM i open source location. */
const HELPER_TOOLS = ["pfgrep", "openssl", "git", "bash", "python3", "node", "java"];
const PASE_ENV_VARS = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TZ", "QIBM_CCSID", "QIBM_PASE_CCSID"];
const MAPEPIRE_PATHS = [
  "/QOpenSys/pkgs/bin/mapepire",
  "/QOpenSys/pkgs/lib/mapepire/mapepire-server.jar",
  "/opt/mapepire/bin/mapepire"
];

const PTF_GROUP_DEFAULT_LIMIT = 100;
const PTF_GROUP_MAX_LIMIT = 1000;

/** The single PASE script used for the `pase` and `tools` sections. It takes no user input. */
export function buildPaseProbeScript() {
  return [
    `printf 'uname=%s\\n' "$(uname -srv 2>/dev/null)"`,
    ...PASE_ENV_VARS.map(name => `printf 'env.${name}=%s\\n' "\${${name}:-}"`),
    `for t in ${HELPER_TOOLS.join(" ")}; do ` +
      `p=$(command -v "$t" 2>/dev/null); ` +
      `if [ -z "$p" ] && [ -x "/QOpenSys/pkgs/bin/$t" ]; then p="/QOpenSys/pkgs/bin/$t"; fi; ` +
      `printf 'tool.%s=%s\\n' "$t" "$p"; done`,
    `m=$(command -v mapepire 2>/dev/null); ` +
      `if [ -z "$m" ]; then for c in ${MAPEPIRE_PATHS.join(" ")}; do if [ -e "$c" ]; then m="$c"; break; fi; done; fi; ` +
      `printf 'tool.mapepire-server=%s\\n' "$m"`
  ].join("; ");
}

export function parsePaseProbe(stdout: string) {
  const env: Record<string, string | null> = {};
  const tools: Record<string, string | null> = {};
  let uname: string | null = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "uname") uname = value || null;
    else if (key.startsWith("env.")) env[key.slice(4)] = value || null;
    else if (key.startsWith("tool.")) tools[key.slice(5)] = value || null;
  }
  return { uname, env, tools };
}

function sqlList(values: string[]) {
  // Values come from the fixed allow-list above, never from the caller.
  return values.map(value => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function text(value: unknown) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" || str === "-" ? null : str;
}

function num(value: unknown) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function osSection(conn: any) {
  const rows = await conn.runSQL(
    "select OS_NAME, OS_VERSION, OS_RELEASE, HOST_NAME, TOTAL_CPUS, CONFIGURED_CPUS, TOTAL_MEMORY " +
    "from SYSIBMADM.ENV_SYS_INFO fetch first 1 row only"
  );
  const row = rows[0] || {};
  const version = String(row.OS_VERSION ?? "").replace(/\D/g, "");
  const release = String(row.OS_RELEASE ?? "").replace(/\D/g, "");
  const out: Record<string, unknown> = {
    osName: text(row.OS_NAME),
    release: version && release ? `${Number(version)}.${Number(release)}` : null,
    hostName: text(row.HOST_NAME),
    totalCpus: num(row.TOTAL_CPUS),
    configuredCpus: num(row.CONFIGURED_CPUS),
    totalMemoryMb: num(row.TOTAL_MEMORY)
  };
  try {
    const status = await conn.runSQL(
      "select PARTITION_ID, MAIN_STORAGE_SIZE, SYSTEM_ASP_STORAGE, SYSTEM_ASP_USED, TOTAL_JOBS_IN_SYSTEM, ELAPSED_CPU_USED " +
      "from QSYS2.SYSTEM_STATUS_INFO fetch first 1 row only"
    );
    const s = status[0] || {};
    out.status = {
      partitionId: num(s.PARTITION_ID),
      mainStorageKb: num(s.MAIN_STORAGE_SIZE),
      systemAspStorageMb: num(s.SYSTEM_ASP_STORAGE),
      systemAspUsedPercent: num(s.SYSTEM_ASP_USED),
      totalJobs: num(s.TOTAL_JOBS_IN_SYSTEM),
      elapsedCpuUsedPercent: num(s.ELAPSED_CPU_USED)
    };
  } catch (error: any) {
    out.statusError = error?.message || String(error);
  }
  return out;
}

async function ptfGroupsSection(conn: any, limit: number) {
  // One row per group: the newest level known and the newest level installed.
  const rows = await conn.runSQL(
    "with L as (select PTF_GROUP_NAME, max(PTF_GROUP_DESCRIPTION) as DESCRIPTION, " +
    "max(PTF_GROUP_LEVEL) as LATEST_LEVEL, " +
    "max(case when PTF_GROUP_STATUS = 'INSTALLED' then PTF_GROUP_LEVEL end) as INSTALLED_LEVEL " +
    "from QSYS2.GROUP_PTF_INFO group by PTF_GROUP_NAME) " +
    "select L.PTF_GROUP_NAME, L.DESCRIPTION, L.LATEST_LEVEL, L.INSTALLED_LEVEL, " +
    "(select max(G.PTF_GROUP_STATUS) from QSYS2.GROUP_PTF_INFO G where G.PTF_GROUP_NAME = L.PTF_GROUP_NAME " +
    "and G.PTF_GROUP_LEVEL = L.LATEST_LEVEL) as LATEST_STATUS " +
    `from L order by L.PTF_GROUP_NAME fetch first ${limit + 1} rows only`
  );
  const truncated = rows.length > limit;
  return {
    groups: rows.slice(0, limit).map((row: any) => ({
      group: text(row.PTF_GROUP_NAME),
      description: text(row.DESCRIPTION),
      latestLevel: num(row.LATEST_LEVEL),
      latestStatus: text(row.LATEST_STATUS),
      installedLevel: num(row.INSTALLED_LEVEL)
    })),
    returned: Math.min(rows.length, limit),
    truncated,
    ...(truncated ? { truncatedReason: `More than ${limit} PTF groups; raise ptfGroupLimit (max ${PTF_GROUP_MAX_LIMIT}).` } : {})
  };
}

async function authoritiesSection(conn: any) {
  const rows = await conn.runSQL(
    "select USER as RUNTIME_USER, SYSTEM_USER as SYSTEM_USER_NAME, U.USER_CLASS_NAME, U.SPECIAL_AUTHORITIES, " +
    "U.GROUP_PROFILE_NAME, U.SUPPLEMENTAL_GROUP_LIST, U.LIMIT_CAPABILITIES, U.STATUS " +
    "from QSYS2.USER_INFO U where U.AUTHORIZATION_NAME = USER fetch first 1 row only"
  );
  const row = rows[0];
  if (!row) return { user: null, specialAuthorities: [], note: "No QSYS2.USER_INFO row for the current user." };
  const split = (value: unknown) => String(value ?? "").split(/\s+/).map(item => item.trim()).filter(item => item && item !== "*NONE" && item !== "-");
  return {
    user: text(row.RUNTIME_USER),
    systemUser: text(row.SYSTEM_USER_NAME),
    userClass: text(row.USER_CLASS_NAME),
    specialAuthorities: split(row.SPECIAL_AUTHORITIES),
    groupProfile: text(row.GROUP_PROFILE_NAME),
    supplementalGroups: split(row.SUPPLEMENTAL_GROUP_LIST),
    limitCapabilities: text(row.LIMIT_CAPABILITIES),
    status: text(row.STATUS)
  };
}

async function systemValuesSection(conn: any, names: string[]) {
  const rows = await conn.runSQL(
    "select SYSTEM_VALUE_NAME, CURRENT_NUMERIC_VALUE, CURRENT_CHARACTER_VALUE from QSYS2.SYSTEM_VALUE_INFO " +
    `where SYSTEM_VALUE_NAME in (${sqlList(names)}) order by SYSTEM_VALUE_NAME`
  );
  const values: Record<string, string | number | null> = {};
  for (const row of rows) {
    const name = text(row.SYSTEM_VALUE_NAME);
    if (!name) continue;
    const character = text(row.CURRENT_CHARACTER_VALUE);
    values[name] = character !== null ? character : num(row.CURRENT_NUMERIC_VALUE);
  }
  const missing = names.filter(name => !(name in values));
  return { values, ...(missing.length ? { notReturned: missing } : {}) };
}

function resolveSections(value: unknown): Section[] {
  if (value === undefined || value === null) return [...SECTIONS];
  if (!Array.isArray(value) || value.length === 0) throw new Error("sections must be a non-empty array");
  const out: Section[] = [];
  for (const item of value) {
    const name = String(item) as Section;
    if (!SECTIONS.includes(name)) throw new Error(`Unknown section: ${item}. Use ${SECTIONS.join(", ")}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function resolveSystemValues(value: unknown) {
  if (value === undefined || value === null) return [...SYSTEM_VALUE_ALLOW_LIST];
  if (!Array.isArray(value) || value.length === 0) throw new Error("systemValues must be a non-empty array");
  const names = value.map(item => String(item).trim().toUpperCase());
  const blocked = names.filter(name => !SYSTEM_VALUE_ALLOW_LIST.includes(name));
  if (blocked.length) {
    throw new Error(`System value(s) not in the allow-list: ${blocked.join(", ")}. Allowed: ${SYSTEM_VALUE_ALLOW_LIST.join(", ")}`);
  }
  return [...new Set(names)];
}

async function systemInfo(ctx: McpContext, args: any) {
  const sections = resolveSections(args?.sections);
  const systemValues = resolveSystemValues(args?.systemValues);
  const ptfGroupLimit = clampInteger(args?.ptfGroupLimit, 1, PTF_GROUP_MAX_LIMIT, PTF_GROUP_DEFAULT_LIMIT);
  const conn = await ctx.ensureActive(args?.connectionName);
  const output: Record<string, unknown> = { sections };
  const errors: Record<string, string> = {};
  const run = async (section: Section, loader: () => Promise<unknown>) => {
    if (!sections.includes(section)) return;
    try {
      output[section] = await loader();
    } catch (error: any) {
      errors[section] = error?.message || String(error);
    }
  };
  await run("os", () => osSection(conn));
  await run("ptfGroups", () => ptfGroupsSection(conn, ptfGroupLimit));
  await run("authorities", () => authoritiesSection(conn));
  await run("systemValues", () => systemValuesSection(conn, systemValues));
  if (sections.includes("pase") || sections.includes("tools")) {
    try {
      const res = await conn.sendCommand({ command: buildPaseProbeScript() });
      if (!res || (res.code !== 0 && !String(res.stdout || "").trim())) {
        throw new Error(`PASE probe failed (exit ${res?.code ?? "unknown"})${res?.stderr ? `: ${String(res.stderr).trim()}` : ""}`);
      }
      const probe = parsePaseProbe(res.stdout);
      if (sections.includes("pase")) output.pase = { uname: probe.uname, env: probe.env };
      if (sections.includes("tools")) output.tools = probe.tools;
    } catch (error: any) {
      const message = error?.message || String(error);
      if (sections.includes("pase")) errors.pase = message;
      if (sections.includes("tools")) errors.tools = message;
    }
  }
  if (Object.keys(errors).length) output.errors = errors;
  return json(output);
}

export const systemModule: ToolModule = {
  tools: [
    {
      name: "ibmi.system.info",
      description:
        "Read-only summary of the IBM i system: OS release, PTF group levels, the current user's special authorities, " +
        "selected system values, PASE environment and which helper tools (pfgrep, openssl, git, bash, python3, node, java, " +
        "mapepire-server) are installed. Use sections to pick parts; a failing section is reported under errors.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string", description: "Saved IBM i connection name." },
          sections: {
            type: "array",
            items: { type: "string", enum: [...SECTIONS] },
            description: "Sections to return (default: all)."
          },
          systemValues: {
            type: "array",
            items: { type: "string" },
            description: `System values to read (default: all allowed). Allowed: ${SYSTEM_VALUE_ALLOW_LIST.join(", ")}.`
          },
          ptfGroupLimit: { type: "number", description: `Maximum PTF groups returned (default ${PTF_GROUP_DEFAULT_LIMIT}, max ${PTF_GROUP_MAX_LIMIT}).` }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ],
  handle: async (ctx, name, args) => {
    if (name === "ibmi.system.info") return systemInfo(ctx, args);
    throw new Error(`Unknown tool: ${name}`);
  }
};
