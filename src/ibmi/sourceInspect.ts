// Source-type aware outline and dependency extraction for IBM i source
// members. The parsers are deliberately lightweight: they work line by line
// over an already loaded snapshot, never touch the host, and favour precision
// (no false dependencies such as "PGM" from `CALL PGM(X)`) over completeness.

export type SourceLanguage = "rpg" | "cl" | "sql" | "dds" | "cobol" | "c" | "unknown";

export type SourceSymbol = {
  name: string;
  kind: string;
  line: number;
};

export type SourceDependency = {
  name: string;
  kind: string;
  line: number;
  via: string;
  dynamic?: boolean;
};

export type SourceInspection = {
  language: SourceLanguage;
  format?: "free" | "fixed";
  symbols: SourceSymbol[];
  dependencies: SourceDependency[];
};

const MAX_RESULTS = 1_000;

const RPG_TYPES = new Set(["RPGLE", "SQLRPGLE", "RPG", "RPG38", "RPG36", "SQLRPG", "RPGLEINC", "RPGINC", "RPGLECPY", "RPGLEH"]);
const CL_TYPES = new Set(["CLLE", "CLP", "CL", "CLP38", "CLLEINC", "CLINC", "CLLECPY"]);
const SQL_TYPES = new Set([
  "SQL", "SQLPRC", "SQLPROC", "SQLUDF", "SQLFUNC", "SQLUDT", "SQLTYPE", "SQLTRG", "SQLSEQ", "SQLTABLE",
  "SQLVIEW", "SQLINDEX", "SQLALIAS", "SQLMASK", "SQLPERM", "SQLVAR"
]);
const DDS_TYPES = new Set(["PF", "LF", "DSPF", "PRTF", "ICFF", "PF38", "LF38", "DSPF38", "PRTF38"]);
const COBOL_TYPES = new Set(["CBLLE", "CBL", "SQLCBLLE", "SQLCBL", "CBL38", "CBLLEINC"]);
const C_TYPES = new Set(["C", "CPP", "CLE", "SQLC", "SQLCPP", "H", "HPP"]);

const NAME = "[A-Za-z0-9_#$@\\u00A3\\u00A7]+";

export function detectSourceLanguage(sourceType: string | undefined, lines: string[]): SourceLanguage {
  const type = String(sourceType || "").trim().toUpperCase();
  if (RPG_TYPES.has(type)) return "rpg";
  if (CL_TYPES.has(type)) return "cl";
  if (SQL_TYPES.has(type)) return "sql";
  if (DDS_TYPES.has(type)) return "dds";
  if (COBOL_TYPES.has(type)) return "cobol";
  if (C_TYPES.has(type)) return "c";
  if (/^\*\*free\b/i.test(lines[0] || "")) return "rpg";
  return "unknown";
}

export function inspectSource(lines: string[], sourceType?: string): SourceInspection {
  const language = detectSourceLanguage(sourceType, lines);
  const collector = new Collector();
  let format: "free" | "fixed" | undefined;
  switch (language) {
    case "rpg":
      format = inspectRpg(lines, collector);
      break;
    case "cl":
      inspectCl(lines, collector);
      break;
    case "sql":
      inspectSqlSource(lines, collector);
      break;
    case "dds":
      inspectDds(lines, String(sourceType || "").toUpperCase(), collector);
      break;
    case "cobol":
      inspectCobol(lines, collector);
      break;
    case "c":
      inspectC(lines, collector);
      break;
    default:
      inspectUnknown(lines, collector);
  }
  return {
    language,
    ...(format ? { format } : {}),
    symbols: collector.symbols.slice(0, MAX_RESULTS),
    dependencies: [...collector.dependencies.values()].slice(0, MAX_RESULTS)
  };
}

export function outlineSource(lines: string[], sourceType?: string): SourceSymbol[] {
  return inspectSource(lines, sourceType).symbols;
}

export function dependenciesFromSource(lines: string[], sourceType?: string): SourceDependency[] {
  return inspectSource(lines, sourceType).dependencies;
}

class Collector {
  readonly symbols: SourceSymbol[] = [];
  readonly dependencies = new Map<string, SourceDependency>();

