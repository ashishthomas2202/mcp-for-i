import { Tools } from "./Tools.js";
import { splitSqlStatements, isReadOnlySql } from "./sqlParse.js";
import type { BoundedSqlResult, SqlCompletenessProof } from "./sqlJob.js";
import type { CommandResult } from "./types.js";

/**
 * Bounds a read-only statement for QZDFMDB2, whose whole result arrives as
 * text: FETCH FIRST n ROWS ONLY is added at the end of the statement, before a
 * trailing isolation or read-only clause. The statement is never wrapped in a
 * derived table: Db2 for i rejects a common table expression (WITH ...), WITH
 * NC and FOR READ ONLY inside one. A statement that ends in its own row limit,
 * or in a clause FETCH FIRST cannot follow, is left as it is: the closing row
 * count still proves what arrived, and the caller drops rows past the limit.
 */
export function boundQzdfmdb2Sql(sql: string, rowLimit: number): string {
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 20001 || !isReadOnlySql(sql)) {
    throw new Error("Cannot establish a safe QZDFMDB2 result bound");
  }
  const statement = splitSqlStatements(sql)[0];
  const tokens = statement.tokens;
  const word = (i: number) => (i >= 0 && tokens[i]?.type === "word" ? tokens[i].value : "");
  // Clauses that may follow FETCH FIRST, in any order: WITH UR|CS|RS|RR|NC and FOR READ|FETCH ONLY.
  let end = tokens.length;
  for (;;) {
    if (word(end - 2) === "WITH" && /^(UR|CS|RS|RR|NC)$/.test(word(end - 1))) end -= 2;
    else if (word(end - 3) === "FOR" && /^(READ|FETCH)$/.test(word(end - 2)) && word(end - 1) === "ONLY") end -= 3;
    else break;
  }
  const whole = sql.slice(statement.start, statement.end);
  if (end <= 0) return whole;
  const ownClause =
    // FETCH FIRST n ROWS ONLY, FETCH NEXT ROW ONLY
    (word(end - 1) === "ONLY" && /^ROWS?$/.test(word(end - 2))) ||
    // LIMIT n, LIMIT n OFFSET m, LIMIT m, n
    word(end - 2) === "LIMIT" || word(end - 4) === "LIMIT" ||
    // OPTIMIZE FOR n ROWS
    (word(end - 4) === "OPTIMIZE" && word(end - 3) === "FOR" && /^ROWS?$/.test(word(end - 1))) ||
    // KEEP UPDATE|EXCLUSIVE|SHARE LOCKS, SKIP LOCKED DATA, USE CURRENTLY COMMITTED, WAIT FOR OUTCOME
    (word(end - 3) === "KEEP" && word(end - 1) === "LOCKS") ||
    (word(end - 3) === "SKIP" && word(end - 2) === "LOCKED" && word(end - 1) === "DATA") ||
    (word(end - 2) === "CURRENTLY" && word(end - 1) === "COMMITTED") ||
    (word(end - 2) === "FOR" && word(end - 1) === "OUTCOME") ||
    // FOR UPDATE [OF ...]
    tokens.some((_token, i) => word(i) === "FOR" && word(i + 1) === "UPDATE");
  if (ownClause) return whole;
  const at = tokens[end - 1].end;
  return `${sql.slice(statement.start, at)}\nFETCH FIRST ${rowLimit} ROWS ONLY${sql.slice(at, statement.end)}`;
}

export function qzdfmdb2HasResult(sql: string): boolean {
  return splitSqlStatements(sql).some((statement) => isReadOnlySql(statement.text));
}

/** The error or warning block QZDFMDB2 prints for a statement the database rejected. */
function cliDiagnostic(stdout: string): { state?: string; message?: string } | undefined {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*\*+\s*CLI\s+(?:ERROR|WARNING)\b/i.test(line));
  if (at < 0) return undefined;
  const state = lines[at + 1]?.match(/SQLSTATE\s*:\s*([0-9A-Z]{5})/i)?.[1]?.toUpperCase();
  // The text follows the NATIVE ERROR CODE line and runs to the next empty line.
  const text: string[] = [];
  for (let i = at + 3; i < lines.length && lines[i].trim() && !/^(?:DB2>|\?>)$/.test(lines[i].trim()); i++) {
    text.push(lines[i].trim());
  }
  return { state, message: text.join(" ") || undefined };
}

