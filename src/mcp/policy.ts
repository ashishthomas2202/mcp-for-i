import path from "path";
import { ConnectionPolicy } from "../config/store.js";

/**
 * Connection policy checks for CL commands, libraries and IFS paths.
 *
 * Semantics (all matching is case-insensitive):
 * - Commands: entries are CL command names, optionally ending in `*` for a
 *   generic match (`DLT*`). A library qualifier on an entry or on the command
 *   (`QSYS/DLTLIB`, `*LIBL/DLTLIB`) is ignored. A non-empty `allowCommands`
 *   means only listed commands may run; `denyCommands` always wins.
 * - Libraries: entries are library names, optionally generic (`PRD*`).
 *   A non-empty `allowLibraries` rejects special values such as `*LIBL` and
 *   generic names, because they cannot be checked.
 * - Paths: entries are absolute IFS paths. An entry matches the path itself
 *   and everything below it. `*` inside an entry matches any characters
 *   within one path segment. A non-empty `allowPaths` rejects relative paths.
 */

export type PolicyResources = {
  libraries: string[];
  paths: string[];
};

const LIBRARY_ARG_KEYS = [
  "library",
  "journalLibrary",
  "receiverLibrary",
  "objectLibrary",
  "outQueueLibrary",
  "currentLibrary"
];

const LIBRARY_LIST_ARG_KEYS = ["libraryList"];

const QUALIFIED_OBJECT_ARG_KEYS = ["object", "dataArea", "queue", "messageQueue", "outQueue", "subsystemDescription"];

const PATH_ARG_KEYS = ["path", "remotePath", "remoteDirectory", "targetPath", "cwd"];

/** Tools whose arguments describe local configuration, not IBM i resources. */
const RESOURCE_POLICY_EXEMPT_TOOLS = new Set([
  "ibmi.connect",
  "ibmi.disconnect",
  "ibmi.connections.list",
  "ibmi.connections.add",
  "ibmi.connections.update",
  "ibmi.connections.delete",
  "ibmi.session.list",
  "ibmi.session.status",
  "ibmi.session.keepalive",
  "ibmi.session.terminate",
  "ibmi.actions.save",
  "ibmi.actions.delete",
  "ibmi.actions.list",
  "ibmi.docs.search",
  "ibmi.docs.open",
  "ibmi.diagnostics.parseEvfevent",
  "ibmi.audit.list",
  "ibmi.audit.verify",
  "ibmi.audit.export",
  "ibmi.audit.purge",
  "ibmi.profiles.list",
  "ibmi.profiles.delete",
  "ibmi.filters.list",
  "ibmi.filters.delete"
]);

/**
 * Normalize a CL command string to its command name: trim, drop a leading
 * `?` prompt marker, uppercase, take the first token and strip any library
 * qualifier.
 */
