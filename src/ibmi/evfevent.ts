/**
 * Parser for IBM i compiler events files (EVFEVENT), written by compilers
 * when OPTION(*EVENTF) is used.
 *
 * Each record starts with a record type padded to 10 characters, followed by
 * blank separated fixed-width fields:
 *
 *   TIMESTAMP  rev yyyymmddhhmmss
 *   PROCESSOR  rev fileid(000) outputFileId
 *   FILEID     rev fileid(3) includedAtLine(6) nameLength(3) name timestamp(14) tempFlag(1)
 *   FILEEND    rev fileid(3) lineCount(6)
 *   EXPANSION  rev fileid(3) inStart(6) inEnd(6) outStart(6) outEnd(6)
 *   ERROR      rev fileid(3) annotClass(1) stmtLine(6) startLine(6) startCol(3+)
 *              endLine(6) endCol(3+) msgid(7) sevChar(1) sev(2) msgLength(3) text
 *
 * A new PROCESSOR record starts a new pass (for example the RPG compiler run
 * after the SQL precompiler) and file ids restart in each pass. Errors that a
 * later pass reports against a temporary file (temp flag 1, such as
 * QTEMP/QSQLTEMP1) are mapped back to the original source through the
 * EXPANSION records of the previous pass.
 */

export type EvfSeverity = "INFO" | "WARN" | "ERROR";

export interface EvfDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  statementLine: number;
  msgid: string;
  severity: EvfSeverity;
  severityChar: string;
  severityLevel: number;
  text: string;
  processor: number;
  /** Set when the error was reported against a temporary file and mapped back. */
  mappedFrom?: { file: string; line: number };
}

export interface EvfFileErrors {
  file: string;
  library?: string;
  sourceFile?: string;
  member?: string;
  path?: string;
  errors: EvfDiagnostic[];
  counts: { errors: number; warnings: number; infos: number };
}

export interface EvfParseResult {
  timestamp?: string;
  processors: number;
  files: EvfFileErrors[];
  diagnostics: EvfDiagnostic[];
  summary: { total: number; errors: number; warnings: number; infos: number; highestSeverity: number };
  unparsedLines: number;
}

interface EvfFile {
  id: string;
  name: string;
  includedAtLine: number;
  temp: boolean;
  lineCount?: number;
}

interface EvfExpansion {
  fileId: string;
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
}

interface EvfProcessor {
  index: number;
  files: Map<string, EvfFile>;
  firstFileId?: string;
  expansions: EvfExpansion[];
}

const ERROR_RE = /^ERROR\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z])\s+(\d+)\s+(\d+)(?:\s(.*))?$/;
const FILEID_RE = /^FILEID\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;
const FILEEND_RE = /^FILEEND\s+(\d+)\s+(\d+)(?:\s+(\d+))?/;
const EXPANSION_RE = /^EXPANSION\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;
const TIMESTAMP_RE = /^TIMESTAMP\s+(\d+)\s+(\d+)/;
const PROCESSOR_RE = /^PROCESSOR\b/;
const KNOWN_RECORD_RE = /^(MAPDEFINE|MAPSTART|MAPEND|FEEDBACK|PROGRAM)\b/;

export function severityFrom(char: string, level: number): EvfSeverity {
  switch (char.toUpperCase()) {
    case "I": return "INFO";
    case "W": return "WARN";
    case "E":
    case "S":
    case "T":
    case "U":
    case "C": return "ERROR";
  }
  if (level < 10) return "INFO";
  if (level < 20) return "WARN";
  return "ERROR";
}

