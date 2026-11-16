import { ConnectionPolicy } from "../config/store.js";
import { extractEmbeddedClCommands, splitSqlStatements, SqlToken } from "../ibmi/sqlParse.js";
import { collectPolicyResources, normalizeClCommandName } from "./policy.js";

/**
 * Approval decisions for approvalMode "host": the MCP client runs its own
 * approval layer, so routine guarded operations run without a prompt and only
 * critical ones ask the person. The functions here are pure: they read the
 * policy, the operation and the tool arguments and say whether the operation
 * is critical, why, and which libraries it writes to.
 */

/** Operations that always ask the person in host mode. */
export const DEFAULT_ALWAYS_CONFIRM = [
  "shell.run",
  "ifs.delete",
  "audit.purge",
  "journal.receivers.delete",
  "deploy.sync",
  "members.delete",
  "members.rename",
  "objects.delete",
  "objects.move",
  "objects.rename",
  "qsys.deleteLibrary",
  "jobs.end",
  "subsystems.end",
  "spool.delete",
  "spool.move",
  "journal.end",
  "debug.end",
  "dataqueue.remove"
];

/**
 * CL commands that ask the person in host mode. A trailing `*` is generic;
 * an entry starting with `!` is an exception that keeps a command routine.
 */
export const DEFAULT_CONFIRM_CL_COMMANDS = [
  "DLT*", "CLR*", "RMV*", "RNM*", "MOV*", "END*", "RST*",
  "PWRDWNSYS", "RCLSTG", "INZSYS",
  "CRTUSRPRF", "CHGUSRPRF", "CHGUSRAUD", "CHGOBJAUD",
  "GRTOBJAUT", "RVKOBJAUT", "GRTUSRAUT", "CHGOBJOWN", "CHGAUT", "CHGOWN", "CHGPGP",
  "CHGSYSVAL", "CHGNETA", "CHGTCPA", "CHGIPLA",
  "RUNSQLSTM",
  "!RMVLIBLE", "!DLTOVR", "!ENDDBG"
];

/** SQL statements that ask the person in host mode, by their leading keywords. */
export const DEFAULT_CONFIRM_SQL_VERBS = [
  "DELETE", "TRUNCATE", "DROP TABLE", "DROP SCHEMA", "DROP COLLECTION",
  "ALTER", "GRANT", "REVOKE", "CALL", "RENAME"
];

/**
 * Tool operations that are more specific than the operation the policy lists
 * (requireApprovalFor, session approvals, the prompt text) know them by. In
 * "prompt" and "agent" mode the base name is used, so those modes behave as
 * before; host mode and the prompt metadata use the specific name.
 */
export const OPERATION_BASE: Record<string, string> = {
  "members.delete": "qsys.write",
  "members.rename": "qsys.write",
  "objects.delete": "qsys.write",
  "objects.move": "qsys.write",
  "objects.rename": "qsys.write",
  "qsys.deleteLibrary": "qsys.write",
  "jobs.end": "qsys.write",
  // A job this server submitted itself. Not in DEFAULT_ALWAYS_CONFIRM: stopping your own test job is routine.
  "jobs.endOwn": "qsys.write",
  "subsystems.end": "qsys.write",
  "spool.delete": "qsys.write",
  "spool.move": "qsys.write",
  "journal.end": "qsys.write",
  "debug.end": "qsys.write",
  "dataqueue.remove": "qsys.write"
};

export function baseOperation(operation: string) {
  return OPERATION_BASE[operation] || operation;
}

/** qsys.write tools that change the job, a session setting or a system service, not objects in a library. */
const NON_LIBRARY_TOOLS = new Set([
  "ibmi.libl.set",
  "ibmi.libl.add",
  "ibmi.libl.remove",
  "ibmi.libl.setCurrent",
  "ibmi.libl.move",
  "ibmi.libl.prune",
  "ibmi.libl.runProfileCommand",
  "ibmi.profiles.activate",
  "ibmi.spool.hold",
  "ibmi.spool.release",
  "ibmi.jobs.hold",
  "ibmi.jobs.release",
  "ibmi.subsystems.start",
  "ibmi.msgq.send",
  "ibmi.msgq.reply",
  "ibmi.debug.startService",
  // The expanded command is checked when it is known (actionCommandGuard).
  "ibmi.actions.run"
]);