export function normalizeClCommandName(command: string): string {
  let text = String(command || "").trim();
  while (text.startsWith("?")) text = text.substring(1).trim();
  const token = text.split(/[\s(]/, 1)[0] || "";
  const upper = token.toUpperCase();
  const slash = upper.lastIndexOf("/");
  return slash >= 0 ? upper.substring(slash + 1) : upper;
}

function normalizeCommandEntry(entry: string) {
  return normalizeClCommandName(entry);
}

function genericMatch(value: string, pattern: string) {
  if (!pattern) return false;
  if (pattern === "*" || pattern === "*ALL") return true;
  if (pattern.endsWith("*") && !pattern.startsWith("*")) {
    return value.startsWith(pattern.substring(0, pattern.length - 1));
  }
  return value === pattern;
}

/** Returns a reason when the CL command is blocked, or undefined. */
export function checkClCommand(policy: ConnectionPolicy, command: string): string | undefined {
  const name = normalizeClCommandName(command);
  if (!name) return undefined;
  const deny = (policy.denyCommands || []).map(normalizeCommandEntry).filter(Boolean);
  if (deny.some(entry => genericMatch(name, entry))) {
    return `command ${name} is in denyCommands`;
  }
  const allow = (policy.allowCommands || []).map(normalizeCommandEntry).filter(Boolean);
  if (allow.length > 0 && !allow.some(entry => genericMatch(name, entry))) {
    return `command ${name} is not in allowCommands`;
  }
  return undefined;
}

function hasCommandPolicy(policy: ConnectionPolicy) {
  return (policy.denyCommands || []).length > 0 || (policy.allowCommands || []).length > 0;
}

/** Check one or more newline-separated CL commands. */
export function checkClCommands(policy: ConnectionPolicy, commands: string): string | undefined {
  for (const line of String(commands || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const reason = checkClCommand(policy, line);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Best-effort check of a PASE or QSH shell command. CL reached through
 * `system` or `cl` invocations is checked. Since shell text cannot be fully
 * verified, a non-empty allowCommands blocks shell environments entirely.
 */
export function checkShellCommand(policy: ConnectionPolicy, command: string): string | undefined {
  if (!hasCommandPolicy(policy)) return undefined;
  if ((policy.allowCommands || []).length > 0) {
    return "shell (qsh/pase) commands cannot be verified against allowCommands";
  }
  const pattern = /(?:^|[\s;&|`(])(?:\/QOpenSys\/usr\/bin\/)?(?:system|cl)\s+(?:-\w+\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(command || ""))) !== null) {
    const cl = match[1] ?? match[2] ?? match[3] ?? "";
    const reason = checkClCommand(policy, cl);
    if (reason) return reason;
  }
  return undefined;
}

export type EmbeddedCl = {
  commands: string[];
  /** True when QCMDEXC is called with something other than a string literal. */
  unverifiable: boolean;
};

/**
 * Find CL embedded in SQL text: lines starting with `@` and QCMDEXC calls
 * whose first argument is a string literal.
 */
export function extractEmbeddedCl(sql: string): EmbeddedCl {
  const text = String(sql || "");
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      const cmd = trimmed.substring(1).trim().replace(/;\s*$/, "");
      if (cmd) commands.push(cmd);
    }
  }

  let unverifiable = false;
  const qcmdexc = /\bQCMDEXC\b/gi;
  let match: RegExpExecArray | null;
  while ((match = qcmdexc.exec(text)) !== null) {
    const rest = text.substring(match.index + match[0].length);
    const literal = rest.match(/^\s*\(\s*(?:COMMAND\s*=>\s*)?'((?:[^']|'')*)'\s*(?=[,)])/i);
    if (literal) {
      commands.push(literal[1].replace(/''/g, "'"));
    } else if (/^\s*\(/.test(rest)) {
      unverifiable = true;
    }
  }
  return { commands, unverifiable };
}

/** Check CL embedded in SQL text against the command policy. */
export function checkSqlEmbeddedCl(policy: ConnectionPolicy, sql: string): string | undefined {
  if (!hasCommandPolicy(policy)) return undefined;
  const embedded = extractEmbeddedCl(sql);
  for (const command of embedded.commands) {
    const reason = checkClCommand(policy, command);
    if (reason) return reason;
  }
  if (embedded.unverifiable) {
    return "QCMDEXC with a non-literal command cannot be verified against the command policy";
  }
  return undefined;
}

export function checkLibrary(policy: ConnectionPolicy, library: string): string | undefined {
  const name = String(library || "").trim().toUpperCase();
  if (!name) return undefined;
  const deny = (policy.denyLibraries || []).map(v => String(v).trim().toUpperCase()).filter(Boolean);
  const allow = (policy.allowLibraries || []).map(v => String(v).trim().toUpperCase()).filter(Boolean);
  const isSpecialOrGeneric = name.startsWith("*") || name.includes("*");
  if (!isSpecialOrGeneric && deny.some(entry => genericMatch(name, entry))) {
    return `library ${name} is in denyLibraries`;
  }
  if (allow.length > 0) {
    if (isSpecialOrGeneric) {
      return `library value ${name} cannot be checked against allowLibraries`;
    }
    if (!allow.some(entry => genericMatch(name, entry))) {
      return `library ${name} is not in allowLibraries`;
    }
  }
  return undefined;
}

export function normalizeIfsPath(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function pathEntryMatches(target: string, entry: string) {
  const normalizedEntry = normalizeIfsPath(entry);
  if (!normalizedEntry.startsWith("/")) return false;
  if (normalizedEntry === "/") return true;
  const escaped = normalizedEntry
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}(?:/.*)?$`).test(target.toLowerCase());
}

export function checkIfsPath(policy: ConnectionPolicy, value: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const allow = (policy.allowPaths || []).filter(Boolean);
  const deny = (policy.denyPaths || []).filter(Boolean);
  if (allow.length === 0 && deny.length === 0) return undefined;
  if (!raw.startsWith("/")) {
    return allow.length > 0 ? `relative path ${raw} cannot be checked against allowPaths` : undefined;
  }
  const target = normalizeIfsPath(raw);
  if (deny.some(entry => pathEntryMatches(target, entry))) {
    return `path ${target} is in denyPaths`;
  }
  if (allow.length > 0 && !allow.some(entry => pathEntryMatches(target, entry))) {
    return `path ${target} is not in allowPaths`;
  }
  return undefined;
}

/** Library named by an IFS path such as /QSYS.LIB/MYLIB.LIB/FILE.FILE. */
function libraryFromQsysPath(value: string): string | undefined {
  const match = normalizeIfsPath(value).match(/^(?:\/[^/]+)?\/QSYS\.LIB\/([^/]+)\.LIB(?:\/|$)/i);
  return match ? match[1].toUpperCase() : undefined;
}

/** Collect libraries and IFS paths that a tool call refers to. */
export function collectPolicyResources(toolName: string, args: any): PolicyResources {
  const libraries: string[] = [];
  const paths: string[] = [];
  if (!args || typeof args !== "object") return { libraries, paths };

  for (const key of LIBRARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) libraries.push(value.trim());
  }
  for (const key of LIBRARY_LIST_ARG_KEYS) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) libraries.push(item.trim());
    }
  }
  for (const key of QUALIFIED_OBJECT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.includes("/")) {
      const lib = value.split("/")[0].trim();
      if (lib) libraries.push(lib);
    }
  }
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (toolName === "ibmi.resolve.path" && key === "path" && !value.trim().startsWith("/")) {
      const parts = value.split("/").filter(Boolean);
      const lib = parts.length === 4 ? parts[1] : parts[0];
      if (lib) libraries.push(lib);
      continue;
    }
    if (key === "targetPath" && args.targetType && args.targetType !== "streamfile") continue;
    paths.push(value.trim());
    const qsysLib = libraryFromQsysPath(value);
    if (qsysLib) libraries.push(qsysLib);
  }
  return { libraries, paths };
}