/** Split a FILEID name into library/file/member or an IFS path. */
export function describeEvfFile(name: string): Pick<EvfFileErrors, "library" | "sourceFile" | "member" | "path"> {
  const qsys = name.match(/^([^/()\s]+)\/([^/()\s]+)\(([^()\s]+)\)$/);
  if (qsys) return { library: qsys[1].toUpperCase(), sourceFile: qsys[2].toUpperCase(), member: qsys[3].toUpperCase() };
  const qsysPath = name.match(/^\/QSYS\.LIB\/([^/]+)\.LIB\/([^/]+)\.FILE\/([^/]+)\.MBR$/i);
  if (qsysPath) return { library: qsysPath[1].toUpperCase(), sourceFile: qsysPath[2].toUpperCase(), member: qsysPath[3].toUpperCase() };
  if (name.startsWith("/")) return { path: name };
  return {};
}

export function parseEvfevent(content: string | string[]): EvfParseResult {
  const lines = Array.isArray(content) ? content : String(content ?? "").split(/\r?\n/);
  const processors: EvfProcessor[] = [];
  let current: EvfProcessor | undefined;
  let timestamp: string | undefined;
  let unparsedLines = 0;
  const raw: Array<{ processor: EvfProcessor; fileId: string; diag: Omit<EvfDiagnostic, "file"> }> = [];

  const ensureProcessor = () => {
    if (!current) {
      current = { index: processors.length + 1, files: new Map(), expansions: [] };
      processors.push(current);
    }
    return current;
  };

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").replace(/\s+$/, "");
    if (!line.trim()) continue;
    const record = line.trimStart();

    if (PROCESSOR_RE.test(record)) {
      current = { index: processors.length + 1, files: new Map(), expansions: [] };
      processors.push(current);
      continue;
    }

    let match = record.match(TIMESTAMP_RE);
    if (match) {
      timestamp = timestamp || match[2];
      continue;
    }

    match = record.match(FILEID_RE);
    if (match) {
      const proc = ensureProcessor();
      const id = match[2];
      const nameLength = Number(match[4]);
      const rest = match[5];
      let name: string;
      let temp = false;
      const tail = rest.match(/^(.*?)\s+(\d{14})\s+([01])\s*$/);
      if (tail) {
        name = tail[1].trim();
        temp = tail[3] === "1";
      } else {
        name = (nameLength > 0 ? rest.slice(0, nameLength) : rest).trim();
        const flag = rest.slice(nameLength).trim().split(/\s+/).pop();
        temp = flag === "1";
      }
      if (!proc.files.has(id)) {
        proc.files.set(id, { id, name, includedAtLine: Number(match[3]), temp });
        if (!proc.firstFileId) proc.firstFileId = id;
      }
      continue;
    }

    match = record.match(FILEEND_RE);
    if (match) {
      const file = current?.files.get(match[2]);
      if (file && match[3] !== undefined) file.lineCount = Number(match[3]);
      continue;
    }

    match = record.match(EXPANSION_RE);
    if (match) {
      ensureProcessor().expansions.push({
        fileId: match[2],
        inStart: Number(match[3]),
        inEnd: Number(match[4]),
        outStart: Number(match[5]),
        outEnd: Number(match[6])
      });
      continue;
    }

    match = record.match(ERROR_RE);
    if (match) {
      const proc = ensureProcessor();
      const statementLine = Number(match[4]);
      const startLine = Number(match[5]) || statementLine;
      const endLine = Number(match[7]) || startLine;
      const severityChar = match[10].toUpperCase();
      const severityLevel = Number(match[11]);
      const msgLength = Number(match[12]);
      const restText = match[13] ?? "";
      const text = (msgLength > 0 && restText.length > msgLength ? restText.slice(0, msgLength) : restText).trim();
      raw.push({
        processor: proc,
        fileId: match[2],
        diag: {
          line: startLine,
          column: Number(match[6]),
          endLine,
          endColumn: Number(match[8]),
          statementLine,
          msgid: match[9].toUpperCase(),
          severity: severityFrom(severityChar, severityLevel),
          severityChar,
          severityLevel,
          text,
          processor: proc.index
        }
      });
      continue;
    }

    if (!KNOWN_RECORD_RE.test(record)) unparsedLines++;
  }

  const diagnostics: EvfDiagnostic[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const diag = resolveDiagnostic(entry.processor, processors, entry.fileId, entry.diag);
    const key = [diag.file, diag.line, diag.column, diag.msgid, diag.text].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(diag);
  }

  const byFile = new Map<string, EvfFileErrors>();
  for (const diag of diagnostics) {
    let group = byFile.get(diag.file);
    if (!group) {
      group = { file: diag.file, ...describeEvfFile(diag.file), errors: [], counts: { errors: 0, warnings: 0, infos: 0 } };
      byFile.set(diag.file, group);
    }
    group.errors.push(diag);
    if (diag.severity === "ERROR") group.counts.errors++;
    else if (diag.severity === "WARN") group.counts.warnings++;
    else group.counts.infos++;
  }
  const files = Array.from(byFile.values());
  for (const group of files) {
    group.errors.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  return {
    timestamp,
    processors: processors.length,
    files,
    diagnostics,
    summary: {
      total: diagnostics.length,
      errors: diagnostics.filter(d => d.severity === "ERROR").length,
      warnings: diagnostics.filter(d => d.severity === "WARN").length,
      infos: diagnostics.filter(d => d.severity === "INFO").length,
      highestSeverity: diagnostics.reduce((max, d) => Math.max(max, d.severityLevel), 0)
    },
    unparsedLines
  };
}

