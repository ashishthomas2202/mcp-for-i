import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { makeAliasName } from "../../ibmi/sourceDates.js";
import { clampInteger, json, requireQsysName } from "../tools.js";

const DEFAULT_MAX_LINES = 500;
const HARD_MAX_LINES = 5000;
const DEFAULT_MAX_MEMBERS = 50;
const HARD_MAX_MEMBERS = 500;

/**
 * SRCDAT holds a two-digit year (YYMMDD). IBM i uses the 1940-2039 window
 * for two-digit years: 40-99 are 19xx and 00-39 are 20xx. A zero or blank
 * SRCDAT means the line has no date.
 */
export function srcdatToFullDate(value: number | string) {
  const digits = Number(value);
  if (!Number.isFinite(digits) || digits <= 0) return 0;
  return digits >= 400000 ? 19000000 + digits : 20000000 + digits;
}

export function fullDateToIso(value: number) {
  if (!value) return null;
  const text = String(value).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/** Accepts YYYY-MM-DD, YYYYMMDD or a six-digit SRCDAT-style YYMMDD. Returns YYYYMMDD as a number. */
export function parseDateArgument(value: unknown, label: string) {
  const raw = String(value ?? "").trim();
  let year: number;
  let month: number;
  let day: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)) || (match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw))) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{2})(\d{2})(\d{2})$/.exec(raw))) {
    const full = srcdatToFullDate(raw);
    [year, month, day] = [Math.floor(full / 10000), Number(match[2]), Number(match[3])];
  } else {
    throw new Error(`Invalid ${label}: ${raw || "(empty)"}. Use YYYY-MM-DD.`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid ${label}: ${raw} is not a real date`);
  }
  return year * 10000 + month * 100 + day;
}

function todayFullDate(now = new Date()) {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/** A member name, or a generic name using `*` (for example ORD* or *ALL). */
function memberPattern(value: unknown) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw || raw === "*ALL" || raw === "*") return { generic: true, like: "%" };
  if (!raw.includes("*")) return { generic: false, name: raw };
  if (!/^[A-Z0-9#@$._*]{1,10}$/.test(raw)) throw new Error(`Invalid member filter: ${value}`);
  const like = raw.replace(/_/g, "\\_").replace(/\*/g, "%");
  return { generic: true, like };
}

function quoteSql(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Source member date expression, matching how source dates are read elsewhere (blank SRCDAT is 0). */
const SRCDAT_EXPRESSION =
  "case when locate('40', hex(M.SRCDAT)) > 0 then 0 when M.SRCDAT = 0 then 0 " +
  "when M.SRCDAT >= 400000 then 19000000 + M.SRCDAT else 20000000 + M.SRCDAT end";

export function buildChangedLinesSql(library: string, sourceFile: string, member: string, from: number, to: number, limit: number) {
  const alias = `QTEMP."${makeAliasName(`${library}/${sourceFile}/${member}`)}"`;
  return (
    `create or replace alias ${alias} for "${library}"."${sourceFile}"("${member}");\n` +
    "select X.LINE_NUMBER, X.SRCSEQ, X.FULL_DATE, X.SRCDTA from (" +
    `select row_number() over (order by rrn(M)) as LINE_NUMBER, M.SRCSEQ, ${SRCDAT_EXPRESSION} as FULL_DATE, M.SRCDTA ` +
    `from ${alias} as M) as X where X.FULL_DATE between ${from} and ${to} ` +
    `order by X.LINE_NUMBER fetch first ${limit} rows only`
  );
}

async function changedLines(ctx: McpContext, args: any) {
  const conn = await ctx.ensureActive(args?.connectionName);
  const library = requireQsysName(conn, args?.library, "library");
  const sourceFile = requireQsysName(conn, args?.sourceFile, "sourceFile");
  const pattern = memberPattern(args?.member);
  const from = parseDateArgument(args?.from, "from");
  const to = args?.to === undefined || args?.to === null || args?.to === "" ? todayFullDate() : parseDateArgument(args.to, "to");
  if (to < from) throw new Error("to must not be before from");
  const maxLines = clampInteger(args?.maxLines, 1, HARD_MAX_LINES, DEFAULT_MAX_LINES);
  const maxMembers = clampInteger(args?.maxMembers, 1, HARD_MAX_MEMBERS, DEFAULT_MAX_MEMBERS);

  let members: string[];
  let membersTruncated = false;
  if (pattern.generic) {
    const memberType = args?.memberType ? String(args.memberType).trim().toUpperCase() : "";
    if (memberType && !/^[A-Z0-9]{1,10}$/.test(memberType)) throw new Error(`Invalid memberType: ${args.memberType}`);
    const rows = await conn.runSQL(
      "select SYSTEM_TABLE_MEMBER from QSYS2.SYSPARTITIONSTAT " +
      `where SYSTEM_TABLE_SCHEMA = ${quoteSql(library)} and SYSTEM_TABLE_NAME = ${quoteSql(sourceFile)} ` +
      (pattern.like !== "%" ? `and SYSTEM_TABLE_MEMBER like ${quoteSql(pattern.like!)} escape '\\' ` : "") +
      (memberType ? `and SOURCE_TYPE = ${quoteSql(memberType)} ` : "") +
      `order by SYSTEM_TABLE_MEMBER fetch first ${maxMembers + 1} rows only`
    );
    members = rows.map((row: any) => String(row.SYSTEM_TABLE_MEMBER ?? "").trim()).filter(Boolean);
    membersTruncated = members.length > maxMembers;
    members = members.slice(0, maxMembers).filter(name => conn.validQsysName(name));
  } else {
    members = [requireQsysName(conn, pattern.name, "member")];
  }

  const hits: Array<{ member: string; line: number; sequence: number | null; date: string | null; text: string }> = [];
  const errors: Array<{ member: string; error: string }> = [];
  let linesTruncated = false;
  let membersSearched = 0;
  for (const member of members) {
    const remaining = maxLines - hits.length;
    if (remaining <= 0) {
      linesTruncated = true;
      break;
    }
    let rows: any[];
    try {
      rows = await conn.runSQL(buildChangedLinesSql(library, sourceFile, member, from, to, remaining + 1));
    } catch (error: any) {
      if (!pattern.generic) throw error;
      errors.push({ member, error: error?.message || String(error) });
      continue;
    }
    membersSearched += 1;
    if (rows.length > remaining) linesTruncated = true;
    for (const row of rows.slice(0, remaining)) {
      const sequence = Number(row.SRCSEQ);
      hits.push({
        member,
        line: Number(row.LINE_NUMBER),
        sequence: Number.isFinite(sequence) ? sequence : null,
        date: fullDateToIso(Number(row.FULL_DATE)),
        text: String(row.SRCDTA ?? "").trimEnd()
      });
    }
  }

  const truncated = linesTruncated || membersTruncated;
  const reasons = [
    ...(linesTruncated ? [`Stopped at maxLines=${maxLines}.`] : []),
    ...(membersTruncated ? [`More than maxMembers=${maxMembers} members match; only the first ${maxMembers} were searched.`] : [])
  ];
  return json({
    library,
    sourceFile,
    member: pattern.generic ? String(args?.member || "*ALL").toUpperCase() : members[0],
    from: fullDateToIso(from),
    to: fullDateToIso(to),
    centuryRule: "SRCDAT years 40-99 are 1940-1999 and 00-39 are 2000-2039; lines with no date are never returned.",
    membersSearched,
    hits,
    returned: hits.length,
    truncated,
    ...(truncated ? { truncatedReason: reasons.join(" ") } : {}),
    ...(errors.length ? { errors } : {})
  });
}

export const changedLinesModule: ToolModule = {
  tools: [
    {
      name: "ibmi.search.changedLines",
      description:
        "Find source lines whose change date (SRCDAT) falls in a date range, in one member or in the members of a source file " +
        "matching a generic name (ORD*, *ALL). Returns member, line number, sequence, date and text. Read-only; results are capped.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string", description: "Saved IBM i connection name." },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string", description: "Member name, or a generic name with * (for example ORD*). Default *ALL." },
          memberType: { type: "string", description: "Only search members of this source type (generic member only)." },
          from: { type: "string", description: "Start date, inclusive (YYYY-MM-DD)." },
          to: { type: "string", description: "End date, inclusive (YYYY-MM-DD). Default today." },
          maxLines: { type: "number", description: `Maximum lines returned (default ${DEFAULT_MAX_LINES}, max ${HARD_MAX_LINES}).` },
          maxMembers: { type: "number", description: `Maximum members searched (default ${DEFAULT_MAX_MEMBERS}, max ${HARD_MAX_MEMBERS}).` }
        },
        required: ["library", "sourceFile", "from"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ],
  handle: async (ctx, name, args) => {
    if (name === "ibmi.search.changedLines") return changedLines(ctx, args);
    throw new Error(`Unknown tool: ${name}`);
  }
};