/** Copy tools: only the destination is written. */
const COPY_TARGETS: Record<string, (args: any) => unknown[]> = {
  "ibmi.objects.copy": args => [args?.toLibrary || args?.library],
  "ibmi.qsys.members.copy": args => [args?.toLibrary || args?.library],
  "ibmi.libraries.copy": args => [args?.toLibrary]
};

export type HostDecision = {
  critical: boolean;
  /** One short sentence: why the person is asked, or why it runs without asking. */
  reason: string;
  /** Libraries the operation writes to, upper case. */
  libraries: string[];
};

export type HostDecisionInput = {
  policy: ConnectionPolicy;
  /** The specific operation, e.g. "members.delete" or "cl.run". */
  operation: string;
  toolName?: string;
  args: any;
  /** The connection's current library, for *CURLIB and CRT* defaults. */
  currentLibrary?: string;
  /** True when the arguments run shell text (isShellOperation). */
  shell: boolean;
};

export function alwaysConfirmList(policy: ConnectionPolicy) {
  return Array.isArray(policy.alwaysConfirm) ? policy.alwaysConfirm : DEFAULT_ALWAYS_CONFIRM;
}

export function confirmClCommandList(policy: ConnectionPolicy) {
  return Array.isArray(policy.confirmClCommands) ? policy.confirmClCommands : DEFAULT_CONFIRM_CL_COMMANDS;
}

export function confirmSqlVerbList(policy: ConnectionPolicy) {
  return Array.isArray(policy.confirmSqlVerbs) ? policy.confirmSqlVerbs : DEFAULT_CONFIRM_SQL_VERBS;
}

/** Decide whether an operation needs the person in host mode. */
export function classifyHostOperation(input: HostDecisionInput): HostDecision {
  const { policy, operation, toolName, args } = input;
  const libraries = new Set<string>();
  const critical = (reason: string): HostDecision => ({ critical: true, reason, libraries: [...libraries] });

  const always = alwaysConfirmList(policy).map(entry => String(entry).trim().toLowerCase());
  const isAlways = (op: string) => always.includes(op.toLowerCase());

  if (input.shell) {
    if (isAlways("shell.run")) return critical("Shell commands always ask the person.");
  } else if (isAlways(operation)) {
    return critical(`${operation} is in alwaysConfirm.`);
  } else if (operation !== baseOperation(operation) && isAlways(baseOperation(operation))) {
    return critical(`${baseOperation(operation)} is in alwaysConfirm.`);
  }

  const targets: LibraryTargets = { libraries: [], unknown: false };
  const currentLibrary = String(input.currentLibrary || "").trim().toUpperCase() || undefined;

  if (!input.shell && typeof args?.command === "string" && args.command.trim() && (operation === "cl.run" || toolName === "ibmi.actions.run")) {
    const result = classifyClText(policy, args.command, currentLibrary);
    for (const lib of result.targets.libraries) libraries.add(lib);
    if (result.critical) return critical(result.critical);
    mergeTargets(targets, result.targets);
  } else if (typeof args?.sql === "string" && operation === "sql.write") {
    const result = classifySql(policy, args.sql, currentLibrary);
    for (const lib of result.targets.libraries) libraries.add(lib);
    if (result.critical) return critical(result.critical);
    mergeTargets(targets, result.targets);
  } else if (isLibraryScoped(operation, toolName)) {
    mergeTargets(targets, toolTargets(toolName, args, currentLibrary));
    for (const lib of targets.libraries) libraries.add(lib);
  } else {
    return { critical: false, reason: routineReason(operation), libraries: [] };
  }

  const trusted = trustedLibraryList(policy);
  if (trusted) {
    const outside = targets.libraries.filter(lib => !trusted.some(entry => genericMatch(lib, entry)));
    if (outside.length > 0) return critical(`It writes to ${outside.join(", ")}, outside trustedLibraries.`);
    if (targets.unknown) {
      return critical("Its target library cannot be determined, so it cannot be checked against trustedLibraries.");
    }
  }
  return { critical: false, reason: routineReason(operation), libraries: [...libraries] };
}