export function parseQzdfmdb2Result(output: CommandResult, requireResult: boolean): {
  rows: Tools.DB2Row[];
  proof?: SqlCompletenessProof;
} {
  const fail = (reason: string): never => {
    throw new Error(`QZDFMDB2 result completeness failed: ${reason}`);
  };
  if (output.code !== 0 || output.signal !== null) fail("command exit was not clean");
  // What the database said about the statement (a wrong name, bad syntax) goes
  // back in its own words, with its SQLSTATE: it is how the caller fixes the SQL.
  const diagnostic = cliDiagnostic(output.stdout);
  if (diagnostic) {
    const { state, message } = diagnostic;
    if (!state) fail(`SQL diagnostic received${message ? `: ${message}` : ""}`);
    if (state!.startsWith("01")) fail(`SQL warning ${state}${message ? `: ${message}` : ""}`);
    const sqlError = new Tools.SqlError(`${message || "SQL statement failed"} (${state})`);
    sqlError.sqlstate = state!;
    throw sqlError;
  }
  if (/SQL\d{4}[A-Z]?\b|CLI\s+(?:ERROR|WARNING)|\bSQL(?:CODE|STATE)\b/i.test(output.stderr)) {
    // No error block, but the job said something about the SQL (a data mapping
    // error still prints a row, with a wrong value in it).
    const said = output.stderr.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " "))
      .filter((line) => line && !line.includes("Object is EN_US.UTF-8"));
    const sqlLines = said.filter((line) => /^SQL\d{4}[A-Z]?\b/i.test(line));
    const printed = /^\s*\d+\s+RECORD\(S\)\s+SELECTED\.\s*$/im.test(output.stdout);
    throw new Tools.SqlError((sqlLines.length ? sqlLines : said).join(" ") +
      (printed ? " The result may be wrong, so no rows are returned." : ""));
  }
  if (/COMMAND .+ COMPLETED WITH EXIT STATUS (?!0(?:\D|$))\d+/.test(output.stdout)) {
    fail("command wrapper reported failure");
  }
  const lines = output.stdout.split(/\r?\n/);
  const footers = lines.flatMap((line, index) => {
    // QZDFMDB2 control footers have no trailing column padding and follow an
    // empty physical line. CHAR data (including blank data) retains padding.
    const match = line.match(/^\s*(\d+)\s+RECORD\(S\)\s+SELECTED\.$/i);
    if (index === 0 || lines[index - 1] !== "") return [];
    return match ? [{ count: Number(match[1]), index }] : [];
  });
  if (!requireResult) {
    if (footers.length) fail("unexpected result footer");
    return { rows: [] };
  }
  if (footers.length !== 1) fail("missing or ambiguous selected-row footer");
  const footer = footers[0];
  const allowed = (line: string) => !line.trim() || /^(?:DB2>|\?>|DB20000I\b.*|COMMAND .+ COMPLETED WITH EXIT STATUS 0\.?)$/.test(line.trim());
  if (lines.slice(footer.index + 1).some((line) => !allowed(line))) fail("content followed the selected-row footer");
  const rows = Tools.db2Parse(lines.slice(0, footer.index).join("\n"), undefined, { resultBody: true });
  const meaningful = lines.slice(0, footer.index).filter((line) => !allowed(line));
  if (meaningful.length < 2 || !/^\s*-+(?:\s+-+)*\s*$/.test(meaningful[1])) {
    fail("missing table header or separator");
  }
  if (!Number.isSafeInteger(footer.count) || footer.count !== rows.length) {
    fail(`selected-row count does not match parsed rows (${footer.count} reported, ${rows.length} read). ` +
      "A value may contain a line break, which this transport cannot carry: remove it in the query " +
      "(REPLACE), or use the Mapepire SQL transport");
  }
  return { rows, proof: {
    transport: "qzdfmdb2", method: "selected-row-footer",
    reportedRowCount: footer.count, parsedRowCount: rows.length,
    exitValidated: true, footerValidated: true,
  } };
}

export function boundedQzdfmdb2Result(output: CommandResult, rowLimit: number): BoundedSqlResult {
  const result = parseQzdfmdb2Result(output, true);
  // A statement that kept its own row limit can return more than was asked
  // for. The closing count proves the rest exists, so it is reported as such.
  const over = result.rows.length > rowLimit;
  return { rows: over ? result.rows.slice(0, rowLimit) : result.rows, exhausted: !over, knownRemaining: over,
    effectiveLimit: rowLimit, transport: "qzdfmdb2", completenessProof: result.proof! };
}
