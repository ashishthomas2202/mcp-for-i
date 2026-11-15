import type { BoundedSqlResult } from "./sqlJob.js";
import { normalizeRow, toSqlError } from "./sqlJob.js";
import { Tools } from "./Tools.js";

class SqlCompletionError extends Error {}

/** Fetch a result using Mapepire's explicit continuation protocol. */
export async function runBoundedMapepireQuery(
  job: any,
  sql: string,
  options: { rowLimit: number; signal?: AbortSignal },
): Promise<BoundedSqlResult> {
  const { rowLimit, signal } = options;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 20001) {
    throw new SqlCompletionError("Invalid bounded SQL row limit");
  }
  if (signal?.aborted) throw new SqlCompletionError("SQL statement cancelled");
  const query = job.query(sql, {});
  const rows: BoundedSqlResult["rows"] = [];
  let columns: any[] | undefined;
  let initial = true;
  let failed = false;
  try {
    while (true) {
      if (signal?.aborted) throw new SqlCompletionError("SQL statement cancelled");
      const requested = Math.min(1000, rowLimit - rows.length);
      // Keep the transport work pending until the actual server response. The
      // caller's timer responds promptly; PersistentSqlJob owns cancellation
      // escalation while this promise remains pending. Closing before execute
      // settles is a local SDK no-op because no cursor ID is known yet.
      const response = await (initial
        ? query.execute(requested)
        : query.fetchMore(requested));
      if (signal?.aborted) throw new SqlCompletionError("SQL statement cancelled");
      // sqlmore responses need not repeat has_results. is_done is the
      // continuation contract on every page, including empty terminal pages.
      const state = String(response?.sql_state ?? "00000");
      if (response?.success !== true || response?.error ||
          !/^(00000|02000)$/.test(state) ||
          (typeof response.sql_rc === "number" && response.sql_rc < 0)) {
        const said = [response?.error, state !== "00000" ? "SQLSTATE " + state : ""]
          .filter(Boolean).join(", ");
        throw new SqlCompletionError("SQL transport reported a failure or warning" +
          (said ? " (" + said + ")" : "") + "; no rows returned");
      }
      if ((initial && response.has_results !== true) ||
          (!initial && response.has_results === false) ||
          typeof response.is_done !== "boolean" ||
          !Array.isArray(response.data) || response.data.length > requested) {
        throw new SqlCompletionError("SQL transport cannot prove result completeness: invalid page metadata");
      }
      if (initial) {
        const metadata = response.metadata?.columns;
        if (metadata !== undefined && !Array.isArray(metadata)) {
          throw new SqlCompletionError("SQL transport returned invalid column metadata");
        }
        columns = metadata?.map((column: any) => ({
          name: column.name || column.label,
          type: column.type,
        }));
      }
      rows.push(...response.data.map((row: any) => normalizeRow(row, columns)));
      if (response.is_done || rows.length === rowLimit) {
        return {
          rows,
          exhausted: response.is_done,
          knownRemaining: !response.is_done,
          effectiveLimit: rowLimit,
          transport: "mapepire",
          completenessProof: {
            transport: "mapepire", method: "continuation-protocol",
            reportedRowCount: rows.length, parsedRowCount: rows.length,
            exitValidated: false, footerValidated: false,
          },
        };
      }
      if (response.data.length === 0) {
        throw new SqlCompletionError("SQL transport cannot prove result completeness: empty continuation");
      }
      initial = false;
    }
  } catch (error) {
    failed = true;
    if (error instanceof SqlCompletionError) throw error;
    // What the database said about the statement (a wrong name, bad syntax)
    // goes back in its own words, as a Tools.SqlError: the statement failed,
    // the job did not, and the message is how the caller fixes the SQL.
    const sqlError = toSqlError(error, sql);
    if (sqlError instanceof Tools.SqlError) throw sqlError;
    const cause = String((error as any)?.message || error || "").trim();
    throw new SqlCompletionError("SQL transport failed before result completeness was proven" +
      (cause ? ": " + cause : ""));
  } finally {
    // Cleanup failures must not turn a failed query into a successful response.
    try {
      const response = await query.close();
      // The SDK returns raw sqlclose responses, including resolved failures.
      // Completed queries may close locally and return undefined.
      if (response !== undefined && response?.success !== true) {
        throw new SqlCompletionError("SQL cursor cleanup failed; no rows returned");
      }
    } catch {
      if (!failed) throw new SqlCompletionError("SQL cursor cleanup failed; no rows returned");
    }
  }
}