  symbol(name: string, kind: string, line: number) {
    const clean = String(name || "").trim();
    if (!clean || this.symbols.length >= MAX_RESULTS) return;
    this.symbols.push({ name: clean, kind, line });
  }

  dependency(name: string, kind: string, line: number, via: string, dynamic = false, preserveCase = false) {
    // Bound procedure names are case-sensitive, so quoted ones keep their case.
    const clean = preserveCase ? String(name || "").trim() : normalizeObjectName(name);
    if (!clean) return;
    const key = `${kind}:${clean}`;
    if (this.dependencies.has(key)) return;
    this.dependencies.set(key, { name: clean, kind, line, via, ...(dynamic ? { dynamic: true } : {}) });
  }
}

function normalizeObjectName(value: string) {
  let name = String(value || "").trim();
  if (!name) return "";
  if (name.startsWith("'") && name.endsWith("'") && name.length >= 2) {
    name = name.slice(1, -1).replace(/''/g, "'").trim();
    // A quoted object name is folded; anything else (an IFS path) keeps its case.
    return /^[A-Za-z0-9_#$@]{1,10}$/.test(name) ? name.toUpperCase() : name;
  }
  if (name.startsWith("\"") && name.endsWith("\"")) return name;
  return name.replace(/[),;.]+$/, "").toUpperCase();
}

function unquote(value: string) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\"")))) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// RPG (fully free, fixed and mixed)

type RpgState = {
  buffer: string;
  bufferLine: number;
  sqlBuffer?: string;
  sqlLine: number;
  pendingLongName?: string;
};

function inspectRpg(lines: string[], out: Collector): "free" | "fixed" {
  const fullyFree = /^\*\*free\b/i.test(lines[0] || "");
  const state: RpgState = { buffer: "", bufferLine: 0, sqlLine: 0 };

  for (let index = fullyFree ? 1 : 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const lineNo = index + 1;
    // `**CTDATA`, `**FTRANS` or a bare `**` start compile-time data.
    if (index > 0 && raw.startsWith("**")) break;

    if (fullyFree) {
      if (rpgDirective(raw.trimStart(), lineNo, out)) continue;
      appendFree(state, stripFreeComment(raw), lineNo, out);
      continue;
    }

    if (raw.length < 7 && raw.trim() === "") continue;
    const spec = (raw[5] || " ").toUpperCase();
    const col7 = raw[6] || " ";
    const fromCol7 = raw.slice(6);

    if (col7 === "*") continue; // fixed-form comment line
    if (col7 === "/") {
      if (spec === "C" && /^\/EXEC\s+SQL\b/i.test(fromCol7)) {
        flushFree(state, out);
        state.sqlBuffer = fromCol7.replace(/^\/EXEC\s+SQL\b/i, "").slice(0, 74);
        state.sqlLine = lineNo;
        continue;
      }
      if (spec === "C" && /^\/END-EXEC\b/i.test(fromCol7)) {
        if (typeof state.sqlBuffer === "string") sqlStatementDependencies(state.sqlBuffer, state.sqlLine, out, "exec sql");
        state.sqlBuffer = undefined;
        continue;
      }
      rpgDirective(fromCol7, lineNo, out);
      continue;
    }
    if (spec === "C" && col7 === "+" && typeof state.sqlBuffer === "string") {
      state.sqlBuffer += " " + raw.slice(7, 80);
      continue;
    }

    if (spec === " " || spec === "") {
      // Free-form code in columns 8-80 of a non-**FREE member.
      if (col7 === " " || col7 === "") {
        const code = raw.slice(7, 80);
        if (rpgDirective(code.trimStart(), lineNo, out)) continue;
        appendFree(state, stripFreeComment(code), lineNo, out);
      }
      continue;
    }

    if ("HFDICOP".includes(spec)) {
      flushFree(state, out);
      fixedSpec(lines, index, spec, state, out);
    }
  }
  flushFree(state, out);
  return fullyFree ? "free" : "fixed";
}

function rpgDirective(text: string, lineNo: number, out: Collector) {
  const match = /^\/(COPY|INCLUDE)\s+([^\s]+(?:\s*,\s*[^\s]+)?)/i.exec(text);
  if (!match) return /^\/(FREE|END-FREE|TITLE|EJECT|SPACE|DEFINE|UNDEFINE|IF|ELSEIF|ELSE|ENDIF|EOF|SET|RESTORE)\b/i.test(text);
  const target = match[2].replace(/\s+/g, "");
  out.dependency(target, "copy", lineNo, `/${match[1].toUpperCase()}`);
  return true;
}