function routineReason(operation: string) {
  return `${operation} is routine: the client approves it.`;
}

/** trustedLibraries as upper-case entries, or undefined when the list is not set. */
function trustedLibraryList(policy: ConnectionPolicy): string[] | undefined {
  if (!Array.isArray(policy.trustedLibraries)) return undefined;
  return policy.trustedLibraries.map(entry => String(entry || "").trim().toUpperCase()).filter(Boolean);
}

function isLibraryScoped(operation: string, toolName?: string) {
  if (operation !== "qsys.write") return false;
  return !(toolName && NON_LIBRARY_TOOLS.has(toolName));
}

type LibraryTargets = { libraries: string[]; unknown: boolean };

function mergeTargets(into: LibraryTargets, from: LibraryTargets) {
  for (const lib of from.libraries) if (!into.libraries.includes(lib)) into.libraries.push(lib);
  if (from.unknown) into.unknown = true;
}

/** Libraries a library-scoped tool call writes to, from its arguments. */
function toolTargets(toolName: string | undefined, args: any, currentLibrary?: string): LibraryTargets {
  const raw = toolName && COPY_TARGETS[toolName]
    ? COPY_TARGETS[toolName](args)
    : collectPolicyResources(toolName || "", args).libraries;
  const out: LibraryTargets = { libraries: [], unknown: raw.length === 0 };
  for (const value of raw) addLibrary(out, value, currentLibrary);
  return out;
}

function addLibrary(out: LibraryTargets, value: unknown, currentLibrary?: string) {
  const name = String(value ?? "").trim().toUpperCase();
  if (!name) {
    out.unknown = true;
    return;
  }
  const resolved = name === "*CURLIB" ? currentLibrary : name;
  if (!resolved || resolved.startsWith("*") || resolved.includes("*")) {
    out.unknown = true;
    return;
  }
  if (!out.libraries.includes(resolved)) out.libraries.push(resolved);
}