/** Check library, path and embedded-CL policy for any tool call. */
export function checkResourcePolicy(policy: ConnectionPolicy, toolName: string, args: any): string | undefined {
  if (RESOURCE_POLICY_EXEMPT_TOOLS.has(toolName)) return undefined;
  const resources = collectPolicyResources(toolName, args);
  for (const library of resources.libraries) {
    const reason = checkLibrary(policy, library);
    if (reason) return reason;
  }
  for (const ifsPath of resources.paths) {
    const reason = checkIfsPath(policy, ifsPath);
    if (reason) return reason;
  }
  if (typeof args?.sql === "string") {
    const reason = checkSqlEmbeddedCl(policy, args.sql);
    if (reason) return reason;
  }
  return undefined;
}

const PROTECTED_DELETE_PREFIXES = [
  "/qibm/proddata",
  "/qopensys/qibm/proddata",
  "/qsys.lib/qsys.lib",
  "/qsys.lib/qsys2.lib",
  "/qsys.lib/qusrsys.lib",
  "/qsys.lib/qgpl.lib"
];

/**
 * Validate a path for ifs.delete. Refuses empty or relative paths, `..`,
 * wildcards, the root, top-level directories, /QSYS.LIB/<lib>.LIB,
 * second-level directories under /QOpenSys and /QIBM, and IBM product
 * directories. Returns the normalized path.
 */
export function assertSafeIfsDeletePath(value: unknown): string {
  return assertSafeIfsTargetPath(value, "ifs.delete", "delete");
}

/**
 * The same guard as assertSafeIfsDeletePath for other operations that change
 * or remove what is at a path (copy destinations, move sources and targets).
 * `operation` names the tool in the error and `verb` describes the change.
 */