function stripFreeComment(text: string) {
  let inQuote = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "'") inQuote = !inQuote;
    else if (!inQuote && ch === "/" && text[index + 1] === "/") return text.slice(0, index);
  }
  return text;
}

function appendFree(state: RpgState, text: string, lineNo: number, out: Collector) {
  if (!text.trim()) return;
  if (!state.buffer.trim()) state.bufferLine = lineNo;
  state.buffer += " " + text;
  let separator = findStatementEnd(state.buffer);
  while (separator >= 0) {
    const statement = state.buffer.slice(0, separator);
    freeStatement(statement.trim(), state.bufferLine, out);
    state.buffer = state.buffer.slice(separator + 1);
    state.bufferLine = lineNo;
    separator = findStatementEnd(state.buffer);
  }
}

function findStatementEnd(text: string) {
  let inQuote = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "'") inQuote = !inQuote;
    else if (!inQuote && ch === ";") return index;
  }
  return -1;
}

function flushFree(state: RpgState, out: Collector) {
  if (state.buffer.trim()) freeStatement(state.buffer.trim(), state.bufferLine, out);
  state.buffer = "";
}

function freeStatement(statement: string, lineNo: number, out: Collector) {
  const text = statement.replace(/\s+/g, " ");
  if (!text) return;
  let match: RegExpExecArray | null;
  if ((match = new RegExp(`^dcl-proc (${NAME})`, "i").exec(text))) {
    out.symbol(match[1], "procedure", lineNo);
  } else if ((match = new RegExp(`^begsr (${NAME})`, "i").exec(text))) {
    out.symbol(match[1], "subroutine", lineNo);
  } else if ((match = new RegExp(`^dcl-pr (${NAME})(.*)$`, "i").exec(text))) {
    out.symbol(match[1], "prototype", lineNo);
    prototypeDependencies(match[1], match[2], lineNo, out);
  } else if ((match = new RegExp(`^dcl-ds (${NAME})`, "i").exec(text))) {
    if (match[1].toUpperCase() !== "*N") out.symbol(match[1], "data-structure", lineNo);
  } else if ((match = new RegExp(`^dcl-f (${NAME})(.*)$`, "i").exec(text))) {
    out.symbol(match[1], "file", lineNo);
    out.dependency(externalFileName(match[1], match[2]), "file", lineNo, "dcl-f");
  } else if ((match = new RegExp(`^callp(?:\\([a-z ]*\\))? (${NAME})`, "i").exec(text))) {
    out.dependency(match[1], "call", lineNo, "callp");
  } else if (/^exec sql\b/i.test(text)) {
    sqlStatementDependencies(text.replace(/^exec sql\b/i, ""), lineNo, out, "exec sql");
  }
}

function externalFileName(name: string, keywords: string) {
  const extdesc = /\bEXTDESC\s*\(\s*'([^']+)'\s*\)/i.exec(keywords);
  if (extdesc) return extdesc[1];
  const extfile = /\bEXTFILE\s*\(\s*'([^']+)'\s*\)/i.exec(keywords);
  if (extfile) return extfile[1];
  return name;
}

function prototypeDependencies(prototype: string, keywords: string, lineNo: number, out: Collector) {
  const extpgm = /\bEXTPGM\b\s*(?:\(([^)]*)\))?/i.exec(keywords);
  if (extpgm) {
    const target = extpgm[1] ? lastExternalName(extpgm[1]) : { name: prototype, dynamic: false };
    out.dependency(target.name || prototype, "program", lineNo, "extpgm", target.dynamic);
  }
  const extproc = /\bEXTPROC\b\s*(?:\(([^)]*)\))?/i.exec(keywords);
  if (extproc) {
    const target = extproc[1] ? lastExternalName(extproc[1]) : { name: prototype, dynamic: false };
    out.dependency(target.name || prototype, "procedure", lineNo, "extproc", target.dynamic, Boolean(target.name) && !target.dynamic);
  }
}