function genericMatch(value: string, pattern: string) {
  if (!pattern) return false;
  if (pattern === "*" || pattern === "*ALL") return true;
  if (pattern.endsWith("*") && !pattern.startsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

// ---------------------------------------------------------------------------
// CL
// ---------------------------------------------------------------------------

/** True when a CL command name is in confirmClCommands and not excepted by a `!` entry. */
export function clCommandNeedsConfirm(policy: ConnectionPolicy, name: string) {
  const upper = name.toUpperCase();
  const entries = confirmClCommandList(policy).map(entry => String(entry || "").trim().toUpperCase()).filter(Boolean);
  const exceptions = entries.filter(e => e.startsWith("!")).map(e => normalizeClCommandName(e.slice(1)));
  if (exceptions.some(e => genericMatch(upper, e))) return false;
  return entries.filter(e => !e.startsWith("!")).map(normalizeClCommandName).some(e => genericMatch(upper, e));
}

/** Commands whose parameters never name a library they write to. */
const NO_TARGET_COMMANDS = [
  "ADDLIBLE", "RMVLIBLE", "CHGCURLIB", "CHGLIBL", "EDTLIBL", "OVR*", "DLTOVR", "DLYJOB",
  "SNDMSG", "SNDPGMMSG", "SNDBRKMSG", "SNDUSRMSG", "STRDBG", "ENDDBG"
];
/** Commands that only read, unless they write an outfile. */
const READ_COMMANDS = ["DSP*", "WRK*", "CHK*", "RTV*"];
/** Parameters that write their value. */
const OUTPUT_KEYWORDS = new Set(["OUTFILE", "TOFILE"]);
/** Parameters whose value is a library name. */
const LIBRARY_KEYWORDS = new Set(["LIB", "TOLIB", "NEWLIB", "RSTLIB"]);
/** Parameters whose value is an object, optionally library-qualified. */
const OBJECT_KEYWORDS = new Set([
  "PGM", "MODULE", "SRVPGM", "FILE", "OBJ", "CMD", "MENU", "PNLGRP", "QRY", "TBL", "DTAARA", "DTAQ", "MSGF",
  "BNDDIR", "USRSPC", "USRIDX", "USRQ", "JOBD", "OUTQ", "JRN", "JRNRCV", "SQLPKG", "SBSD", "CLS",
  "OUTFILE", "TOFILE"
]);
/** Commands whose MODULE parameter is an input, not the object created. */
const MODULE_INPUT_COMMANDS = new Set(["CRTPGM", "CRTSRVPGM", "UPDPGM", "UPDSRVPGM"]);
/**
 * CHGJOB settings the caller may change on its own job without being asked:
 * how inquiry messages are answered and what the job log keeps. Nothing that
 * changes what later statements in the shared SQL job return (CCSID, DATFMT,
 * SRTSEQ ...), where the job runs (JOBQ, RUNPTY ...) or where output goes.
 */
const OWN_JOB_SETTINGS = new Set(["INQMSGRPY", "LOG", "LOGCLPGM"]);

type ClDecision = { critical?: string; targets: LibraryTargets };

/** Classify one or more newline-separated CL commands. */
export function classifyClText(policy: ConnectionPolicy, text: string, currentLibrary?: string, depth = 0): ClDecision {
  const targets: LibraryTargets = { libraries: [], unknown: false };
  for (const line of String(text || "").split(/\r?\n/)) {
    const command = stripClComments(line).trim();
    if (!command) continue;
    const result = classifyClCommand(policy, command, currentLibrary, depth);
    mergeTargets(targets, result.targets);
    if (result.critical) return { critical: result.critical, targets };
  }
  return { targets };
}

function classifyClCommand(policy: ConnectionPolicy, command: string, currentLibrary: string | undefined, depth: number): ClDecision {
  const parsed = parseClCommand(command);
  const name = parsed.name;
  const targets: LibraryTargets = { libraries: [], unknown: false };
  if (!name) return { targets };
  if (depth > 4) return { critical: "The command nests too deeply to be checked.", targets };
  if (clCommandNeedsConfirm(policy, name)) return { critical: `${name} is in confirmClCommands.`, targets };

  const param = (keyword: string, position: number) =>
    parsed.params.find(p => p.keyword === keyword) ?? parsed.params.filter(p => !p.keyword)[position];

  if (name === "SBMJOB") {
    const cmd = param("CMD", 0);
    if (!cmd) return { critical: "SBMJOB without CMD cannot be checked.", targets };
    return classifyClText(policy, cmd.value, currentLibrary, depth + 1);
  }
  if (name === "CALL" || name === "CALLPRC") {
    const pgm = param(name === "CALL" ? "PGM" : "PRC", 0);
    const objectName = String(pgm?.value || "").trim().toUpperCase();
    const program = objectName.split("/").pop() || "";
    if (program === "QCMDEXC") {
      const literal = firstQuotedLiteral(param("PARM", 1)?.value || "");
      if (literal === undefined) return { critical: "QCMDEXC with a command built at run time cannot be checked.", targets };
      return classifyClText(policy, literal, currentLibrary, depth + 1);
    }
    if (program === "QCAPCMD") return { critical: "QCAPCMD runs a command that cannot be checked.", targets };
    addQualified(targets, objectName, false, currentLibrary);
    return { targets };
  }
  if (name === "RUNSQL") {
    const sql = param("SQL", 0);
    const literal = sql ? unquoteClString(sql.value) : undefined;
    if (literal === undefined) return { critical: "RUNSQL whose statement is not a literal cannot be checked.", targets };
    const result = classifySql(policy, literal, currentLibrary);
    return { critical: result.critical, targets: result.targets };
  }
  if (name === "CHGJOB") {
    // Its own job (no JOB, or JOB(*)) and only OWN_JOB_SETTINGS: no library is
    // written. Another job, or any other setting, is classified as before.
    const job = parsed.params.find(p => p.keyword === "JOB") ?? parsed.params.find(p => !p.keyword);
    const settings = parsed.params.filter(p => p !== job);
    const ownJob = !job || job.value.trim() === "*";
    if (ownJob && settings.length > 0 && settings.every(p => !!p.keyword && OWN_JOB_SETTINGS.has(p.keyword))) {
      return { targets };
    }
  }

  if (matchesAny(name, NO_TARGET_COMMANDS)) return { targets };
  const readOnly = matchesAny(name, READ_COMMANDS);
  const createsByDefault = name.startsWith("CRT");
  let found = false;
  for (const p of parsed.params) {
    const keyword = p.keyword;
    if (!keyword) continue;
    if (readOnly && !OUTPUT_KEYWORDS.has(keyword)) continue;
    if (keyword === "MODULE" && MODULE_INPUT_COMMANDS.has(name)) continue;
    if (keyword === "BNDDIR" && !name.includes("BNDDIR")) continue;
    // ADDBNDDIRE writes the binding directory; the entries it adds only name objects.
    if (keyword === "OBJ" && name === "ADDBNDDIRE") continue;
    if (LIBRARY_KEYWORDS.has(keyword)) {
      for (const value of listValues(p.value)) {
        found = true;
        addLibrary(targets, value, currentLibrary);
      }
    } else if (OBJECT_KEYWORDS.has(keyword)) {
      const value = firstListValue(p.value);
      if (!value || (value.startsWith("*") && !value.includes("/"))) continue;
      found = true;
      addQualified(targets, value, createsByDefault, currentLibrary);
    }
  }
  // A positional first parameter is the command's object (CALL-style use of other commands).
  if (!found && !readOnly) {
    const positional = parsed.params.find(p => !p.keyword);
    const value = positional ? firstListValue(positional.value) : undefined;
    if (value && !(value.startsWith("*") && !value.includes("/"))) {
      found = true;
      addQualified(targets, value, createsByDefault, currentLibrary);
    }
  }
  if (!found && !readOnly) targets.unknown = true;
  return { targets };
}

/** Add the library of LIB/OBJ; an unqualified name is *CURLIB for create commands, else *LIBL (unknown). */
function addQualified(targets: LibraryTargets, value: string, unqualifiedIsCurlib: boolean, currentLibrary?: string) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) {
    targets.unknown = true;
    return;
  }
  const slash = text.indexOf("/");
  if (slash < 0) {
    if (unqualifiedIsCurlib) addLibrary(targets, "*CURLIB", currentLibrary);
    else targets.unknown = true;
    return;
  }
  addLibrary(targets, text.slice(0, slash), currentLibrary);
}