function resolveDiagnostic(
  proc: EvfProcessor,
  processors: EvfProcessor[],
  fileId: string,
  diag: Omit<EvfDiagnostic, "file">
): EvfDiagnostic {
  const file = proc.files.get(fileId);
  const name = file?.name || `FILEID ${fileId}`;
  if (!file?.temp) return { ...diag, file: name };

  // Errors against a temporary (expanded) file: map through the expansions
  // recorded by the pass that produced it.
  const previous = processors
    .slice(0, processors.indexOf(proc))
    .reverse()
    .find(p => p.expansions.length > 0 || p.files.size > 0);
  if (!previous?.firstFileId) return { ...diag, file: name };

  const mapLine = (line: number) => mapExpandedLine(previous, line);
  const start = mapLine(diag.line);
  const end = mapLine(diag.endLine);
  const statement = mapLine(diag.statementLine || diag.line);
  return {
    ...diag,
    file: start.file,
    line: start.line,
    endLine: end.file === start.file ? Math.max(end.line, start.line) : start.line,
    statementLine: statement.file === start.file ? statement.line : start.line,
    mappedFrom: { file: name, line: diag.line }
  };
}

/** Map a line of a pass's output back to the original file and line. */
function mapExpandedLine(proc: EvfProcessor, outputLine: number): { file: string; line: number } {
  const mainId = proc.firstFileId!;
  const nameOf = (id: string) => proc.files.get(id)?.name || `FILEID ${id}`;
  let offset = 0;
  const expansions = [...proc.expansions].sort((a, b) => a.outStart - b.outStart);
  for (const exp of expansions) {
    if (exp.outEnd < exp.outStart) continue;
    if (outputLine >= exp.outStart && outputLine <= exp.outEnd) {
      if (exp.fileId !== mainId && exp.inStart > 0) {
        // Included source copied line for line.
        return { file: nameOf(exp.fileId), line: exp.inStart + (outputLine - exp.outStart) };
      }
      // Generated code: point at the statement it came from.
      return { file: nameOf(exp.fileId), line: exp.inStart > 0 ? exp.inStart : Math.max(1, outputLine - offset) };
    }
    if (exp.outEnd < outputLine) {
      const outputLength = exp.outEnd - exp.outStart + 1;
      const replaced = exp.fileId === mainId && exp.inStart > 0 && exp.inEnd >= exp.inStart ? exp.inEnd - exp.inStart + 1 : 0;
      offset += outputLength - replaced;
    }
  }
  return { file: nameOf(mainId), line: Math.max(1, outputLine - offset) };
}