function lastExternalName(argument: string) {
  const quoted = [...argument.matchAll(/'((?:[^']|'')*)'/g)];
  if (quoted.length > 0) {
    // EXTPROC(*JAVA:'class':'method') names a method; the class is the target.
    const pick = /^\s*\*JAVA\b/i.test(argument) ? quoted[0] : quoted[quoted.length - 1];
    return { name: pick[1].replace(/''/g, "'"), dynamic: false };
  }
  const parts = argument.split(":").map(part => part.trim()).filter(part => part && !part.startsWith("*"));
  // EXTPROC(*DCLCASE) and similar special values keep the prototype name.
  if (parts.length === 0) return { name: "", dynamic: false };
  // An unquoted operand is a named constant or variable resolved at run time.
  return { name: parts[parts.length - 1], dynamic: true };
}

function fixedSpec(lines: string[], index: number, spec: string, state: RpgState, out: Collector) {
  const raw = lines[index];
  const lineNo = index + 1;
  switch (spec) {
    case "F": {
      const name = raw.slice(6, 16).trim();
      if (!name) return;
      out.symbol(name, "file", lineNo);
      out.dependency(externalFileName(name, raw.slice(43, 80)), "file", lineNo, "f-spec");
      return;
    }
    case "D": {
      const name = longName(raw.slice(6, 21).trim(), state);
      if (name === undefined) return;
      const definition = raw.slice(23, 25).trim().toUpperCase();
      if (definition === "PR" && name) {
        out.symbol(name, "prototype", lineNo);
        let keywords = raw.slice(43, 80);
        for (let next = index + 1; next < lines.length; next++) {
          const line = lines[next] || "";
          if ((line[5] || "").toUpperCase() !== "D" || line[6] === "*") break;
          if (line.slice(6, 21).trim() || line.slice(23, 25).trim()) break;
          keywords += " " + line.slice(43, 80);
        }
        prototypeDependencies(name, keywords, lineNo, out);
      } else if (definition === "DS" && name) {
        out.symbol(name, "data-structure", lineNo);
      }
      return;
    }
    case "P": {
      const name = longName(raw.slice(6, 21).trim(), state);
      if (name && raw.slice(23, 25).trim().toUpperCase() === "B") out.symbol(name, "procedure", lineNo);
      return;
    }
    case "C": {
      const opcode = raw.slice(25, 35).trim().toUpperCase().replace(/\(.*\)$/, "");
      const factor1 = raw.slice(11, 25).trim();
      const factor2 = raw.slice(35, 49).trim();
      if (opcode === "BEGSR" && factor1) {
        out.symbol(factor1, "subroutine", lineNo);
      } else if (opcode === "CALL" && factor2) {
        out.dependency(unquote(factor2), "program", lineNo, "call", !factor2.startsWith("'"));
      } else if (opcode === "CALLB" && factor2) {
        out.dependency(unquote(factor2), "procedure", lineNo, "callb", !factor2.startsWith("'"), factor2.startsWith("'"));
      } else if (opcode === "CALLP") {
        const match = new RegExp(`^(${NAME})`).exec(raw.slice(35, 80).trim());
        if (match) out.dependency(match[1], "call", lineNo, "callp");
      }
      return;
    }
    default:
      return;
  }
}

// Fixed-form names longer than the name field end in "..." and continue on
// the next specification. Returns undefined while a long name is pending.
function longName(field: string, state: RpgState): string | undefined {
  if (field.endsWith("...")) {
    state.pendingLongName = (state.pendingLongName || "") + field.slice(0, -3);
    return undefined;
  }
  if (state.pendingLongName) {
    const name = state.pendingLongName + field;
    state.pendingLongName = undefined;
    return name;
  }
  return field;
}

// ---------------------------------------------------------------------------
// SQL (standalone source and embedded statements)

const SQL_NOT_TABLES = new Set([
  "SELECT", "TABLE", "LATERAL", "FINAL", "NEW", "OLD", "UNNEST", "XMLTABLE", "JSON_TABLE", "VALUES", "SET",
  "OF", "WHERE", "ONLY", "WITH", "AS", "ON", "USING", "SYSIBM.SYSDUMMY1"
]);
const SQL_CLAUSE_WORDS = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "FETCH", "UNION", "EXCEPT", "INTERSECT", "JOIN", "INNER", "LEFT",
  "RIGHT", "FULL", "CROSS", "EXCEPTION", "ON", "USING", "SET", "FOR", "WITH", "LIMIT", "OFFSET", "INTO",
  "VALUES", "OPTIMIZE", "WHEN", "THEN", "SKIP", "WAIT", "USE", "NATURAL", "OUTER"
]);