export function assertSafeIfsTargetPath(value: unknown, operation: string, verb = "modify"): string {
  const refuse = (reason: string) => new Error(`${operation} refused: ${reason}`);
  const raw = String(value ?? "").trim();
  if (!raw) throw refuse("path is empty");
  if (/[\0\r\n]/.test(raw)) throw refuse("path contains control characters");
  if (!raw.startsWith("/")) throw refuse("path must be absolute");
  if (raw.split(/[\\/]/).some(segment => segment === "..")) {
    throw refuse("path must not contain '..'");
  }
  if (/[*?[\]]/.test(raw)) throw refuse("wildcards are not allowed");
  const normalized = normalizeIfsPath(raw);
  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  if (segments.length === 0) throw refuse(`cannot ${verb} the root directory`);
  if (segments.length === 1) throw refuse(`cannot ${verb} top-level directory ${normalized}`);
  if (segments[0] === "qsys.lib" && segments.length === 2) {
    throw refuse(`cannot ${verb} a library through the IFS (${normalized})`);
  }
  if (segments[0] === "home" && segments.length === 2) {
    throw refuse(`cannot ${verb} a user home directory (${normalized})`);
  }
  if ((segments[0] === "qopensys" || segments[0] === "qibm") && segments.length === 2) {
    throw refuse(`cannot ${verb} system directory ${normalized}`);
  }
  if (PROTECTED_DELETE_PREFIXES.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`))) {
    throw refuse(`${normalized} is a protected system location`);
  }
  return normalized;
}

/**
 * CL that starts a shell: QSH/STRQSH, or a CALL to one of the PASE or QShell
 * entry programs. Matched anywhere in the text, so it also catches a shell
 * nested in SBMJOB CMD(...) or a QCMDEXC string.
 */
const SHELL_IN_CL = /(?:^|[^A-Z0-9_$#@])(?:QSH|STRQSH|QP2SHELL2?|QP2TERM|QZSHSH|QZSHCHLD|QZSHQSHC)(?:[^A-Z0-9_$#@]|$)/i;

/** True when CL text starts a PASE or QShell shell. */
export function clStartsShell(command: string): boolean {
  return SHELL_IN_CL.test(String(command || ""));
}

/**
 * True when an operation runs shell text: a qsh/pase command, CL that starts
 * a shell, or SQL whose embedded CL does (or can't be read).
 */
export function isShellOperation(args: any): boolean {
  if (typeof args?.command === "string" && args.command.trim()) {
    const environment = String(args.environment || "ile").toLowerCase();
    if (environment !== "ile") return true;
    if (clStartsShell(args.command)) return true;
  }
  if (typeof args?.sql === "string") {
    const embedded = extractEmbeddedCl(args.sql);
    if (embedded.unverifiable) return true;
    if (embedded.commands.some(clStartsShell)) return true;
  }
  return false;
}

/**
 * Connection fields an agent may not change through MCP tools. They decide
 * how much the agent is allowed to do, so they are set in the web UI or in
 * config.json by a person.
 */
export const PROTECTED_CONNECTION_SETTINGS = [
  "readOnlyMode",
  "tempDir",
  "tempLibrary",
  "autoClearTempData",
  "mapepireMode",
  "mapepirePort",
  "mapepireServerPath",
  "mapepireJavaPath"
];

/** Refuse policy and safety-setting changes made through connections.add/update. */
export function assertAgentConnectionChangeAllowed(toolName: string, args: any) {
  if (args && typeof args === "object" && args.policy !== undefined) {
    throw new Error(
      `${toolName} cannot set a connection's policy. Change the policy in the web UI (mcp-for-i control) or in config.json.`
    );
  }
  const settings = args?.settings;
  if (settings && typeof settings === "object") {
    const blocked = PROTECTED_CONNECTION_SETTINGS.filter(key => settings[key] !== undefined);
    if (blocked.length > 0) {
      throw new Error(
        `${toolName} cannot change ${blocked.join(", ")}. These settings control what the agent may do; change them in the web UI or in config.json.`
      );
    }
  }
}
