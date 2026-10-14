/**
 * Small lexical SQL analyser for the text sent to QZDFMDB2.
 *
 * It does not parse SQL grammar. It splits the text into segments (code,
 * string literals, delimited identifiers, comments and `@` CL lines) so that
 * callers can split statements, find embedded CL commands and decide whether
 * a request is read-only without being fooled by quotes or comments.
 */

export type SqlSegmentKind =
  | "code"
  | "string"   // '...'
  | "qident"   // "..."
  | "block"    // /* ... */
  | "line"     // -- ... (up to, not including, the newline)
  | "cl";      // a line starting with @ (run through QCMDEXC by Tools.fixSQL)

export interface SqlSegment {
  kind: SqlSegmentKind;
  start: number;
  end: number;
  /** Raw text of the segment. */
  text: string;
  /** For string/qident: the unescaped value. For cl: the CL command text. */
  value?: string;
  /** For string/qident/block: true when the closing delimiter is missing. */
  unterminated?: boolean;
}

export type SqlTokenType = "word" | "number" | "string" | "qident" | "punct" | "cl";

export interface SqlToken {
  type: SqlTokenType;
  /** Upper-cased for words; unescaped value for string/qident; raw char for punct. */
  value: string;
  start: number;
  end: number;
}

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
  tokens: SqlToken[];
}

export interface EmbeddedClCommand {
  source: "at-line" | "qcmdexc";
  /** The CL command text, or null when it is not a plain string literal (built at run time). */
  command: string | null;
  /** Offset of the `@` or of the QCMDEXC name in the original SQL. */
  offset: number;
}

export interface ReadOnlyCheck {
  readOnly: boolean;
  reason?: string;
}

const READ_ONLY_FIRST_KEYWORDS = new Set(["SELECT", "WITH", "VALUES"]);
const DATA_CHANGE_TABLE_KEYWORDS = new Set(["FINAL", "NEW", "OLD"]);
const DATA_CHANGE_STATEMENTS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * Splits SQL text into lexical segments. A line whose first character is `@`
 * while the lexer is not inside a literal or block comment is a CL line; this
 * matches what Tools.fixSQL converts into a QCMDEXC call.
 */
export function lexSqlSegments(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = [];
  const n = sql.length;
  let i = 0;
  let codeStart = 0;

  const flushCode = (end: number) => {
    if (end > codeStart) {
      segments.push({ kind: "code", start: codeStart, end, text: sql.slice(codeStart, end) });
    }
  };

  while (i < n) {
    const ch = sql[i];
    const atLineStart = i === 0 || sql[i - 1] === "\n";

    if (atLineStart && ch === "@") {
      flushCode(i);
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      const text = sql.slice(i, end);
      let command = text.slice(1).replace(/\r$/, "");
      if (command.endsWith(";")) command = command.slice(0, -1);
      segments.push({ kind: "cl", start: i, end, text, value: command });
      i = end;
      codeStart = i;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      flushCode(i);
      const quote = ch;
      let j = i + 1;
      let value = "";
      let terminated = false;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          terminated = true;
          j++;
          break;
        }
        value += sql[j];
        j++;
      }
      segments.push({
        kind: quote === "'" ? "string" : "qident",
        start: i,
        end: j,
        text: sql.slice(i, j),
        value,
        ...(terminated ? {} : { unterminated: true })
      });
      i = j;
      codeStart = i;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      flushCode(i);
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      segments.push({ kind: "line", start: i, end, text: sql.slice(i, end) });
      i = end;
      codeStart = i;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      flushCode(i);
      // Block comments are treated as non-nested: the comment ends at the first */.
      // If Db2 nests them it sees more text as comment, never less.
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      segments.push({
        kind: "block",
        start: i,
        end,
        text: sql.slice(i, end),
        ...(close === -1 ? { unterminated: true } : {})
      });
      i = end;
      codeStart = i;
      continue;
    }

    i++;
  }
  flushCode(n);
  return segments;
}

/** Converts segments into significant tokens (comments dropped). */
export function tokenizeSql(sql: string): SqlToken[] {
  return segmentsToTokens(lexSqlSegments(sql));
}

function segmentsToTokens(segments: SqlSegment[]): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const seg of segments) {
    switch (seg.kind) {
      case "string":
      case "qident":
        tokens.push({ type: seg.kind, value: seg.value ?? "", start: seg.start, end: seg.end });
        break;
      case "cl":
        tokens.push({ type: "cl", value: seg.value ?? "", start: seg.start, end: seg.end });
        break;
      case "code": {
        const re = /([A-Za-z_#$@][A-Za-z0-9_#$@]*)|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|(\S)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(seg.text))) {
          const start = seg.start + m.index;
          const end = start + m[0].length;
          if (m[1]) tokens.push({ type: "word", value: m[1].toUpperCase(), start, end });
          else if (m[2]) tokens.push({ type: "number", value: m[2], start, end });
          else tokens.push({ type: "punct", value: m[3], start, end });
        }
        break;
      }
      default:
        break;
    }
  }
  return tokens;
}

/**
 * Splits SQL into statements on `;`, ignoring semicolons inside literals,
 * delimited identifiers and comments. Each `@` CL line is its own statement.
 * Statements with no significant tokens are dropped.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const tokens = tokenizeSql(sql);
  const statements: SqlStatement[] = [];
  let current: SqlToken[] = [];

  const flush = () => {
    if (current.length > 0) {
      const start = current[0].start;
      const end = current[current.length - 1].end;
      statements.push({ text: sql.slice(start, end), start, end, tokens: current });
    }
    current = [];
  };

  for (const token of tokens) {
    if (token.type === "cl") {
      flush();
      current.push(token);
      flush();
      continue;
    }
    if (token.type === "punct" && token.value === ";") {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return statements;
}

/**
 * The statement type of the first statement: its first keyword, upper-cased
 * ("SELECT", "INSERT", ...), "CL" for an `@` line, or "UNKNOWN".
 */