export function sqlTableReferences(sqlText: string): Array<{ name: string; kind: "table" | "procedure"; via: string }> {
  const text = stripSqlNoise(sqlText);
  const tokens = text.match(/"[^"]*"(?:[./]"[^"]*"|[./][A-Za-z0-9_#$@]+)*|[A-Za-z0-9_#$@:]+(?:[./](?:"[^"]*"|[A-Za-z0-9_#$@]+))*|[(),;]/g) || [];
  const upper = tokens.map(token => token.startsWith("\"") ? token : token.toUpperCase());
  const cteNames = new Set<string>();
  for (let index = 0; index + 2 < upper.length; index++) {
    if ((upper[index] === "WITH" || upper[index] === "," || upper[index] === "RECURSIVE") && upper[index + 2] === "AS" && upper[index + 3] === "(") {
      cteNames.add(upper[index + 1]);
    }
  }
  const found: Array<{ name: string; kind: "table" | "procedure"; via: string }> = [];
  const isIdentifier = (token: string | undefined) =>
    Boolean(token) && /^(?:"|[A-Za-z0-9_#$@])/.test(token!) && !token!.startsWith(":") && !/^\d/.test(token!);
  const addTable = (token: string | undefined, via: string) => {
    if (!isIdentifier(token)) return false;
    const name = token!.startsWith("\"") ? token! : token!.toUpperCase();
    if (SQL_NOT_TABLES.has(name) || cteNames.has(name)) return false;
    found.push({ name, kind: "table", via });
    return true;
  };

  // Parentheses that open a subquery may contain FROM; parentheses of a
  // function call such as EXTRACT(YEAR FROM x) or TRIM(' ' FROM x) may not.
  const parens: boolean[] = [];
  for (let index = 0; index < upper.length; index++) {
    const token = upper[index];
    const previous = upper[index - 1];
    const next = upper[index + 1];
    if (token === "(") {
      parens.push(next === "SELECT" || next === "WITH" || next === "VALUES");
      continue;
    }
    if (token === ")") {
      parens.pop();
      continue;
    }
    if (token === "FROM" || token === "JOIN") {
      if (parens.length > 0 && !parens[parens.length - 1]) continue;
      if (token === "FROM" && (previous === "DISTINCT" || previous === "IS")) continue;
      if (token === "FROM" && upper.slice(Math.max(0, index - 4), index).includes("FETCH")) continue;
      if (!isIdentifier(tokens[index + 1]) || SQL_NOT_TABLES.has(upper[index + 1])) continue;
      addTable(tokens[index + 1], token.toLowerCase());
      if (token !== "FROM") continue;
      // FROM a [AS] x, b [AS] y
      let cursor = index + 2;
      while (cursor < upper.length) {
        if (upper[cursor] === "AS") cursor++;
        if (isIdentifier(upper[cursor]) && !SQL_CLAUSE_WORDS.has(upper[cursor]) && upper[cursor] !== ",") cursor++;
        if (upper[cursor] !== ",") break;
        if (!isIdentifier(tokens[cursor + 1]) || SQL_NOT_TABLES.has(upper[cursor + 1])) break;
        addTable(tokens[cursor + 1], "from");
        cursor += 2;
      }
    } else if (token === "INTO" && (previous === "INSERT" || previous === "MERGE")) {
      addTable(tokens[index + 1], previous.toLowerCase() + " into");
    } else if (token === "UPDATE" && previous !== "FOR" && previous !== "ON" && previous !== "OR" && next !== "OF" && next !== "SET") {
      addTable(tokens[index + 1], "update");
    } else if (token === "REFERENCES") {
      addTable(tokens[index + 1], "references");
    } else if (token === "CALL" && isIdentifier(tokens[index + 1])) {
      found.push({ name: upper[index + 1], kind: "procedure", via: "call" });
    }
  }

  const index = /\bINDEX\s+(?:"[^"]*"|[A-Za-z0-9_#$@./]+)\s+ON\s+("[^"]*"|[A-Za-z0-9_#$@./]+)/i.exec(text);
  if (index) addTable(index[1], "index on");
  const trigger = /\bTRIGGER\b[\s\S]*?\bON\s+("[^"]*"|[A-Za-z0-9_#$@./]+)/i.exec(text);
  if (trigger) addTable(trigger[1], "trigger on");
  return found;
}

function stripSqlNoise(sqlText: string) {
  return String(sqlText || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, " ");
}

function sqlStatementDependencies(sqlText: string, lineNo: number, out: Collector, via: string) {
  for (const reference of sqlTableReferences(sqlText)) {
    out.dependency(reference.name, reference.kind === "procedure" ? "procedure" : "sql-table", lineNo, `${via}: ${reference.via}`);
  }
}

function inspectSqlSource(lines: string[], out: Collector) {
  let buffer = "";
  let startLine = 0;
  let inComment = false;
  const flush = () => {
    if (!buffer.trim()) return;
    const statement = buffer.replace(/\s+/g, " ").trim();
    const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+|ENCODED\s+VECTOR\s+)?(TABLE|VIEW|INDEX|PROCEDURE|FUNCTION|TRIGGER|SEQUENCE|ALIAS|VARIABLE|MASK|PERMISSION|TYPE)\s+("[^"]*"|[A-Za-z0-9_#$@./]+)/i.exec(statement);
    if (create) out.symbol(create[2].startsWith("\"") ? create[2] : create[2].toUpperCase(), create[1].toLowerCase(), startLine);
    sqlStatementDependencies(statement, startLine, out, "sql");
    buffer = "";
  };
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    if (inComment) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inComment = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, " ");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      inComment = true;
    }
    line = line.replace(/--.*$/, "");
    let rest = line;
    while (rest.length > 0) {
      const end = findStatementEnd(rest);
      const piece = end >= 0 ? rest.slice(0, end) : rest;
      if (piece.trim() && !buffer.trim()) startLine = index + 1;
      buffer += " " + piece;
      if (end < 0) break;
      flush();
      rest = rest.slice(end + 1);
    }
  });
  flush();
}

