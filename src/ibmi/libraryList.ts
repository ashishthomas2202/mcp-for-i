import { Tools } from "./Tools.js";
import type { ConnectionConfig } from "./types.js";

/**
 * The connection's configured library list (settings libraryList and
 * currentLibrary), as it should be in effect for SQL and CL run by the tools.
 */
export interface DesiredLibraryList {
  /** User portion, upper case, de-duplicated, in order. */
  libraries: string[];
  currentLibrary?: string;
  /** Names that are not valid library names; they are left out. */
  invalid: string[];
  /** Identifies this list; when it changes the list is applied again. */
  signature: string;
}

const LIBRARY_NAME = /^[A-Z#@$][A-Z0-9#@$._]{0,9}$/;

export function isLibraryName(name: string) {
  return LIBRARY_NAME.test(name);
}

export function desiredLibraryList(config: Pick<ConnectionConfig, "libraryList" | "currentLibrary">): DesiredLibraryList {
  const names = (Array.isArray(config.libraryList) ? config.libraryList : [])
    .map(lib => String(lib ?? "").trim().toUpperCase())
    .filter(Boolean);
  const current = String(config.currentLibrary ?? "").trim().toUpperCase();
  const invalid = [...names, ...(current ? [current] : [])].filter(lib => !isLibraryName(lib)).filter(Tools.distinct);
  const libraries = names.filter(isLibraryName).filter(Tools.distinct);
  const currentLibrary = current && isLibraryName(current) ? current : undefined;
  return {
    libraries,
    currentLibrary,
    invalid,
    signature: JSON.stringify([libraries, currentLibrary ?? null])
  };
}

/**
 * The CL command that puts a library list in effect. With no user libraries
 * only the current library is changed, so an empty setting does not wipe the
 * job's library list.
 */
export function libraryListCommand(libraries: string[], currentLibrary?: string): string | undefined {
  if (libraries.length > 0) return `CHGLIBL LIBL(${libraries.join(" ")})${currentLibrary ? ` CURLIB(${currentLibrary})` : ""}`;
  if (currentLibrary) return `CHGCURLIB CURLIB(${currentLibrary})`;
  return undefined;
}

/** All library names a desired list refers to. */
export function referencedLibraries(desired: DesiredLibraryList) {
  return [...desired.libraries, ...(desired.currentLibrary ? [desired.currentLibrary] : [])].filter(Tools.distinct);
}

/** SQL that returns OBJNAME for each of `names` that exists as a library. */
export function existingLibrariesSql(names: string[], allSimple = true) {
  const inList = names.map(lib => `'${lib.replace(/'/g, "''")}'`).join(", ");
  const filter = allSimple ? ", '*ALLSIMPLE'" : "";
  return `select OBJNAME from table(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB'${filter})) X where OBJNAME in (${inList})`;
}

export interface ResolvedLibraryList {
  command?: string;
  libraries: string[];
  currentLibrary?: string;
  warning?: string;
}

/**
 * Drops libraries that do not exist (CHGLIBL fails entirely when one is
 * missing) and describes what was left out.
 */
export function resolveAgainstExisting(desired: DesiredLibraryList, existing: Set<string>): ResolvedLibraryList {
  const libraries = desired.libraries.filter(lib => existing.has(lib));
  const currentLibrary = desired.currentLibrary && existing.has(desired.currentLibrary) ? desired.currentLibrary : undefined;
  const missing = referencedLibraries(desired).filter(lib => !existing.has(lib));
  const notes: string[] = [];
  if (missing.length > 0) notes.push(`not found, left out of the library list: ${missing.join(", ")}`);
  if (desired.invalid.length > 0) notes.push(`invalid library name(s) ignored: ${desired.invalid.join(", ")}`);
  return {
    command: libraryListCommand(libraries, currentLibrary),
    libraries,
    currentLibrary,
    ...(notes.length ? { warning: `Configured library list: ${notes.join("; ")}` } : {})
  };
}

/** Warning for names in the setting that are not valid library names. */
export function invalidNamesWarning(desired: DesiredLibraryList) {
  return desired.invalid.length > 0
    ? `Configured library list: invalid library name(s) ignored: ${desired.invalid.join(", ")}`
    : undefined;
}

/** Rows from existingLibrariesSql to a set of names. */
export function libraryNamesFromRows(rows: Array<Record<string, unknown>>) {
  return new Set(rows.map(row => String(row.OBJNAME ?? "").trim().toUpperCase()).filter(Boolean));
}

/**
 * qsh prefix that puts a library list in effect for the `system` commands that
 * follow. Each `system` runs in its own job, which inherits the qsh job's
 * library list as changed by the liblist builtin. Errors (a missing library)
 * are discarded so they do not mix with the command's output.
 */
export function qshLibraryListPrefix(resolved: { libraries: string[]; currentLibrary?: string }, initialUserLibraries: string[]) {
  const quote = (lib: string) => Tools.shellQuote(lib);
  const parts: string[] = [];
  if (resolved.libraries.length > 0) {
    for (const lib of initialUserLibraries.filter(l => l && l !== "QSYS" && l !== "QTEMP")) {
      parts.push(`liblist -d ${quote(lib)}`);
    }
    // liblist -a adds to the front, so add in reverse order.
    for (const lib of [...resolved.libraries].reverse()) parts.push(`liblist -a ${quote(lib)}`);
  }
  if (resolved.currentLibrary) parts.push(`liblist -c ${quote(resolved.currentLibrary)}`);
  return parts.map(part => `${part} >/dev/null 2>&1`).join("; ");
}