export function getSqlStatementType(sql: string): string {
  const first = splitSqlStatements(sql)[0];
  if (!first) return "UNKNOWN";
  const token = first.tokens.find(t => !(t.type === "punct" && t.value === "("));
  if (!token) return "UNKNOWN";
  if (token.type === "cl") return "CL";
  if (token.type === "word") return token.value;
  return "UNKNOWN";
}

/**
 * Lists the CL commands embedded in SQL text: `@` lines (which Tools.fixSQL
 * turns into QCMDEXC calls) and calls to QCMDEXC (procedure or scalar
 * function, qualified or not). For QCMDEXC the first argument is returned when
 * it is a single string literal; otherwise `command` is null because the
 * command is built at run time and cannot be checked statically.
 */
export function extractEmbeddedClCommands(sql: string): EmbeddedClCommand[] {
  const tokens = tokenizeSql(sql);
  const result: EmbeddedClCommand[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "cl") {
      result.push({ source: "at-line", command: token.value, offset: token.start });
      continue;
    }
    if (!isQcmdexcName(token)) continue;
    const open = tokens[i + 1];
    const arg = tokens[i + 2];
    const after = tokens[i + 3];
    let command: string | null = null;
    if (open?.type === "punct" && open.value === "(" &&
      arg?.type === "string" &&
      after?.type === "punct" && (after.value === "," || after.value === ")")) {
      command = arg.value;
    }
    result.push({ source: "qcmdexc", command, offset: token.start });
  }
  return result;
}

function isQcmdexcName(token: SqlToken) {
  return (token.type === "word" || token.type === "qident") && token.value.toUpperCase() === "QCMDEXC";
}

/**
 * Decides whether SQL may run through the read-only `ibmi.sql.query` tool.
 *
 * Allowed: exactly one SELECT, WITH or VALUES statement (optionally wrapped
 * in parentheses, optionally ending with one `;`). Rejected:
 * - more than one statement;
 * - any line starting with `@` (a CL command);
 * - any reference to QCMDEXC;
 * - data-change table references such as FINAL TABLE (INSERT ...);
 * - unterminated literals or comments;
 * - a `;` inside a literal or comment, because QZDFMDB2 (-t) splits
 *   statements itself and is not known to respect quotes.
 */
export function checkReadOnlySql(sql: string): ReadOnlyCheck {
  if (/^\s*@/m.test(sql)) {
    return { readOnly: false, reason: "lines starting with @ run CL commands" };
  }

  const segments = lexSqlSegments(sql);
  for (const seg of segments) {
    if (seg.kind === "cl") {
      return { readOnly: false, reason: "lines starting with @ run CL commands" };
    }
    if (seg.unterminated) {
      return { readOnly: false, reason: "unterminated string, identifier or comment" };
    }
    if (seg.kind !== "code" && seg.text.includes(";")) {
      return { readOnly: false, reason: "a semicolon inside a string, identifier or comment is not allowed in read-only SQL" };
    }
  }

  const tokens = segmentsToTokens(segments);
  const significant = tokens.filter(t => !(t.type === "punct" && t.value === ";"));
  if (significant.length === 0) {
    return { readOnly: false, reason: "no SQL statement" };
  }

  // Only one statement: every ';' must come after the last significant token.
  const lastSignificant = significant[significant.length - 1];
  const semicolons = tokens.filter(t => t.type === "punct" && t.value === ";");
  if (semicolons.some(t => t.start < lastSignificant.start)) {
    return { readOnly: false, reason: "multiple statements are not allowed" };
  }
  if (semicolons.length > 1) {
    return { readOnly: false, reason: "multiple statements are not allowed" };
  }

  const first = significant.find(t => !(t.type === "punct" && t.value === "("));
  if (!first || first.type !== "word" || !READ_ONLY_FIRST_KEYWORDS.has(first.value)) {
    return { readOnly: false, reason: "only SELECT, WITH and VALUES statements are read-only" };
  }

  for (let i = 0; i < significant.length; i++) {
    const t = significant[i];
    if (isQcmdexcName(t)) {
      return { readOnly: false, reason: "QCMDEXC runs CL commands" };
    }
    if (t.type === "word" && DATA_CHANGE_TABLE_KEYWORDS.has(t.value)) {
      const next = significant[i + 1];
      const open = significant[i + 2];
      const stmt = significant[i + 3];
      if (next?.type === "word" && next.value === "TABLE" &&
        open?.type === "punct" && open.value === "(" &&
        stmt?.type === "word" && DATA_CHANGE_STATEMENTS.has(stmt.value)) {
        return { readOnly: false, reason: `${t.value} TABLE (${stmt.value} ...) changes data` };
      }
    }
  }

  return { readOnly: true };
}

export function isReadOnlySql(sql: string): boolean {
  return checkReadOnlySql(sql).readOnly;
}

/**
 * Rewrites SQL for QZDFMDB2: `@` lines become QCMDEXC calls and, when
 * removeComments is set, `--` comments are removed. Literals, delimited
 * identifiers and block comments are left untouched, so `--` inside a string
 * is kept.
 */
export function rewriteSqlForQzdfmdb2(sql: string, removeComments = false): string {
  let out = "";
  for (const seg of lexSqlSegments(sql)) {
    switch (seg.kind) {
      case "cl":
        out += `Call QSYS2.QCMDEXC('${(seg.value ?? "").replaceAll("'", "''")}');`;
        break;
      case "line":
        out += removeComments ? "" : `\n${seg.text}`;
        break;
      default:
        out += seg.text;
    }
  }
  return out;
}