// ---------------------------------------------------------------------------
// CL

type ClParameter = { keyword?: string; value: string };

export function parseClParameters(text: string): ClParameter[] {
  const parameters: ClParameter[] = [];
  let index = 0;
  const source = String(text || "");
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index++;
    if (index >= source.length) break;
    let token = "";
    let depth = 0;
    let inQuote = false;
    while (index < source.length) {
      const ch = source[index];
      if (inQuote) {
        token += ch;
        if (ch === "'") {
          if (source[index + 1] === "'") { token += "'"; index++; }
          else inQuote = false;
        }
      } else if (ch === "'") {
        inQuote = true;
        token += ch;
      } else if (ch === "(") {
        depth++;
        token += ch;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
        token += ch;
      } else if (/\s/.test(ch) && depth === 0) {
        break;
      } else {
        token += ch;
      }
      index++;
    }
    const keyword = /^([A-Za-z][A-Za-z0-9]*)\(([\s\S]*)\)$/.exec(token);
    if (keyword) parameters.push({ keyword: keyword[1].toUpperCase(), value: keyword[2].trim() });
    else parameters.push({ value: token });
  }
  return parameters;
}

function clParameter(parameters: ClParameter[], keyword: string, position: number) {
  const named = parameters.find(parameter => parameter.keyword === keyword);
  if (named) return named.value;
  const positional = parameters.filter(parameter => !parameter.keyword);
  return positional[position]?.value;
}