function matchesAny(name: string, patterns: string[]) {
  return patterns.some(p => genericMatch(name, p));
}

function stripClComments(line: string) {
  return line.replace(/\/\*[\s\S]*?\*\//g, " ");
}

export type ClParam = { keyword?: string; value: string };

/** Split a CL command into its name and parameters (keyword(value) or positional values). */
export function parseClCommand(command: string): { name: string; params: ClParam[] } {
  const text = String(command || "").trim().replace(/^\?+/, "").trim();
  const tokens = splitClTokens(text);
  const first = tokens.shift() || "";
  const name = normalizeClCommandName(first);
  const params: ClParam[] = [];
  for (const token of tokens) {
    const m = token.match(/^([A-Za-z][A-Za-z0-9]*)\(([\s\S]*)\)$/);
    if (m) params.push({ keyword: m[1].toUpperCase(), value: m[2] });
    else params.push({ value: token });
  }
  return { name, params };
}

/** Whitespace-separated tokens, keeping parenthesised groups and quoted strings together. */
function splitClTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          quote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      quote = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Values of a list parameter, e.g. "(A B)" or "A B" -> ["A", "B"]; quoted strings are skipped. */
function listValues(value: string): string[] {
  return splitClTokens(String(value || "").replace(/[()]/g, " "))
    .filter(v => !v.startsWith("'"));
}

/** The first element of a parameter value, e.g. "(LIB/F MBR)" -> "LIB/F". */
function firstListValue(value: string): string | undefined {
  return listValues(value)[0];
}

function unquoteClString(value: string): string | undefined {
  const text = String(value || "").trim();
  if (!text.startsWith("'") || !text.endsWith("'") || text.length < 2) return undefined;
  return text.slice(1, -1).replace(/''/g, "'");
}

function firstQuotedLiteral(value: string): string | undefined {
  const m = String(value || "").match(/'((?:[^']|'')*)'/);
  return m ? m[1].replace(/''/g, "'") : undefined;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const ROUTINE_NO_TARGET = new Set(["SET", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "LOCK", "SELECT", "VALUES", "CONNECT", "DISCONNECT"]);
const UNVERIFIABLE_SQL = new Set(["BEGIN", "EXECUTE", "PREPARE", "DECLARE"]);
const OBJECT_TYPE_WORDS = new Set([
  "ALIAS", "VIEW", "TABLE", "INDEX", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "VARIABLE", "TYPE",
  "SCHEMA", "COLLECTION", "MASK", "PERMISSION", "PACKAGE", "XSROBJECT", "SPECIFIC", "COLUMN"
]);
const CREATE_MODIFIERS = new Set(["OR", "REPLACE", "UNIQUE", "WHERE", "NOT", "NULL", "ENCODED", "VECTOR", "DISTINCT", "MATERIALIZED", "QUERY", "GLOBAL", "TEMPORARY"]);

/** Classify SQL text for sql.write: verbs in confirmSqlVerbs, embedded CL, and target libraries. */
export function classifySql(policy: ConnectionPolicy, sql: string, currentLibrary?: string): ClDecision {
  const targets: LibraryTargets = { libraries: [], unknown: false };
  const verbs = confirmSqlVerbList(policy).map(v => String(v || "").trim().toUpperCase().split(/\s+/)).filter(v => v[0]);

  for (const embedded of extractEmbeddedClCommands(sql)) {
    if (embedded.command === null) return { critical: "QCMDEXC with a command built at run time cannot be checked.", targets };
    const result = classifyClText(policy, embedded.command, currentLibrary, 1);
    mergeTargets(targets, result.targets);
    if (result.critical) return { critical: result.critical, targets };
  }

  for (const statement of splitSqlStatements(sql)) {
    const tokens = statement.tokens.filter(t => t.type !== "cl");
    if (tokens.length === 0) continue;
    // The statement itself, the data change a WITH leads to, and any data-change
    // table reference inside it, e.g. FINAL TABLE (DELETE ...).
    const head = firstWordIndex(tokens);
    const inner = [...dataChangeStarts(tokens), withDataChangeIndex(tokens, head)].filter(i => i >= 0);
    for (const start of [head, ...inner].filter(i => i >= 0)) {
      const words = tokens.slice(start, start + 4).filter(t => t.type === "word").map(t => t.value);
      const verb = verbs.find(v => v.every((w, i) => words[i] === w));
      if (verb) return { critical: `${verb.join(" ")} statements are in confirmSqlVerbs.`, targets };
    }
    const first = tokens[head];
    if (!first || first.type !== "word") {
      targets.unknown = true;
      continue;
    }
    if (UNVERIFIABLE_SQL.has(first.value) && !isDeclareGlobalTemporary(tokens)) {
      return { critical: `${first.value} statements cannot be checked.`, targets };
    }
    mergeTargets(targets, sqlStatementTargets(tokens, currentLibrary));
    for (const start of inner) mergeTargets(targets, sqlStatementTargets(tokens.slice(start), currentLibrary));
  }
  return { targets };
}

/** For WITH ... INSERT/UPDATE/DELETE/MERGE: the index of that data-change keyword, else -1. */
function withDataChangeIndex(tokens: SqlToken[], head: number) {
  if (head < 0 || tokens[head].value !== "WITH") return -1;
  return tokens.findIndex((t, i) => i > head && t.type === "word" && ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(t.value));
}

function firstWordIndex(tokens: SqlToken[]) {
  return tokens.findIndex(t => !(t.type === "punct" && t.value === "("));
}

function dataChangeStarts(tokens: SqlToken[]) {
  const out: number[] = [];
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (tokens[i].type === "word" && ["FINAL", "NEW", "OLD"].includes(tokens[i].value) &&
      tokens[i + 1].value === "TABLE" && tokens[i + 2].value === "(") out.push(i + 3);
  }
  return out;
}

function isDeclareGlobalTemporary(tokens: SqlToken[]) {
  const words = tokens.filter(t => t.type === "word").slice(0, 4).map(t => t.value);
  return words[0] === "DECLARE" && words[1] === "GLOBAL" && words[2] === "TEMPORARY";
}