function clStatements(lines: string[]) {
  const statements: Array<{ text: string; line: number }> = [];
  let buffer = "";
  let startLine = 0;
  let inComment = false;
  lines.forEach((rawLine, index) => {
    let line = "";
    let inQuote = false;
    for (let position = 0; position < rawLine.length; position++) {
      const ch = rawLine[position];
      if (inComment) {
        if (ch === "*" && rawLine[position + 1] === "/") { inComment = false; position++; }
        continue;
      }
      if (ch === "'") inQuote = !inQuote;
      if (!inQuote && ch === "/" && rawLine[position + 1] === "*") { inComment = true; position++; line += " "; continue; }
      line += ch;
    }
    const trimmed = line.trimEnd();
    if (!trimmed.trim() && !buffer) return;
    if (!buffer) startLine = index + 1;
    if (trimmed.endsWith("+")) {
      buffer += trimmed.slice(0, -1) + " ";
      return;
    }
    if (trimmed.endsWith("-")) {
      buffer += trimmed.slice(0, -1);
      return;
    }
    buffer += trimmed;
    if (buffer.trim()) statements.push({ text: buffer.trim(), line: startLine });
    buffer = "";
  });
  if (buffer.trim()) statements.push({ text: buffer.trim(), line: startLine });
  return statements;
}

function inspectCl(lines: string[], out: Collector) {
  for (const statement of clStatements(lines)) {
    let text = statement.text;
    const label = /^([A-Za-z@#$][A-Za-z0-9_@#$]*)\s*:\s*/.exec(text);
    if (label) {
      out.symbol(label[1].toUpperCase(), "label", statement.line);
      text = text.slice(label[0].length);
    }
    clCommand(text, statement.line, out, 0);
  }
}

function clCommand(text: string, lineNo: number, out: Collector, depth: number) {
  const match = /^([A-Za-z@#$*][A-Za-z0-9_@#$]*\/)?([A-Za-z@#$][A-Za-z0-9_@#$]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!match || depth > 3) return;
  const command = match[2].toUpperCase();
  const parameters = parseClParameters(match[3]);
  const value = (keyword: string, position: number) => clParameter(parameters, keyword, position);
  switch (command) {
    case "PGM":
      out.symbol("PGM", "program-entry", lineNo);
      return;
    case "SUBR": {
      const name = value("SUBR", 0);
      if (name) out.symbol(name.toUpperCase(), "subroutine", lineNo);
      return;
    }
    case "CALL": {
      const program = value("PGM", 0);
      if (program) out.dependency(unquote(program), "program", lineNo, "call", program.startsWith("&"));
      return;
    }
    case "CALLPRC": {
      const procedure = value("PRC", 0);
      if (procedure) out.dependency(unquote(procedure), "procedure", lineNo, "callprc", procedure.startsWith("&"), procedure.startsWith("'"));
      return;
    }
    case "DCLF": {
      const file = value("FILE", 0);
      if (file) out.dependency(file, "file", lineNo, "dclf", file.includes("&"));
      return;
    }
    case "OVRDBF": {
      const target = value("TOFILE", 1);
      if (target && !/^\*FILE$/i.test(target)) out.dependency(target.replace(/\s.*$/, ""), "file", lineNo, "ovrdbf tofile");
      return;
    }
    case "INCLUDE": {
      const member = value("SRCMBR", 0);
      const file = value("SRCFILE", 1);
      if (member) out.dependency(file && !/^\*/.test(file) ? `${file}(${member})` : member, "copy", lineNo, "include");
      return;
    }
    case "RUNSQL": {
      const sql = value("SQL", 0);
      if (sql) sqlStatementDependencies(unquote(sql), lineNo, out, "runsql");
      return;
    }
    case "SBMJOB": {
      const nested = value("CMD", 0);
      if (nested) clCommand(nested, lineNo, out, depth + 1);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// DDS (PF, LF, DSPF, PRTF)

function inspectDds(lines: string[], sourceType: string, out: Collector) {
  const includeFields = sourceType.startsWith("PF") || sourceType.startsWith("LF");
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if ((raw[5] || "A").toUpperCase() !== "A" && raw[5] !== " " && raw[5] !== undefined) return;
    if (raw[6] === "*") return;
    const nameType = (raw[16] || " ").toUpperCase();
    const name = raw.slice(18, 28).trim();
    if (nameType === "R" && name) out.symbol(name.toUpperCase(), "record-format", lineNo);
    else if (nameType === "K" && name) out.symbol(name.toUpperCase(), "key", lineNo);
    else if (nameType === " " && name && includeFields) out.symbol(name.toUpperCase(), "field", lineNo);

    const keywords = raw.slice(44, 80);
    for (const match of keywords.matchAll(/\b(REF|REFFLD|PFILE|JFILE)\s*\(([^)]*)\)/gi)) {
      const keyword = match[1].toUpperCase();
      const operands = match[2].trim().split(/\s+/).filter(Boolean);
      if (keyword === "REF") {
        if (operands[0]) out.dependency(operands[0], "file", lineNo, "ref");
      } else if (keyword === "REFFLD") {
        const file = operands[1];
        if (file && !/^\*SRC$/i.test(file)) out.dependency(file, "file", lineNo, "reffld");
      } else {
        for (const file of operands) out.dependency(file, "file", lineNo, keyword.toLowerCase());
      }
    }
  });
}

// ---------------------------------------------------------------------------
// COBOL, C and unknown source

function inspectCobol(lines: string[], out: Collector) {
  let sqlBuffer: string | undefined;
  let sqlLine = 0;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw[6] === "*" || raw[6] === "/") return;
    const code = raw.slice(7, 72);
    if (typeof sqlBuffer === "string") {
      const end = /\bEND-EXEC\b/i.exec(code);
      sqlBuffer += " " + (end ? code.slice(0, end.index) : code);
      if (end) {
        sqlStatementDependencies(sqlBuffer, sqlLine, out, "exec sql");
        sqlBuffer = undefined;
      }
      return;
    }
    const execSql = /\bEXEC\s+SQL\b/i.exec(code);
    if (execSql) {
      const rest = code.slice(execSql.index + execSql[0].length);
      const end = /\bEND-EXEC\b/i.exec(rest);
      if (end) sqlStatementDependencies(rest.slice(0, end.index), lineNo, out, "exec sql");
      else { sqlBuffer = rest; sqlLine = lineNo; }
      return;
    }
    let match: RegExpExecArray | null;
    if ((match = /\bPROGRAM-ID\.?\s+([A-Za-z0-9_#$@-]+)/i.exec(code))) out.symbol(match[1].toUpperCase(), "program", lineNo);
    else if ((match = /^\s{0,3}([A-Za-z0-9][A-Za-z0-9-]*)\s+SECTION\.\s*$/i.exec(code))) out.symbol(match[1].toUpperCase(), "section", lineNo);
    else if ((match = /^\s{0,3}([A-Za-z0-9][A-Za-z0-9-]*)\.\s*$/.exec(code))) out.symbol(match[1].toUpperCase(), "paragraph", lineNo);
    if ((match = /^\s*COPY\s+("[^"]+"|'[^']+'|[A-Za-z0-9_#$@-]+)/i.exec(code))) out.dependency(match[1].replace(/["]/g, ""), "copy", lineNo, "copy");
    for (const call of code.matchAll(/\bCALL\s+(?:PROCEDURE\s+|LINKAGE\s+\S+\s+)?('[^']+'|"[^"]+"|[A-Za-z0-9_#$@-]+)/gi)) {
      const target = call[1];
      const literal = /^['"]/.test(target);
      out.dependency(target.replace(/["]/g, "'"), "program", lineNo, "call", !literal);
    }
  });
}

function inspectC(lines: string[], out: Collector) {
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const include = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(raw);
    if (include) out.dependency(include[1], "include", lineNo, "#include");
    const execSql = /\bEXEC\s+SQL\b([^;]*)/i.exec(raw);
    if (execSql) sqlStatementDependencies(execSql[1], lineNo, out, "exec sql");
  });
}

function inspectUnknown(lines: string[], out: Collector) {
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const directive = /^\s*\/(COPY|INCLUDE)\s+([^\s]+)/i.exec(raw.length > 6 && raw[6] === "/" ? raw.slice(6) : raw);
    if (directive) out.dependency(directive[2], "copy", lineNo, `/${directive[1].toUpperCase()}`);
    const include = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(raw);
    if (include) out.dependency(include[1], "include", lineNo, "#include");
    const procedure = new RegExp(`\\bdcl-proc\\s+(${NAME})`, "i").exec(raw);
    if (procedure) out.symbol(procedure[1], "procedure", lineNo);
    const subroutine = new RegExp(`\\bbegsr\\s+(${NAME})`, "i").exec(raw);
    if (subroutine) out.symbol(subroutine[1], "subroutine", lineNo);
  });
}