/** Read a possibly qualified name starting at index i: [schema][. or /]name. */
function readName(tokens: SqlToken[], i: number): { schema?: string; parts: number; next: number } | undefined {
  const isName = (t?: SqlToken) => t && (t.type === "word" || t.type === "qident");
  if (!isName(tokens[i])) return undefined;
  const parts = [tokens[i]];
  let j = i + 1;
  while (tokens[j] && tokens[j].type === "punct" && (tokens[j].value === "." || tokens[j].value === "/") && isName(tokens[j + 1])) {
    parts.push(tokens[j + 1]);
    j += 2;
  }
  return { schema: parts.length > 1 ? parts[0].value.toUpperCase() : undefined, parts: parts.length, next: j };
}

function sqlStatementTargets(tokens: SqlToken[], currentLibrary?: string): LibraryTargets {
  const out: LibraryTargets = { libraries: [], unknown: false };
  const start = firstWordIndex(tokens);
  const verb = tokens[start].value;
  const wordAt = (i: number) => (tokens[i]?.type === "word" ? tokens[i].value : undefined);
  const addName = (i: number) => {
    const name = readName(tokens, i);
    if (!name || !name.schema) out.unknown = true;
    else addLibrary(out, name.schema, currentLibrary);
    return name;
  };

  if (ROUTINE_NO_TARGET.has(verb)) {
    // SELECT/VALUES/WITH without a data-change reference: nothing is written.
    return out;
  }
  if (verb === "WITH") {
    // The data change a WITH leads to is checked by the caller.
    return out;
  }
  if (verb === "DECLARE") {
    addLibrary(out, "QTEMP", currentLibrary);
    return out;
  }
  if (verb === "INSERT" || verb === "MERGE") {
    if (wordAt(start + 1) === "INTO") addName(start + 2);
    else out.unknown = true;
    return out;
  }
  if (verb === "UPDATE" || verb === "REFRESH") {
    addName(verb === "REFRESH" && wordAt(start + 1) === "TABLE" ? start + 2 : start + 1);
    return out;
  }
  if (verb === "DELETE") {
    addName(wordAt(start + 1) === "FROM" ? start + 2 : start + 1);
    return out;
  }
  if (verb === "TRUNCATE") {
    addName(wordAt(start + 1) === "TABLE" ? start + 2 : start + 1);
    return out;
  }
  if (verb === "RENAME") {
    const typeWord = wordAt(start + 1);
    addName(typeWord === "TABLE" || typeWord === "INDEX" ? start + 2 : start + 1);
    return out;
  }
  if (verb === "CREATE" || verb === "DROP" || verb === "ALTER" || verb === "COMMENT" || verb === "LABEL") {
    let i = start + 1;
    if (verb === "COMMENT" || verb === "LABEL") {
      if (wordAt(i) !== "ON") {
        out.unknown = true;
        return out;
      }
      i++;
    }
    while (wordAt(i) && CREATE_MODIFIERS.has(wordAt(i)!)) i++;
    const type = wordAt(i);
    if (!type || !OBJECT_TYPE_WORDS.has(type)) {
      out.unknown = true;
      return out;
    }
    i++;
    if (type === "SPECIFIC") i++; // DROP SPECIFIC PROCEDURE name
    if (type === "COLUMN") {
      // COMMENT/LABEL ON COLUMN schema.table.column: only a three-part name names the schema.
      const name = readName(tokens, i);
      if (!name || name.parts !== 3) out.unknown = true;
      else addLibrary(out, name.schema, currentLibrary);
      return out;
    }
    if (type === "SCHEMA" || type === "COLLECTION") {
      const name = readName(tokens, i);
      if (!name || name.parts !== 1) out.unknown = true;
      else addLibrary(out, tokens[i].value, currentLibrary);
      return out;
    }
    const name = readName(tokens, i);
    if (!name || !name.schema) out.unknown = true;
    else addLibrary(out, name.schema, currentLibrary);
    // An index or trigger is built over a table that may be elsewhere.
    if ((type === "INDEX" || type === "TRIGGER") && verb === "CREATE" && name) {
      const on = tokens.findIndex((t, k) => k >= name.next && t.type === "word" && t.value === "ON");
      if (on >= 0) addName(on + 1);
    }
    return out;
  }
  out.unknown = true;
  return out;
}
